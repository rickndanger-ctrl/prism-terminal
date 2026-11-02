import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import { openDb, type Db } from '../src/db/schema.js';
import { seedRegistry } from '../src/registry/registry.js';
import { buildServer } from '../src/server.js';

const TEST_TOKEN = 'routes-codex-test-token';
let originalToken: string | undefined;
const servers = new Set<ReturnType<typeof buildServer>>();
const dbs = new Set<Db>();

beforeEach(() => {
  originalToken = process.env[GATEWAY_TOKEN_ENV];
  process.env[GATEWAY_TOKEN_ENV] = TEST_TOKEN;
});

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => server.close()));
  servers.clear();
  for (const db of dbs) db.close();
  dbs.clear();
  if (originalToken === undefined) delete process.env[GATEWAY_TOKEN_ENV];
  else process.env[GATEWAY_TOKEN_ENV] = originalToken;
});

function makeServer() {
  const db = openDb(':memory:');
  dbs.add(db);
  const seeded = seedRegistry(db);
  if (!seeded.ok) throw new Error(seeded.error.message);
  const server = buildServer({
    db,
    codexProjectInspector: async (project, question) => ({
      ok: true,
      value: {
        projectId: project.id,
        projectName: project.displayName,
        summary: `Verified answer for: ${question}`,
        files: ['src/calculator.js'],
        readOnly: true,
      },
    }),
  });
  servers.add(server);
  return server;
}

describe('POST /v1/codex/inspect', () => {
  it('requires gateway authentication', async () => {
    const response = await makeServer().inject({
      method: 'POST',
      url: '/v1/codex/inspect',
      payload: { projectId: 'sample-project', question: 'What does this project do?' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('inspects only an allowlisted project and returns read-only evidence', async () => {
    const response = await makeServer().inject({
      method: 'POST',
      url: '/v1/codex/inspect',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: { projectId: 'sample-project', question: 'Where is the calculator?' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      projectId: 'sample-project',
      projectName: 'Sample Project',
      summary: 'Verified answer for: Where is the calculator?',
      files: ['src/calculator.js'],
      readOnly: true,
    });
  });

  it('refuses a project that is not in the Mac allowlist', async () => {
    const response = await makeServer().inject({
      method: 'POST',
      url: '/v1/codex/inspect',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: { projectId: 'not-allowed', question: 'Read everything' },
    });
    expect(response.statusCode).toBe(404);
  });
});
