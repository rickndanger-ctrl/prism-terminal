import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import { openDb, type Db } from '../src/db/schema.js';
import { seedRegistry } from '../src/registry/registry.js';
import { ProjectsResponseSchema } from '../src/routes/projects.js';
import { buildServer } from '../src/server.js';

const TEST_TOKEN = 'routes-projects-test-token';
const servers = new Set<ReturnType<typeof buildServer>>();
const dbs = new Set<Db>();
let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env[GATEWAY_TOKEN_ENV];
  process.env[GATEWAY_TOKEN_ENV] = TEST_TOKEN;
});

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => server.close()));
  servers.clear();
  for (const db of dbs) {
    db.close();
  }
  dbs.clear();

  if (originalToken === undefined) {
    delete process.env[GATEWAY_TOKEN_ENV];
  } else {
    process.env[GATEWAY_TOKEN_ENV] = originalToken;
  }
});

function makeSeededServer(): ReturnType<typeof buildServer> {
  const db = openDb(':memory:');
  dbs.add(db);
  const seeded = seedRegistry(db);
  if (!seeded.ok) {
    throw new Error(seeded.error.message);
  }

  const server = buildServer({ db });
  servers.add(server);
  return server;
}

describe('GET /v1/projects', () => {
  it('returns 401 without a token', async () => {
    const server = makeSeededServer();

    const response = await server.inject({
      method: 'GET',
      url: '/v1/projects',
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns the schema-valid seeded project list with a valid token', async () => {
    const server = makeSeededServer();

    const response = await server.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      projects: [
        {
          id: 'sample-project',
          displayName: 'Sample Project',
          path: realpathSync.native(
            fileURLToPath(new URL('../fixtures/sample-project/', import.meta.url)),
          ),
          allowedCommands: ['echo', 'node --version'],
          allowWorkspaceWrite: true,
          allowDependencyInstall: false,
          allowCommit: false,
          allowPush: false,
          allowDeploy: false,
        },
      ],
    });
    expect(ProjectsResponseSchema.safeParse(response.json()).success).toBe(true);
  });

  it('rejects unexpected query fields when authenticated', async () => {
    const server = makeSeededServer();

    const response = await server.inject({
      method: 'GET',
      url: '/v1/projects?includeInternals=true',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(response.statusCode).toBe(400);
  });
});
