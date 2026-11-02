import type { FastifyInstance } from 'fastify';
import { SpeechError, SpeechInputSchema, type LocalSpeechService } from '../voice/speech.js';

export function registerVoiceRoutes(server: FastifyInstance, service: LocalSpeechService): void {
  server.addHook('preClose', async () => service.close());
  server.get('/v1/voice/status', async () => service.status());
  server.post('/v1/voice/speech', { bodyLimit: 16_384 }, async (request, reply) => {
    const parsed = SpeechInputSchema.safeParse(request.body);
    if (!parsed.success) throw new SpeechError(400, 'Invalid speech request.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    const closed = () => { if (!reply.raw.writableFinished) abort(); };
    request.raw.once('aborted', abort);
    reply.raw.once('close', closed);
    try {
      const audio = await service.synthesize(parsed.data, controller.signal);
      return reply.header('Cache-Control', 'no-store').type('audio/wav').send(audio);
    } catch (error) {
      if (error instanceof SpeechError) throw error;
      throw new SpeechError(503, 'Local voice is unavailable. Text chat is still available.');
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', closed);
    }
  });
}
