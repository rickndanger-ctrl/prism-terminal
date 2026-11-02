import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GeminiPoolError, type GeminiSessionPool } from '../realtime/geminiSessionPool.js';

/** Uses the gateway's shared bearer-auth hook and SDP parser. Deliberately has
 * no env-based activation: a fully configured host-owned pool must be supplied.
 */
export function registerGeminiRealtimeRoutes(server: FastifyInstance, sessions?: GeminiSessionPool): void {
  server.post('/v1/realtime/gemini/calls', { bodyLimit: 131072 }, async (request, reply) => {
    if (!sessions?.available) return reply.code(503).send({ message: 'Gemini experimental backend is disabled.' });
    if (typeof request.body !== 'string' || !request.body.startsWith('v=0') || Buffer.byteLength(request.body) > 131072) {
      return reply.code(400).send({ message: 'An SDP offer is required.' });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once('aborted', abort);
    if (request.raw.aborted) abort();
    try {
      const session = await sessions.start(request.body, controller.signal);
      return reply.code(201).header('location', `/v1/realtime/gemini/calls/${session.id}`)
        .header('cache-control', 'no-store').type('application/sdp').send(session.sdp);
    } catch (error) {
      const busy = error instanceof GeminiPoolError && error.kind === 'capacity';
      return reply.code(busy ? 429 : 503).send({ message: busy
        ? 'A Gemini voice session is already active.' : 'Gemini could not start a voice session. The existing voice backend is unchanged.' });
    } finally { request.raw.removeListener('aborted', abort); }
  });

  server.delete('/v1/realtime/gemini/calls/:id', async (request, reply) => {
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: 'A valid session ID is required.' });
    if (!sessions?.available) return reply.code(503).send({ message: 'Gemini experimental backend is disabled.' });
    sessions.stop(params.data.id); // Idempotent; do not reveal whether an old ID existed.
    return reply.code(204).send();
  });
  server.addHook('onClose', async () => { sessions?.close(); });
}
