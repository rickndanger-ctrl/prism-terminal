import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { createGmailConnection } from '../email/gmailConnection.js';
import type { GmailIdentity } from '../email/gmailIdentity.js';

type Connection = ReturnType<typeof createGmailConnection>;
type Attempt = { id: string; status: 'authorizing' | 'connected' | 'failed' | 'cancelled' };

/** Authenticated connection management only. No mailbox content or send tool. */
export function registerGmailRoutes(server: FastifyInstance, connection?: Connection, identity?: GmailIdentity): void {
  let attempt: Attempt | undefined;
  let starting = false;
  let generation = 0;
  const unavailable = { error: 'GMAIL_NOT_CONFIGURED', message: 'Gmail connection is not configured on this Mac.' };
  server.get('/v1/gmail/account', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!identity) return reply.code(503).send(unavailable);
    try {
      const result = await identity();
      return result.ok ? { emailAddress: result.value.emailAddress } : reply.code(503).send({ error: 'GMAIL_IDENTITY_UNAVAILABLE' });
    } catch { return reply.code(503).send({ error: 'GMAIL_IDENTITY_UNAVAILABLE' }); }
  });
  server.addHook('onClose', async () => { generation += 1; connection?.cancel(); });
  server.post('/v1/gmail/connection', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['features'],
      properties: { features: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
        items: { type: 'string', enum: ['read', 'draft', 'send'] } } } } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!connection) return reply.code(503).send(unavailable);
    if (starting || attempt?.status === 'authorizing') return reply.code(409).send({ error: 'GMAIL_CONNECTION_BUSY' });
    starting = true;
    const epoch = generation;
    try {
      const { features } = request.body as { features: ('read' | 'draft' | 'send')[] };
      const result = await connection.begin(features);
      if (generation !== epoch) return reply.code(409).send({ error: 'GMAIL_CONNECTION_CANCELLED' });
      if (!result.ok) return reply.code(503).send({ error: 'GMAIL_CONNECTION_FAILED' });
      const current: Attempt = { id: randomUUID(), status: 'authorizing' };
      attempt = current;
      void result.value.completion.then(completed => {
        if (attempt === current && generation === epoch) current.status = completed.ok ? 'connected' : 'failed';
      }).catch(() => {
        if (attempt === current && generation === epoch) current.status = 'failed';
      });
      return reply.code(202).send({ ...current, authorizationURL: result.value.authorizationURL,
        openOn: 'gateway-mac' });
    } catch {
      return reply.code(503).send({ error: 'GMAIL_CONNECTION_FAILED' });
    } finally { starting = false; }
  });
  server.get('/v1/gmail/connection', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!connection) return reply.code(503).send(unavailable);
    // This is the latest connection attempt, not persisted account identity.
    return { attempt: attempt ?? null };
  });
  server.delete('/v1/gmail/connection', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!connection) return reply.code(503).send(unavailable);
    generation += 1;
    if (attempt) attempt.status = 'cancelled';
    try {
      const result = await connection.disconnectLocal();
      if (!result.ok) return reply.code(503).send({ error: 'GMAIL_DISCONNECT_UNCONFIRMED' });
      return { status: 'disconnected', googleAccessRevoked: false };
    } catch { return reply.code(503).send({ error: 'GMAIL_DISCONNECT_UNCONFIRMED' }); }
  });
}
