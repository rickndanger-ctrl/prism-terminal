import type { FastifyInstance } from 'fastify';

import {
  GPT_LIVE_CALLS_PATH,
  GPT_LIVE_MAX_SDP_BYTES,
  isSdp,
  type GptLiveSessionStarter,
} from '../realtime/gptLive.js';

/**
 * `POST /v1/realtime/gpt-live/calls` — trades the phone's SDP offer for a
 * GPT-Live answer. Uses the gateway's shared bearer-auth hook and the SDP parser
 * registered by the Realtime route. The key never leaves the Mac, and callers
 * cannot choose the model, upstream URL, instructions, or tools.
 */
export function registerGptLiveRealtimeRoutes(
  server: FastifyInstance,
  starter?: GptLiveSessionStarter,
): void {
  server.post(GPT_LIVE_CALLS_PATH, { bodyLimit: GPT_LIVE_MAX_SDP_BYTES }, async (request, reply) => {
    if (starter === undefined) {
      return reply.code(503).send({ message: 'GPT Live is not configured on this gateway.' });
    }
    if (!isSdp(request.body)) {
      return reply.code(400).send({ message: 'An SDP offer is required.' });
    }
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    request.raw.once('aborted', abort);
    try {
      const started = await starter(request.body, controller.signal);
      if (!started.ok) {
        // Log the code only — never the upstream detail or any secret.
        request.log.error({ code: started.error.code }, 'gpt-live session start failed');
        return reply.code(503).send({
          message: 'GPT Live could not start a voice session. OpenAI Realtime remains available.',
        });
      }
      return reply
        .code(201)
        .header('cache-control', 'no-store')
        .type('application/sdp')
        .send(started.value.sdp);
    } finally {
      request.raw.removeListener('aborted', abort);
    }
  });
}
