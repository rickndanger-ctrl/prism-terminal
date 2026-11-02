import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GmailWriteRequestSchema, type createGmailWriter } from '../email/gmailWriter.js';
import { GmailPhoneApprovalSchema } from '../email/gmailPhoneApproval.js';

export function registerGmailWriteRoutes(server: FastifyInstance, writer?: ReturnType<typeof createGmailWriter>): void {
  const unavailable = { error: 'GMAIL_WRITE_UNAVAILABLE', message: 'Gmail writes are unavailable. No automatic retry was made.' };
  const params = { type: 'object', required: ['id'], additionalProperties: false,
    properties: { id: { type: 'string', format: 'uuid' } } };
  server.post('/v1/gmail/writes/prepare', { schema: { body: z.toJSONSchema(GmailWriteRequestSchema, { target: 'draft-7' }) } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!writer) return reply.code(503).send(unavailable);
    try {
      const result = await writer.prepare(request.body);
      return result.ok ? result.value : reply.code(409).send({ error: result.error.code });
    } catch { return reply.code(503).send(unavailable); }
  });
  server.post('/v1/gmail/writes/execute', { schema: { body: z.toJSONSchema(z.object({ confirmation: GmailPhoneApprovalSchema }).strict(), { target: 'draft-7' }) } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!writer) return reply.code(503).send(unavailable);
    const { confirmation } = request.body as { confirmation: z.infer<typeof GmailPhoneApprovalSchema> };
    try {
      const result = await writer.execute(confirmation.id, confirmation.digest, confirmation);
      return result.ok ? result.value : reply.code(result.error.code === 'GMAIL_WRITE_OUTCOME_UNCERTAIN' ? 503 : 409)
        .send({ error: result.error.code, retryAllowed: false });
    } catch {
      // A transport exception here cannot establish whether dispatch happened.
      return reply.code(503).send({ error: 'GMAIL_WRITE_OUTCOME_UNCERTAIN', retryAllowed: false });
    }
  });
  server.get('/v1/gmail/writes/:id', { schema: { params } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!writer) return reply.code(503).send(unavailable);
    const id = (request.params as { id: string }).id;
    try {
      const status = writer.status(id);
      return status ? { id, ...status } : reply.code(404).send({ error: 'GMAIL_INTENT_NOT_FOUND' });
    } catch { return reply.code(503).send(unavailable); }
  });
  server.delete('/v1/gmail/writes/:id', { schema: { params } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!writer) return reply.code(503).send(unavailable);
    try {
      return { cancelled: writer.cancel((request.params as { id: string }).id) };
    } catch { return reply.code(503).send(unavailable); }
  });
}
