import type { FastifyInstance } from 'fastify';
import type { GmailReader } from '../email/gmailReader.js';

export function registerGmailReadRoutes(server: FastifyInstance, reader?: GmailReader): void {
  const errorBody = { error: 'GMAIL_READ_UNAVAILABLE', message: 'Gmail reading is unavailable. Check account authorization.' };
  server.post('/v1/gmail/search', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: { type: 'string', minLength: 1, maxLength: 1000 },
      pageToken: { type: 'string', minLength: 1, maxLength: 4096 },
    },
  } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!reader) return reply.code(503).send(errorBody);
    try {
      const body = request.body as { query: string; pageToken?: string };
      const result = await reader.search(body.query, body.pageToken);
      return result.ok ? result.value : reply.code(503).send(errorBody);
    } catch { return reply.code(503).send(errorBody); }
  });
  server.post('/v1/gmail/read', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['messageId'], properties: {
      messageId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,256}$' },
    },
  } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!reader) return reply.code(503).send(errorBody);
    try {
      const result = await reader.readText((request.body as { messageId: string }).messageId);
      return result.ok ? result.value : reply.code(503).send(errorBody);
    } catch { return reply.code(503).send(errorBody); }
  });
}
