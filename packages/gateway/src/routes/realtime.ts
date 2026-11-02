import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GEMINI_LIVE_MODEL, type GeminiSessionPool } from '../realtime/geminiSessionPool.js';
import {
  GPT_LIVE_GATEWAY_CREDENTIAL,
  GPT_LIVE_MODEL,
  type GptLiveSessionStarter,
} from '../realtime/gptLive.js';

import {
  BoundaryBadRequestSchema,
  validateBoundary,
} from '../http/validation.js';
import {
  REALTIME_CREDENTIALS_PATH,
  RealtimeCredentialRequestSchema,
  RealtimeCredentialSchema,
  type RealtimeCredentialIssuer,
} from '../realtime/credentials.js';

export { REALTIME_CREDENTIALS_PATH } from '../realtime/credentials.js';

export const RealtimeUnavailableSchema = z
  .object({
    statusCode: z.literal(503),
    error: z.literal('Service Unavailable'),
    message: z.string().min(1),
  })
  .strict();

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' });
}

/**
 * `POST /v1/realtime/credentials` — the phone trades its gateway bearer token
 * (enforced by the shared auth hook) for a short-lived OpenAI Realtime
 * credential. Fails closed with 503 when no issuer is configured, so a
 * misconfigured gateway can never hand out or require the long-lived key.
 */
export function registerRealtimeRoute(
  server: FastifyInstance,
  issuer: RealtimeCredentialIssuer | undefined,
  geminiSessions?: GeminiSessionPool,
  gptLiveStarter?: GptLiveSessionStarter,
): void {
  // HF is loopback-only. The existing gateway bearer-auth hook protects
  // signaling; callers cannot choose an upstream URL or forward API keys.
  server.addContentTypeParser('application/sdp', { parseAs: 'string', bodyLimit: 131072 }, (_request, body, done) => done(null, body));
  server.post('/v1/realtime/huggingface/calls', { bodyLimit: 131072 }, async (request, reply) => {
    if (process.env['CODEX_LENS_HF_ENABLED'] !== '1') {
      return reply.code(503).send({ message: 'Hugging Face experimental backend is disabled.' });
    }
    if (typeof request.body !== 'string' || !request.body.startsWith('v=0')) {
      return reply.code(400).send({ message: 'An SDP offer is required.' });
    }
    try {
      const upstream = await fetch('http://127.0.0.1:8765/v1/realtime/calls', {
        method: 'POST', headers: { 'content-type': 'application/sdp' },
        body: request.body, redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
      if (upstream.status !== 201) throw new Error('HF signaling unavailable');
      const answer = await upstream.text();
      if (!answer.startsWith('v=0') || answer.length > 131072) throw new Error('Invalid HF SDP');
      return reply.code(201).type('application/sdp').send(answer);
    } catch {
      return reply.code(503).send({ message: 'Hugging Face could not start a voice session. Switch to OpenAI in Settings.' });
    }
  });
  server.post(
    REALTIME_CREDENTIALS_PATH,
    {
      schema: {
        body: jsonSchema(RealtimeCredentialRequestSchema),
        response: {
          200: jsonSchema(RealtimeCredentialSchema),
          400: jsonSchema(BoundaryBadRequestSchema),
          503: jsonSchema(RealtimeUnavailableSchema),
        },
      },
    },
    async (request, reply) => {
      const body = validateBoundary(
        RealtimeCredentialRequestSchema,
        request.body ?? {},
        'INVALID_REALTIME_CREDENTIAL_REQUEST',
      );
      if (!body.ok) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: body.error.message,
        });
      }

      if (body.value.model === GEMINI_LIVE_MODEL) {
        if (!geminiSessions?.available) {
          return reply.code(503).send({ statusCode: 503, error: 'Service Unavailable', message: 'Gemini experimental backend is disabled.' });
        }
        return { value: 'gateway-owned-gemini-session', model: GEMINI_LIVE_MODEL,
          expiresAt: new Date(Date.now() + geminiSessions.maxDurationMs).toISOString() };
      }

      if (body.value.model === 'huggingface') {
        if (process.env['CODEX_LENS_HF_ENABLED'] !== '1') {
          return reply.code(503).send({ statusCode: 503, error: 'Service Unavailable', message: 'Hugging Face experimental backend is disabled.' });
        }
        return { value: 'gateway-owned-hf-session', model: 'huggingface', expiresAt: new Date(Date.now() + 55 * 60_000).toISOString() };
      }

      if (body.value.model === GPT_LIVE_MODEL) {
        if (gptLiveStarter === undefined) {
          return reply.code(503).send({ statusCode: 503, error: 'Service Unavailable', message: 'GPT Live is not configured on this gateway.' });
        }
        // The gateway creates the session at signaling time; the phone gets no provider secret.
        return { value: GPT_LIVE_GATEWAY_CREDENTIAL, model: GPT_LIVE_MODEL, expiresAt: new Date(Date.now() + 55 * 60_000).toISOString() };
      }

      if (issuer === undefined) {
        return reply.code(503).send({
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'Realtime credentials are not configured on this gateway.',
        });
      }

      const issued = await issuer(body.value);
      if (!issued.ok) {
        // Log the code only — never the upstream detail or any secret.
        request.log.error(
          { code: issued.error.code },
          'realtime credential issuance failed',
        );
        return reply.code(503).send({
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'Could not issue a realtime credential right now.',
        });
      }

      const response = validateBoundary(
        RealtimeCredentialSchema,
        issued.value,
        'INVALID_REALTIME_CREDENTIAL_RESPONSE',
      );
      if (!response.ok) {
        throw new Error(response.error.message);
      }

      return response.value;
    },
  );
}
