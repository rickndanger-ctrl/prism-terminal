import { err, ok, type Result } from '@codex-lens/shared';
import { z } from 'zod';
import type { GoogleGrant } from './googleAuthorization.js';

const Token = z.string().min(1).max(8192).refine(value => Array.from(value)
  .every(character => character.charCodeAt(0) > 32 && character.charCodeAt(0) < 127));
const Grant = z.object({ accessToken: Token, refreshToken: Token,
  expiresAt: z.number().finite().nonnegative(), scopes: z.array(z.string().min(1).max(512)).min(1).max(50) }).strict();
export const GmailStoredGrantSchema = Grant;

export interface GmailCredentialStore {
  load(): Promise<unknown>;
  save(grant: GoogleGrant): Promise<void>;
  clear(): Promise<void>;
}

/** One controller must exclusively own a credential-store slot. Serializes
 * writes and never releases an access token until its refresh is saved.
 * Local disconnect is not Google-side revocation and must not be labelled so.
 */
export async function openGmailAccount(options: {
  store: GmailCredentialStore;
  refresh: (grant: GoogleGrant, signal: AbortSignal) => Promise<Result<GoogleGrant>>;
  now?: () => number;
}) {
  let stored: unknown;
  try { stored = await options.store.load(); } catch { throw new Error('Gmail credential storage could not be read.'); }
  let current: GoogleGrant | undefined;
  if (stored !== undefined && stored !== null) {
    const parsed = Grant.safeParse(stored);
    if (!parsed.success) throw new Error('Stored Gmail credentials are invalid. Reconnect Gmail.');
    current = parsed.data;
  }
  const now = options.now ?? Date.now;
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  let refreshAbort: AbortController | undefined;
  let refreshing: { generation: number; promise: Promise<Result<GoogleGrant>> } | undefined;
  const superseded = () => err('GMAIL_ACCOUNT_CHANGED', 'The Gmail account changed before this operation completed.');
  const unavailable = () => err('GMAIL_AUTH_REQUIRED', 'Connect Gmail before using email.');
  function enqueue(action: () => Promise<void>): Promise<void> {
    const result = queue.then(action);
    queue = result.catch(() => undefined);
    return result;
  }
  function invalidate(): number {
    generation += 1;
    refreshAbort?.abort();
    refreshAbort = undefined;
    refreshing = undefined;
    current = undefined;
    return generation;
  }
  async function persist(grant: GoogleGrant, epoch: number): Promise<Result<GoogleGrant>> {
    try {
      await enqueue(async () => {
        if (generation === epoch) await options.store.save(structuredClone(grant));
      });
    } catch {
      if (generation === epoch) current = undefined;
      return err('GMAIL_STORAGE_FAILED', 'Gmail credentials could not be saved. Reconnect Gmail.');
    }
    if (generation !== epoch) return superseded();
    current = structuredClone(grant);
    return ok(structuredClone(grant));
  }
  return {
    revision(): number { return generation; },
    authorizedScopes(): readonly string[] { return current ? [...current.scopes] : []; },
    async close(): Promise<void> {
      invalidate();
      await queue;
    },
    async connect(grant: GoogleGrant): Promise<Result<void>> {
      const parsed = Grant.safeParse(grant);
      if (!parsed.success || parsed.data.expiresAt <= now()) return err('GMAIL_GRANT_INVALID', 'A current Google grant is required.');
      const result = await persist(parsed.data, invalidate());
      return result.ok ? ok(undefined) : result;
    },
    async disconnectLocal(): Promise<Result<void>> {
      const epoch = invalidate();
      try {
        // Always perform an already-requested clear. A subsequent connect is
        // queued after it; skipping the clear could resurrect the old account
        // if that newer credential write fails.
        await enqueue(() => options.store.clear());
      } catch {
        return err('GMAIL_DISCONNECT_UNCONFIRMED', 'Gmail is disabled in this process, but stored credentials could not be removed.');
      }
      return generation === epoch ? ok(undefined) : superseded();
    },
    async accessToken(requiredScopes: readonly string[]): Promise<Result<string>> {
      const epoch = generation;
      if (!current) return unavailable();
      if (requiredScopes.some(scope => !current!.scopes.includes(scope))) {
        return err('GMAIL_SCOPE_REQUIRED', 'This Gmail capability was not authorized.');
      }
      let grant = current;
      if (grant.expiresAt <= now() + 60_000) {
        if (!refreshing || refreshing.generation !== epoch) {
          const snapshot = structuredClone(grant);
          const abort = new AbortController();
          refreshAbort = abort;
          const promise = (async (): Promise<Result<GoogleGrant>> => {
            let result: Result<GoogleGrant>;
            try { result = await options.refresh(snapshot, abort.signal); }
            catch { result = err('GMAIL_REFRESH_FAILED', 'Gmail refresh did not complete.'); }
            if (generation !== epoch || abort.signal.aborted) return superseded();
            if (!result.ok) return result;
            const parsed = Grant.safeParse(result.value);
            if (!parsed.success || parsed.data.expiresAt <= now()
              || parsed.data.scopes.some(scope => !snapshot.scopes.includes(scope))) {
              return err('GMAIL_REFRESH_INVALID', 'Gmail refresh returned an invalid grant.');
            }
            return persist(parsed.data, epoch);
          })();
          refreshing = { generation: epoch, promise };
          void promise.finally(() => { if (refreshing?.promise === promise) refreshing = undefined; });
        }
        const result = await refreshing.promise;
        if (!result.ok) return result;
        grant = result.value;
      }
      if (generation !== epoch || !current) return superseded();
      if (requiredScopes.some(scope => !grant.scopes.includes(scope))) {
        return err('GMAIL_SCOPE_REQUIRED', 'Google no longer grants this Gmail capability.');
      }
      return ok(grant.accessToken);
    },
  };
}
