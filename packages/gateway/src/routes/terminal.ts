import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { VisualReferencesSchema } from '../assistant/visualReferences.js';
import { TerminalError, type TerminalService } from '../terminal/service.js';
import { registerOwnedListenerActivation } from '../lifecycle/listenerActivation.js';

const Id = z.string().uuid();
const Session = z.object({ sessionId: Id }).strict();
const Connect = z.object({ sessionId: Id, acknowledgeUnknownOutcome: z.boolean().optional() }).strict();
const Send = z.object({ requestId: Id, text: z.string().trim().min(1).max(16_000), images: VisualReferencesSchema.optional() }).strict();

export function registerTerminalRoutes(server: FastifyInstance, service: TerminalService): void {
  const streams = new Set<FastifyReply['raw']>();
  registerOwnedListenerActivation(server, 'terminal recovery', () => service.activate());
  server.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
    await service.close();
  });
  const guarded = async <T>(body: () => Promise<T>): Promise<T> => {
    try { return await body(); }
    catch (error) {
      if (error instanceof TerminalError) throw error;
      if (error instanceof z.ZodError) throw new TerminalError(400, 'Invalid terminal request.');
      throw new TerminalError(503, 'The Mac terminal could not complete this request.');
    }
  };
  server.get('/v1/terminal/sessions', async () => ({ sessions: service.store.list() }));
  server.post('/v1/terminal/connect', async (request) => guarded(async () => {
    const body = Connect.parse(request.body);
    return service.connect(body.sessionId, body.acknowledgeUnknownOutcome);
  }));
  server.get('/v1/terminal/:sessionId', async (request) => guarded(async () => service.get(Session.parse(request.params).sessionId)));
  server.post('/v1/terminal/:sessionId/turns', { bodyLimit: 700_000 }, async (request) => guarded(async () => {
    const id = Session.parse(request.params).sessionId;
    const body = Send.parse(request.body);
    return service.send(id, body.requestId, body.text, body.images);
  }));
  server.post('/v1/terminal/:sessionId/interrupt', async (request) => guarded(async () => service.interrupt(Session.parse(request.params).sessionId)));
  // Cursor replay is read-only. A dropped stream never dispatches a model turn.
  server.get('/v1/terminal/:sessionId/events', async (request, reply) => {
    let id: string; let cursor: number;
    try {
      id = Session.parse(request.params).sessionId;
      cursor = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse((request.query as { after?: unknown }).after ?? 0);
      service.get(id);
    } catch (error) { return reply.code(error instanceof TerminalError ? error.statusCode : 400).send({ message: 'Invalid terminal event request.' }); }
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.flushHeaders();
    let closed = false;
    let blocked = false;
    const pump = (): void => {
      if (closed || blocked) return;
      const events = service.store.events(id, cursor);
      for (const event of events) {
        cursor = event.sequence;
        if (!reply.raw.write('id: ' + event.sequence + '\ndata: ' + JSON.stringify(event) + '\n\n')) { blocked = true; break; }
      }
      if (!blocked && events.length === 250) setImmediate(pump);
    };
    const unsubscribe = service.subscribe((changed) => { if (changed === id) pump(); });
    const heartbeat = setInterval(() => { if (!blocked) reply.raw.write(': connected\n\n'); }, 15_000);
    heartbeat.unref();
    reply.raw.on('drain', () => { blocked = false; pump(); });
    reply.raw.on('close', () => { closed = true; streams.delete(reply.raw); clearInterval(heartbeat); unsubscribe(); });
    pump();
  });
}
