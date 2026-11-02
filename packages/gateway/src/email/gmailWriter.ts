import { randomUUID } from 'node:crypto';
import { err, ok } from '@codex-lens/shared';
import { z } from 'zod';
import type { openGmailAccount } from './gmailAccount.js';
import type { GmailIdentity } from './gmailIdentity.js';
import type { createGmailIntentStore } from './gmailIntentStore.js';
import { composeGmailSnapshot } from './gmailCompose.js';
import { createGmailClient } from './gmailClient.js';

const Request = z.object({ requestKey: z.uuid(), operation: z.enum(['draft', 'send']),
  message: z.object({ to: z.array(z.string()).max(20), cc: z.array(z.string()).max(20).default([]),
    bcc: z.array(z.string()).max(20).default([]), subject: z.string().max(500), body: z.string().max(100000) }).strict() }).strict();
export const GmailWriteRequestSchema = Request;
type Snapshot = Extract<ReturnType<typeof composeGmailSnapshot>, { ok: true }>['value'];
export type GmailWritePreview = { id: string; digest: string; operation: 'draft' | 'send'; expiresAt: number; content: Snapshot['content'] };

/** Trusted orchestration. The host supplies an authorizer
 * that verifies wearer approval bound to this exact preview and operation.
 * Raw bytes never leave this service except for the one provider write.
 */
export function createGmailWriter(options: {
  account: Pick<Awaited<ReturnType<typeof openGmailAccount>>, 'accessToken' | 'revision' | 'authorizedScopes'>;
  identity: GmailIdentity;
  store: ReturnType<typeof createGmailIntentStore>;
  authorize: (approval: unknown, preview: GmailWritePreview) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const prepared = new Map<string, { preview: GmailWritePreview; raw: string; revision: number; binding: string }>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;
  function forget(id: string) {
    prepared.delete(id);
    const timer = expiryTimers.get(id);
    if (timer) clearTimeout(timer);
    expiryTimers.delete(id);
  }
  function scheduleExpiry(id: string) {
    const item = prepared.get(id);
    if (!item || closed) return;
    const timer = setTimeout(() => {
      const current = prepared.get(id);
      if (!current || closed) { forget(id); return; }
      // Re-evaluate the clock if it moved backwards. No raw email is captured
      // by this callback; cancellation can release it immediately.
      if (current.preview.expiresAt > now()) { scheduleExpiry(id); return; }
      forget(id);
      try { options.store.cancel(id); } catch {
        // Expiry still prevents claim, even if metadata persistence failed.
        // Private MIME has already been released from the preparation map.
      }
    }, Math.max(1, item.preview.expiresAt - now()));
    timer.unref();
    expiryTimers.set(id, timer);
  }
  const active = new Set<Promise<unknown>>();
  function track<T>(action: () => Promise<T>): Promise<T> {
    const promise = action();
    active.add(promise);
    void promise.then(() => { active.delete(promise); }, () => { active.delete(promise); });
    return promise;
  }
  const denied = () => err('GMAIL_WRITE_NOT_AUTHORIZED', 'This exact email operation was not authorized. Nothing was sent.');
  return {
    async prepare(input: unknown) {
      if (closed) return denied();
      const request = Request.safeParse(input);
      if (!request.success) return err('GMAIL_COMPOSE_INVALID', 'A bounded email preparation is required.');
      for (const [id, item] of prepared) if (item.preview.expiresAt <= now()) { forget(id); options.store.cancel(id); }
      if (prepared.size >= 10) return err('GMAIL_PREPARATION_LIMIT', 'Finish or cancel a pending email first.');
      const identity = await options.identity();
      if (!identity.ok) return identity;
      if (closed) return denied();
      if (prepared.size >= 10) return err('GMAIL_PREPARATION_LIMIT', 'Finish or cancel a pending email first.');
      if (identity.value.revision !== options.account.revision()) return denied();
      const composed = composeGmailSnapshot({ ...request.data.message, from: identity.value.emailAddress }, new Date(now()));
      if (!composed.ok) return composed;
      const preview: GmailWritePreview = { id: randomUUID(), digest: composed.value.digest,
        operation: request.data.operation, expiresAt: now() + 300000, content: composed.value.content };
      const inserted = options.store.prepare({ id: preview.id, requestKey: request.data.requestKey, digest: preview.digest,
        accountBinding: identity.value.accountBinding, operation: preview.operation, expiresAt: preview.expiresAt });
      if (inserted !== 'created') return err('GMAIL_PREPARATION_EXISTS', 'This request was already prepared. Do not create or send another copy.');
      prepared.set(preview.id, { preview: structuredClone(preview), raw: composed.value.raw,
        revision: identity.value.revision, binding: identity.value.accountBinding });
      scheduleExpiry(preview.id);
      return ok(structuredClone(preview));
    },
    execute(id: string, digest: string, approval: unknown) { return track(async () => {
      if (closed) return denied();
      const item = prepared.get(id);
      if (!item || item.preview.digest !== digest || item.preview.expiresAt <= now()) return denied();
      let authorized: boolean;
      try { authorized = await options.authorize(approval, structuredClone(item.preview)); } catch { return denied(); }
      if (closed || !authorized || options.account.revision() !== item.revision) return denied();
      const compose = 'https://www.googleapis.com/auth/gmail.compose';
      const scope = item.preview.operation === 'draft' || options.account.authorizedScopes().includes(compose)
        ? compose : 'https://www.googleapis.com/auth/gmail.send';
      const token = await options.account.accessToken([scope]);
      if (!token.ok) return token;
      if (closed || options.account.revision() !== item.revision || item.preview.expiresAt <= now()) return denied();
      if (!options.store.claim(id, digest, item.binding, item.preview.operation)) return denied();
      forget(id); // A second concurrent execution cannot dispatch.
      const client = createGmailClient({ accessToken: async () => options.account.revision() === item.revision ? token.value : undefined,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) });
      const result = item.preview.operation === 'draft' ? await client.createDraft(item.raw) : await client.sendRaw(item.raw);
      const state = result.ok ? 'accepted' : result.error.code === 'GMAIL_WRITE_OUTCOME_UNCERTAIN' ? 'uncertain' : 'rejected';
      try {
        if (!options.store.finish(id, state, result.ok ? result.value.id : undefined)) {
          return err('GMAIL_WRITE_OUTCOME_UNCERTAIN', 'The email outcome could not be stored. Do not repeat it.');
        }
      } catch { return err('GMAIL_WRITE_OUTCOME_UNCERTAIN', 'The email outcome could not be stored. Do not repeat it.'); }
      return result.ok ? ok({ id, operation: item.preview.operation, state, receiptId: result.value.id, recipientDeliveryConfirmed: false }) : result;
    }); },
    async close(): Promise<void> {
      closed = true;
      let cancellationFailed = false;
      for (const id of prepared.keys()) {
        try { options.store.cancel(id); } catch { cancellationFailed = true; }
      }
      prepared.clear();
      for (const timer of expiryTimers.values()) clearTimeout(timer);
      expiryTimers.clear();
      await Promise.allSettled([...active]);
      if (cancellationFailed) throw new Error('Gmail shutdown could not persist every cancelled preparation.');
    },
    cancel(id: string): boolean { forget(id); return options.store.cancel(id); },
    status: options.store.status,
  };
}
