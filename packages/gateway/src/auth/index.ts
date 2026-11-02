import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply } from 'fastify';

export const GATEWAY_TOKEN_ENV = 'CODEX_LENS_GATEWAY_TOKEN';

export const HEALTH_PATH = '/v1/health';

export const unauthorizedResponseSchema = {
  $id: 'codex-lens/unauthorized-response',
  type: 'object',
  properties: {
    statusCode: { type: 'number', const: 401 },
    error: { type: 'string', const: 'Unauthorized' },
    message: { type: 'string' },
  },
  required: ['statusCode', 'error', 'message'],
  additionalProperties: false,
} as const;

const UNAUTHORIZED_BODY = Object.freeze({
  statusCode: 401,
  error: 'Unauthorized',
  message: 'A valid bearer token is required to access this resource.',
});

const BEARER_PATTERN = /^Bearer (.+)$/;

function constantTimeEquals(a: string, b: string): boolean {
  // Hashing both values first yields equal-length buffers, so neither the
  // token length nor its content can leak through comparison timing.
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

async function sendUnauthorized(reply: FastifyReply): Promise<void> {
  await reply.code(401).send(UNAUTHORIZED_BODY);
}

export function registerAuth(server: FastifyInstance): void {
  server.addSchema(unauthorizedResponseSchema);

  // Attach the shared 401 schema to every protected route so Fastify
  // serializes (and thereby enforces) the unauthorized body against it.
  server.addHook('onRoute', (route) => {
    if (route.url === HEALTH_PATH) {
      return;
    }
    const existingResponses = (route.schema?.response ?? {}) as Record<string, unknown>;
    route.schema = {
      ...route.schema,
      response: {
        ...existingResponses,
        401: { $ref: `${unauthorizedResponseSchema.$id}#` },
      },
    };
  });

  server.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url === HEALTH_PATH) {
      return;
    }

    // Fail closed: without a configured token no request can authenticate.
    const configuredToken = process.env[GATEWAY_TOKEN_ENV];
    if (configuredToken === undefined || configuredToken === '') {
      return sendUnauthorized(reply);
    }

    const presentedToken = BEARER_PATTERN.exec(request.headers.authorization ?? '')?.[1];
    if (presentedToken === undefined || !constantTimeEquals(presentedToken, configuredToken)) {
      return sendUnauthorized(reply);
    }
  });
}
