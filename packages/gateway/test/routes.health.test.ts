import { afterEach, describe, expect, it } from 'vitest';

import {
  GATEWAY_VERSION,
  buildServer,
} from '../src/server.js';
import { HealthResponseSchema } from '../src/routes/health.js';

const servers = new Set<ReturnType<typeof buildServer>>();

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => server.close()));
  servers.clear();
});

describe('GET /v1/health', () => {
  it('returns a schema-valid health response without authentication', async () => {
    const server = buildServer();
    servers.add(server);

    const response = await server.inject({
      method: 'GET',
      url: '/v1/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      version: GATEWAY_VERSION,
    });
    expect(HealthResponseSchema.safeParse(response.json()).success).toBe(true);
  });

  it('rejects unexpected query fields at the route boundary', async () => {
    const server = buildServer();
    servers.add(server);

    const response = await server.inject({
      method: 'GET',
      url: '/v1/health?internal=true',
    });

    expect(response.statusCode).toBe(400);
  });
});
