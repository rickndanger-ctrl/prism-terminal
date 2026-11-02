import { err, ok, type Result } from '@codex-lens/shared';
import { z } from 'zod';
import { GmailFullMessageSchema, readableGmailMessage } from './gmailReadable.js';

const ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const MAX_BYTES = 1_048_576;
const ID = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u);
const Raw = z.string().min(1).max(MAX_BYTES).regex(/^[A-Za-z0-9_-]+={0,2}$/u);
const Receipt = z.object({ id: ID, threadId: ID });
const Search = z.object({
  messages: z.array(Receipt).max(20).default([]),
  nextPageToken: z.string().max(4096).optional(),
});

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export interface GmailClientOptions {
  /** Supplied by the Google OAuth layer, never the OpenAI credential store. */
  accessToken: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function limitedJSON(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) throw new Error('response too large');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Provider transport only. Not registered as a route or model tool. Callers
 * must bind wearer authorization and a durable intent BEFORE invoking writes.
 * No retries, redirect following, mailbox crawling, or credential logging.
 */
export function createGmailClient(options: GmailClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<Result<T>> {
    let token: string | undefined;
    try { token = await options.accessToken(); } catch { token = undefined; }
    if (!token || token.length > 8192 || /\s/u.test(token) || hasControlCharacters(token)) {
      return err('GMAIL_AUTH_REQUIRED', 'Connect Gmail through Google authorization.');
    }
    const writing = body !== undefined;
    const uncertain = () => err('GMAIL_WRITE_OUTCOME_UNCERTAIN',
      'Gmail may have accepted the operation. Do not automatically repeat it.');
    try {
      const response = await fetchImpl(new URL(path, ROOT), {
        method: writing ? 'POST' : 'GET',
        redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(writing ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401) return err('GMAIL_AUTH_REQUIRED', 'Reconnect Gmail through Google authorization.');
        if (response.status === 403) return err('GMAIL_ACCESS_DENIED', 'Google denied this Gmail operation.');
        if (writing && response.status >= 500) return uncertain();
        return err('GMAIL_REQUEST_REJECTED', 'Gmail rejected the operation. Nothing was retried.');
      }
      const parsed = schema.safeParse(await limitedJSON(response));
      if (!parsed.success) return writing ? uncertain()
        : err('GMAIL_INVALID_RESPONSE', 'Gmail returned an invalid response.');
      return ok(parsed.data);
    } catch {
      return writing ? uncertain() : err('GMAIL_READ_FAILED', 'Gmail did not return a readable response.');
    }
  }
  return {
    async profile() {
      return request('profile', z.object({ emailAddress: z.email().max(254) }));
    },
    async search(query: string, pageToken?: string) {
      if (!query.trim() || query.length > 1000 || hasControlCharacters(query)
        || (pageToken !== undefined && (!pageToken || pageToken.length > 4096))) {
        return err('GMAIL_INVALID_REQUEST', 'A bounded Gmail search query is required.');
      }
      const params = new URLSearchParams({ q: query, maxResults: '20', includeSpamTrash: 'false' });
      if (pageToken) params.set('pageToken', pageToken);
      return request(`messages?${params}`, Search);
    },
    async readRaw(messageId: string) {
      if (!ID.safeParse(messageId).success) return err('GMAIL_INVALID_REQUEST', 'A valid Gmail message ID is required.');
      const result = await request(`messages/${encodeURIComponent(messageId)}?format=raw`, Receipt.extend({ raw: Raw }));
      if (!result.ok) return result;
      if (result.value.id !== messageId) return err('GMAIL_INVALID_RESPONSE', 'Gmail returned a different message.');
      return ok({ ...result.value, untrustedContent: true as const });
    },
    async readText(messageId: string) {
      if (!ID.safeParse(messageId).success) return err('GMAIL_INVALID_REQUEST', 'A valid Gmail message ID is required.');
      const result = await request(`messages/${encodeURIComponent(messageId)}?format=full`, GmailFullMessageSchema);
      if (!result.ok) return result;
      if (result.value.id !== messageId) return err('GMAIL_INVALID_RESPONSE', 'Gmail returned a different message.');
      return readableGmailMessage(result.value);
    },
    async createDraft(raw: string) {
      if (!Raw.safeParse(raw).success) return err('GMAIL_INVALID_REQUEST', 'A bounded MIME message is required.');
      return request('drafts', z.object({ id: ID, message: Receipt }), { message: { raw } });
    },
    /** Accepted by Gmail is not proof of recipient delivery. */
    async sendRaw(raw: string) {
      if (!Raw.safeParse(raw).success) return err('GMAIL_INVALID_REQUEST', 'A bounded MIME message is required.');
      return request('messages/send', Receipt, { raw });
    },
  };
}
