import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import { buildServer } from '../src/server.js';

const TEST_TOKEN = 'server-test-token';

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

describe('buildServer', () => {
  it('responds with 404 for an unknown route when authenticated', async () => {
    const server = buildServer();
    servers.add(server);

    const response = await server.inject({
      method: 'GET',
      url: '/nonexistent',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('responds with 401 for an unknown route when unauthenticated', async () => {
    const server = buildServer();
    servers.add(server);

    const response = await server.inject({
      method: 'GET',
      url: '/nonexistent',
    });

    expect(response.statusCode).toBe(401);
  });
});
