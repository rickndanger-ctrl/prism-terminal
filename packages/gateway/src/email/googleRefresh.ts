import { err, ok, type Result } from '@codex-lens/shared';
import { z } from 'zod';
import type { GoogleGrant } from './googleAuthorization.js';

const Token = z.string().min(1).max(8192).refine(value => Array.from(value)
  .every(character => character.charCodeAt(0) > 32 && character.charCodeAt(0) < 127));
const ResponseGrant = z.object({ access_token: Token, refresh_token: Token.optional(),
  token_type: z.literal('Bearer'), expires_in: z.number().int().positive().max(86400),
  scope: z.string().min(1).max(8192).optional() });

/** One refresh exchange. Never persists credentials or retries a Gmail action.
 * The account owner must abort this request when disconnecting or replacing
 * the account, and serialize durable writes with account changes.
 */
export async function refreshGoogleGrant(grant: GoogleGrant, options: {
  clientId: string;
  clientSecret?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<Result<GoogleGrant>> {
  const cancelled = () => err('GMAIL_REFRESH_CANCELLED', 'Gmail refresh was cancelled.');
  if (options.signal?.aborted) return cancelled();
  if (!Token.safeParse(grant.refreshToken).success
    || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u.test(options.clientId)) {
    return err('GMAIL_AUTH_REQUIRED', 'A valid Google account connection is required.');
  }
  const form = new URLSearchParams({ client_id: options.clientId, refresh_token: grant.refreshToken,
    grant_type: 'refresh_token', ...(options.clientSecret ? { client_secret: options.clientSecret } : {}) });
  try {
    const response = await (options.fetchImpl ?? fetch)('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(), signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]),
    });
    if (!response.body) return err('GMAIL_REFRESH_FAILED', 'Google returned no refresh response.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 65536) throw new Error('oversized refresh response');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    if (options.signal?.aborted) return cancelled();
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) {
      if (z.object({ error: z.literal('invalid_grant') }).safeParse(body).success) {
        return err('GMAIL_AUTH_REQUIRED', 'Google access expired or was revoked. Reconnect Gmail.');
      }
      return err('GMAIL_REFRESH_FAILED', 'Google could not refresh Gmail access. Nothing was retried.');
    }
    const parsed = ResponseGrant.safeParse(body);
    if (!parsed.success) return err('GMAIL_REFRESH_INVALID', 'Google returned an invalid refresh response.');
    const scopes = parsed.data.scope?.split(/\s+/u) ?? [...grant.scopes];
    if (scopes.some(scope => !grant.scopes.includes(scope))) {
      return err('GMAIL_REFRESH_SCOPE_CHANGED', 'Google returned permissions outside the saved grant. Reconnect Gmail.');
    }
    return ok({ accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? grant.refreshToken,
      expiresAt: (options.now ?? Date.now)() + parsed.data.expires_in * 1000, scopes });
  } catch {
    return options.signal?.aborted ? cancelled()
      : err('GMAIL_REFRESH_FAILED', 'Gmail access could not be refreshed. Nothing was retried.');
  }
}
