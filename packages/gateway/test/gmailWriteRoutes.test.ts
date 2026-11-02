import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@codex-lens/shared';
import { buildServer } from '../src/server.js';
import { createGmailWriter } from '../src/email/gmailWriter.js';
import { createGmailIntentStore } from '../src/email/gmailIntentStore.js';
import { acceptsGmailPhoneApproval } from '../src/email/gmailPhoneApproval.js';

afterEach(() => vi.unstubAllEnvs());
describe('Gmail write route integration', () => {
  it('authenticates, prepares, validates confirmation and dispatches once', async () => {
    vi.stubEnv('CODEX_LENS_GATEWAY_TOKEN', 'route-fixture');
    const headers = { authorization: 'Bearer route-fixture' };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'receipt', threadId: 'thread' })));
    let dbOpenAtDrain = false;
    const server = buildServer({ gmailWriterFactory: db => {
      const writer = createGmailWriter({ store: createGmailIntentStore(db, () => 100000), now: () => 100000,
        account: { revision: () => 0, authorizedScopes: () => ['https://www.googleapis.com/auth/gmail.compose'], accessToken: async () => ok('google-fixture') },
        identity: async () => ok({ emailAddress: 'me@example.com', accountBinding: 'b'.repeat(64), revision: 0 }),
        authorize: async (approval, preview) => acceptsGmailPhoneApproval(approval, preview, 103000), fetchImpl });
      return { ...writer, async close() { dbOpenAtDrain = db.open; await writer.close(); } };
    } });
    try {
      const payload = { requestKey: randomUUID(), operation: 'send', message: { to: ['friend@example.com'], subject: 'Fixture', body: 'Fixture only' } };
      expect((await server.inject({ method: 'POST', url: '/v1/gmail/writes/prepare', payload })).statusCode).toBe(401);
      const prepared = await server.inject({ method: 'POST', url: '/v1/gmail/writes/prepare', headers, payload });
      expect(prepared.statusCode).toBe(200);
      expect(prepared.json()).not.toHaveProperty('raw');
      const { id, digest } = prepared.json();
      const confirmation = { kind: 'phone-email-confirmation', id, digest, operation: 'send', sourceItemId: 'fixture-turn', readbackCompletedAt: 101000, confirmedAt: 102000 };
      expect((await server.inject({ method: 'POST', url: '/v1/gmail/writes/execute', headers,
        payload: { confirmation: { ...confirmation, operation: 'draft' } } })).statusCode).toBe(409);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect((await server.inject({ method: 'POST', url: '/v1/gmail/writes/execute', headers, payload: { confirmation } })).statusCode).toBe(200);
      expect((await server.inject({ method: 'POST', url: '/v1/gmail/writes/execute', headers, payload: { confirmation } })).statusCode).toBe(409);
      const status = await server.inject({ url: `/v1/gmail/writes/${id}`, headers });
      expect(status.json()).toMatchObject({ state: 'accepted', receiptId: 'receipt' });
      expect(status.headers['cache-control']).toBe('no-store');
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally { await server.close(); }
    expect(dbOpenAtDrain).toBe(true);
  });
});
