import Ajv from 'ajv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GATEWAY_TOKEN_ENV,
  unauthorizedResponseSchema,
} from '../src/auth/index.js';
import { GATEWAY_VERSION, buildServer } from '../src/server.js';

type AjvConstructor = new () => {
  compile(schema: object): (data: unknown) => boolean;
};

const AjvCompat = (
  typeof Ajv === 'function'
    ? Ajv
    : (Ajv as unknown as { default: AjvConstructor }).default
) as AjvConstructor;
const validateUnauthorizedBody = new AjvCompat().compile(
  unauthorizedResponseSchema,
);

const TEST_TOKEN = 'test-token-for-ticket-137';

const servers = new Set<ReturnType<typeof buildServer>>();
let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env[GATEWAY_TOKEN_ENV];
  process.env[GATEWAY_TOKEN_ENV] = TEST_TOKEN;
});

afterEach(async () => {
  if (originalToken === undefined) {
    delete process.env[GATEWAY_TOKEN_ENV];
  } else {
    process.env[GATEWAY_TOKEN_ENV] = originalToken;
  }
  await Promise.all([...servers].map(async (server) => server.close()));
  servers.clear();
});

function makeServer(): ReturnType<typeof buildServer> {
  const server = buildServer();
  servers.add(server);
  return server;
}

describe('registerAuth', () => {
  it('allows /v1/health without a token', async () => {
    const server = makeServer();

    const response = await server.inject({
      method: 'GET',
      url: '/v1/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', version: GATEWAY_VERSION });
  });

  it('rejects a protected route with 401 when no token is provided', async () => {
    const server = makeServer();

    const response = await server.inject({
      method: 'GET',
      url: '/',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: expect.stringContaining('bearer token'),
    });
    expect(validateUnauthorizedBody(response.json())).toBe(true);
  });

  it('serializes the 401 body through the unauthorized response schema', async () => {
    const server = makeServer();
    server.get('/schema-check', async (_request, reply) =>
      // A 401 body that violates the schema must be rejected by the
      // route serializer, proving the schema is genuinely applied.
      reply.code(401).send({ nonsense: true } as never),
    );

    const rejected = await server.inject({
      method: 'GET',
      url: '/schema-check',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    const body = rejected.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty('nonsense');
    expect(body.message).toContain('"statusCode" is required');
  });

  it('rejects a protected route with 401 when the token is invalid', async () => {
    const server = makeServer();

    const response = await server.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: 'Bearer definitely-not-the-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      statusCode: 401,
      error: 'Unauthorized',
    });
  });

  it('rejects a malformed Authorization header', async () => {
    const server = makeServer();

    const response = await server.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: TEST_TOKEN },
    });

    expect(response.statusCode).toBe(401);
  });

  it('allows a protected route with the correct Bearer token', async () => {
    const server = makeServer();

    const response = await server.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      name: '@codex-lens/gateway',
      status: 'ok',
    });
  });

  it('fails closed when the token env var is unset', async () => {
    delete process.env[GATEWAY_TOKEN_ENV];
    const server = makeServer();

    const response = await server.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: 'Bearer anything' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('fails closed when the token env var is empty', async () => {
    process.env[GATEWAY_TOKEN_ENV] = '';
    const server = makeServer();

    const response = await server.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: 'Bearer ' },
    });

    expect(response.statusCode).toBe(401);
  });
});
