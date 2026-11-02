import { describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { startGoogleLoopback } from '../src/email/googleLoopback.js';

async function start(timeoutMs = 5000) {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    access_token: 'private-fixture-access', refresh_token: 'private-fixture-refresh',
    token_type: 'Bearer', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly',
  })));
  const flow = await startGoogleLoopback({ clientId: 'fixture.apps.googleusercontent.com',
    features: ['read'], fetchImpl, timeoutMs });
  const auth = new URL(flow.authorizationURL);
  const callback = new URL(auth.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({ state: auth.searchParams.get('state')!, code: 'private-code' }).toString();
  return { flow, callback, fetchImpl };
}

describe('real loopback callback lifecycle', () => {
  it('uses an ephemeral local port and never returns credentials to the browser', async () => {
    const { flow, callback, fetchImpl } = await start();
    try {
      expect(callback.hostname).toBe('127.0.0.1');
      expect(Number(callback.port)).toBeGreaterThan(0);
      const response = await fetch(callback);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await response.text()).not.toContain('private');
      expect(await flow.completion).toMatchObject({ ok: true, value: { accessToken: 'private-fixture-access' } });
      expect(fetchImpl).toHaveBeenCalledOnce();
      await expect(fetch(callback)).rejects.toThrow();
    } finally { flow.cancel(); }
  });
  it('keeps the valid flow alive after a forged callback', async () => {
    const { flow, callback, fetchImpl } = await start();
    try {
      const forged = new URL(callback); forged.searchParams.set('state', 'forged');
      const invalid = await fetch(forged);
      expect(invalid.status).toBe(400); await invalid.text();
      expect(fetchImpl).not.toHaveBeenCalled();
      const valid = await fetch(callback); await valid.text();
      expect((await flow.completion).ok).toBe(true);
    } finally { flow.cancel(); }
  });
  it('does not process POST or unrelated paths', async () => {
    const { flow, callback, fetchImpl } = await start();
    try {
      for (const response of [await fetch(callback, { method: 'POST' }), await fetch(new URL('/other', callback))]) {
        expect(response.status).toBe(400); await response.text();
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { flow.cancel(); }
    expect(await flow.completion).toMatchObject({ ok: false, error: { code: 'GMAIL_AUTH_CANCELLED' } });
  });
  it('closes an abandoned listener on timeout', async () => {
    const { flow, callback } = await start(15);
    expect(await flow.completion).toMatchObject({ ok: false, error: { code: 'GMAIL_AUTH_TIMED_OUT' } });
    await expect(fetch(callback)).rejects.toThrow();
  });
  it('rejects a rebound Host header before exchanging any code', async () => {
    const { flow, callback, fetchImpl } = await start();
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(callback, { headers: { Host: 'attacker.example' } }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject); request.end();
      });
      expect(status).toBe(400);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { flow.cancel(); }
  });
  it('discards a late token exchange after cancellation', async () => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const exchangeStarted = new Promise<void>(resolve => { started = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const flow = await startGoogleLoopback({ clientId: 'fixture.apps.googleusercontent.com', features: ['read'], fetchImpl });
    const authorization = new URL(flow.authorizationURL);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'fixture' }).toString();
    const browser = fetch(callback).catch(() => undefined);
    await exchangeStarted;
    flow.cancel();
    release(new Response(JSON.stringify({ access_token: 'fixture', refresh_token: 'fixture', token_type: 'Bearer',
      expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' })));
    await browser;
    expect(await flow.completion).toMatchObject({ ok: false, error: { code: 'GMAIL_AUTH_CANCELLED' } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
