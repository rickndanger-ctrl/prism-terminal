import { createServer } from 'node:http';
import { err, type Result } from '@codex-lens/shared';
import { createGoogleAuthorization, type GmailFeature, type GoogleGrant } from './googleAuthorization.js';

/** Own a short-lived desktop callback listener. Returns a URL for the host's
 * external browser; it never launches a browser or grants consent itself.
 * Tokens are returned only to the local caller, never to the browser page.
 */
export async function startGoogleLoopback(options: {
  clientId: string;
  clientSecret?: string;
  features: readonly GmailFeature[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{
  authorizationURL: string;
  completion: Promise<Result<GoogleGrant>>;
  cancel(): void;
}> {
  const server = createServer();
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Loopback listener unavailable.'); }
  const origin = `http://127.0.0.1:${address.port}`;
  let auth: ReturnType<typeof createGoogleAuthorization>;
  let authorizationURL: string;
  try {
    auth = createGoogleAuthorization({ clientId: options.clientId,
      ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      redirectURI: `${origin}/oauth/callback` });
    authorizationURL = auth.begin(options.features);
  } catch (error) { server.close(); throw error; }

  let settled = false;
  let resolveCompletion!: (value: Result<GoogleGrant>) => void;
  const completion = new Promise<Result<GoogleGrant>>(resolve => { resolveCompletion = resolve; });
  const finish = (result: Result<GoogleGrant>, force = false): void => {
    if (settled) return;
    settled = true;
    auth.cancel();
    clearTimeout(timer);
    server.close();
    if (force) server.closeAllConnections(); else server.closeIdleConnections();
    resolveCompletion(result);
  };
  const timer = setTimeout(() => finish(err('GMAIL_AUTH_TIMED_OUT', 'Google sign-in expired. Start a new connection.'), true),
    Math.max(1, Math.min(options.timeoutMs ?? 300_000, 300_000)));
  timer.unref();
  server.on('error', () => finish(err('GMAIL_AUTH_LISTENER_FAILED', 'The local sign-in listener stopped.'), true));
  server.on('request', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Connection', 'close');
    if (settled || request.method !== 'GET' || request.headers.host !== `127.0.0.1:${address.port}`
      || !request.url?.startsWith('/oauth/callback?') || request.url.length > 16384) {
      response.writeHead(400).end('Invalid sign-in callback.');
      return;
    }
    void auth.complete(origin + request.url).then(result => {
      if (settled) {
        if (!response.destroyed && !response.writableEnded) response.writeHead(409).end('This sign-in is no longer active.');
        return;
      }
      if (!result.ok && result.error.code === 'GMAIL_AUTH_CALLBACK_INVALID') {
        if (!response.destroyed && !response.writableEnded) response.writeHead(400).end('Invalid sign-in callback.');
        return;
      }
      // No user-supplied error, code, state or token is reflected in this page.
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(result.ok ? 200 : 400).end(result.ok
          ? 'Google authorization received. Return to Codex Lens to finish connecting.'
          : 'Google authorization did not complete. Return to Codex Lens.');
      }
      finish(result);
    }).catch(() => {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(500).end('Sign-in failed. Return to Codex Lens.');
      }
      finish(err('GMAIL_AUTH_EXCHANGE_FAILED', 'Google sign-in did not complete.'));
    });
  });
  return { authorizationURL, completion,
    cancel: () => finish(err('GMAIL_AUTH_CANCELLED', 'Google sign-in was cancelled.'), true) };
}
