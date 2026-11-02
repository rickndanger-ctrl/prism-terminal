import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok, type Result } from '@codex-lens/shared';
import { buildServer } from '../src/server.js';
import { createGmailReader } from '../src/email/gmailReader.js';

afterEach(() => vi.unstubAllEnvs());
const headers = { authorization: 'Bearer test-gmail' };
describe('Gmail connection routes', () => {
  it('protects read routes and returns text only through authenticated requests', async () => {
    vi.stubEnv('CODEX_LENS_GATEWAY_TOKEN', 'test-gmail');
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'one', threadId: 'thread',
      payload: { mimeType: 'text/plain', body: { data: Buffer.from('Fixture email').toString('base64url') } } })));
    const gmailReader = createGmailReader({ account: { revision: () => 0, accessToken: async () => ok('google-fixture') }, fetchImpl });
    const server = buildServer({ gmailReader });
    try {
      expect((await server.inject({ method: 'POST', url: '/v1/gmail/read', payload: { messageId: 'one' } })).statusCode).toBe(401);
      expect(fetchImpl).not.toHaveBeenCalled();
      const read = await server.inject({ method: 'POST', url: '/v1/gmail/read', headers, payload: { messageId: 'one' } });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ text: 'Fixture email', untrustedContent: true });
      expect(read.headers['cache-control']).toBe('no-store');
      expect((await server.inject({ method: 'POST', url: '/v1/gmail/read', headers, payload: { messageId: '../profile' } })).statusCode).toBe(400);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally { await server.close(); }
  });
  it('requires gateway authentication and fails closed when unconfigured', async () => {
    vi.stubEnv('CODEX_LENS_GATEWAY_TOKEN', 'test-gmail');
    const server = buildServer();
    try {
      expect((await server.inject({ url: '/v1/gmail/connection' })).statusCode).toBe(401);
      expect((await server.inject({ url: '/v1/gmail/connection', headers })).statusCode).toBe(503);
    } finally { await server.close(); }
  });
  it('reports pending then saved success without returning credentials', async () => {
    vi.stubEnv('CODEX_LENS_GATEWAY_TOKEN', 'test-gmail');
    let resolve!: (result: Result<void>) => void;
    const completion = new Promise<Result<void>>(done => { resolve = done; });
    const connection = { begin: vi.fn(async () => ok({ authorizationURL: 'https://accounts.google.com/test', completion })),
      cancel: vi.fn(), disconnectLocal: vi.fn(async () => ok(undefined)) };
    const server = buildServer({ gmailConnection: connection });
    try {
      const first = await server.inject({ method: 'POST', url: '/v1/gmail/connection', headers, payload: { features: ['read'] } });
      expect(first.statusCode).toBe(202);
      expect(first.json().status).toBe('authorizing');
      expect(first.json().openOn).toBe('gateway-mac');
      expect((await server.inject({ method: 'POST', url: '/v1/gmail/connection', headers, payload: { features: ['read'] } })).statusCode).toBe(409);
      resolve(ok(undefined));
      await Promise.resolve();
      const status = await server.inject({ url: '/v1/gmail/connection', headers });
      expect(status.json().attempt.status).toBe('connected');
      expect(status.headers['cache-control']).toBe('no-store');
      const disconnected = await server.inject({ method: 'DELETE', url: '/v1/gmail/connection', headers });
      expect(disconnected.json()).toEqual({ status: 'disconnected', googleAccessRevoked: false });
      expect(connection.disconnectLocal).toHaveBeenCalledOnce();
    } finally { await server.close(); }
    expect(connection.cancel).toHaveBeenCalledOnce();
  });
  it('rejects extra fields and unknown permissions before sign-in', async () => {
    vi.stubEnv('CODEX_LENS_GATEWAY_TOKEN', 'test-gmail');
    const server = buildServer();
    try {
      for (const payload of [{ features: ['admin'] }, { features: ['read'], token: 'injected' }, { features: [] }]) {
        expect((await server.inject({ method: 'POST', url: '/v1/gmail/connection', headers, payload })).statusCode).toBe(400);
      }
    } finally { await server.close(); }
  });
});
