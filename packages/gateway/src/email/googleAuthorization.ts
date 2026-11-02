import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { err, ok, type Result } from '@codex-lens/shared';
import { z } from 'zod';

const SCOPES = {
  read: 'https://www.googleapis.com/auth/gmail.readonly',
  draft: 'https://www.googleapis.com/auth/gmail.compose',
  send: 'https://www.googleapis.com/auth/gmail.send',
} as const;
export type GmailFeature = keyof typeof SCOPES;
export interface GoogleGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}
const Token = z.string().min(1).max(8192).refine(value => Array.from(value)
  .every(character => character.charCodeAt(0) > 32 && character.charCodeAt(0) < 127));
const Grant = z.object({
  access_token: Token, refresh_token: Token,
  expires_in: z.number().int().positive().max(86400),
  token_type: z.literal('Bearer'), scope: z.string().min(1).max(8192),
});

/** Desktop authorization core, not an HTTP endpoint. Browser launch, loopback
 * listener ownership and Keychain persistence belong to the host integration.
 * No credential is printed, cached to disk, or reused from another product.
 */
export function createGoogleAuthorization(options: {
  clientId: string;
  clientSecret?: string;
  redirectURI: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u.test(options.clientId)) {
    throw new Error('A Google Desktop OAuth client ID is required.');
  }
  const redirect = new URL(options.redirectURI);
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1'
    || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new Error('Use an owned 127.0.0.1 loopback listener on an explicit port.');
  }
  const now = options.now ?? Date.now;
  let generation = 0;
  let pending: { state: string; verifier: string; scopes: string[]; expiresAt: number } | undefined;
  return {
    begin(features: readonly GmailFeature[]): string {
      if (!features.length || features.some(feature => !Object.hasOwn(SCOPES, feature))) {
        throw new Error('Choose explicit Gmail capabilities.');
      }
      // Gmail compose already grants sending as well as draft management.
      // Do not imply Google offers a draft-only OAuth grant.
      const scopes = [...new Set(features.filter(feature => feature !== 'send' || !features.includes('draft'))
        .map(feature => SCOPES[feature]))];
      generation += 1;
      const verifier = randomBytes(32).toString('base64url');
      pending = { state: randomBytes(32).toString('base64url'), verifier, scopes, expiresAt: now() + 300_000 };
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: options.clientId,
        redirect_uri: redirect.href, response_type: 'code', scope: scopes.join(' '),
        state: pending.state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256', prompt: 'select_account consent', access_type: 'offline',
      }).toString();
      return url.href;
    },
    cancel() { generation += 1; pending = undefined; },
    async complete(callbackURL: string): Promise<Result<GoogleGrant>> {
      const transaction = pending;
      const transactionGeneration = generation;
      const invalid = () => err('GMAIL_AUTH_CALLBACK_INVALID', 'Google authorization was not bound to the active request.');
      if (!transaction || now() >= transaction.expiresAt) { pending = undefined; return invalid(); }
      let callback: URL;
      try { callback = new URL(callbackURL); } catch { return invalid(); }
      if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname
        || callback.username || callback.password || callback.hash) return invalid();
      const states = callback.searchParams.getAll('state');
      if (states.length !== 1 || Buffer.byteLength(states[0]!) !== Buffer.byteLength(transaction.state)
        || !timingSafeEqual(Buffer.from(states[0]!), Buffer.from(transaction.state))) return invalid();
      // Consume before any asynchronous exchange. Concurrent callbacks cannot
      // exchange the same code twice, and new authorization supersedes old state.
      pending = undefined;
      const codes = callback.searchParams.getAll('code');
      if (callback.searchParams.has('error')) return err('GMAIL_AUTH_DECLINED', 'Google authorization was not granted.');
      if (codes.length !== 1 || !codes[0] || codes[0].length > 8192) return invalid();
      const form = new URLSearchParams({ client_id: options.clientId,
        code: codes[0], code_verifier: transaction.verifier, redirect_uri: redirect.href,
        grant_type: 'authorization_code',
        ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
      });
      try {
        const response = await (options.fetchImpl ?? fetch)('https://oauth2.googleapis.com/token', {
          method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(), signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          return err('GMAIL_AUTH_EXCHANGE_FAILED', 'Google authorization could not be completed. Start a new connection.');
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 65536) throw new Error('oversized token response');
            chunks.push(chunk.value);
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        const grant = Grant.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!grant.success) return err('GMAIL_AUTH_GRANT_INVALID', 'Google did not provide a usable background-access grant.');
        const scopes = grant.data.scope.split(/\s+/u);
        if (transaction.scopes.some(scope => !scopes.includes(scope))) {
          return err('GMAIL_AUTH_SCOPE_MISSING', 'Google did not grant all selected Gmail capabilities.');
        }
        if (generation !== transactionGeneration) {
          return err('GMAIL_AUTH_SUPERSEDED', 'This Google connection was cancelled or replaced.');
        }
        return ok({ accessToken: grant.data.access_token, refreshToken: grant.data.refresh_token,
          expiresAt: now() + grant.data.expires_in * 1000, scopes });
      } catch {
        return err('GMAIL_AUTH_EXCHANGE_FAILED', 'Google authorization did not finish. Start a new connection.');
      }
    },
  };
}
