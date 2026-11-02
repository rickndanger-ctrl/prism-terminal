import { realpathSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import { openDb, type Db } from '../src/db/schema.js';
import { seedRegistry } from '../src/registry/registry.js';
import { PreparedExecutionPlanResponseSchema } from '../src/routes/execution-plans.js';
import { buildServer } from '../src/server.js';
import { runMockTask } from '../src/runner/mockRunner.js';
import { SAMPLE_REPO_ROOT } from '../src/registryConfig.js';

const TOKEN = 'execution-plan-route-token';
const headers = { authorization: `Bearer ${TOKEN}` };
const canonicalSampleRoot = realpathSync.native(SAMPLE_REPO_ROOT);
const servers = new Set<ReturnType<typeof buildServer>>();
const dbs = new Set<Db>();
let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env[GATEWAY_TOKEN_ENV];
  process.env[GATEWAY_TOKEN_ENV] = TOKEN;
});

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  for (const db of dbs) db.close();
  servers.clear();
  dbs.clear();
  if (originalToken === undefined) delete process.env[GATEWAY_TOKEN_ENV];
  else process.env[GATEWAY_TOKEN_ENV] = originalToken;
});

function makeServer(withRunner = false) {
  const db = openDb(':memory:');
  dbs.add(db);
  const seeded = seedRegistry(db);
  if (!seeded.ok) throw new Error(seeded.error.message);
  const server = buildServer({
    db,
    ...(withRunner
      ? { taskRunner: (runnerDb: Db, task: Parameters<typeof runMockTask>[1], project: Parameters<typeof runMockTask>[2]) => runMockTask(runnerDb, task, project) }
      : {}),
  });
  servers.add(server);
  return server;
}

async function approvedRequest(server: ReturnType<typeof buildServer>, key: string) {
  const created = await server.inject({
    method: 'POST', url: '/v1/engineering-plans', headers,
    payload: {
      projectId: 'sample-project', idempotencyKey: `engineering-${key}`,
      featureName: 'Correct subtraction',
      objective: 'Fix subtraction so it returns the difference.',
      background: 'The sample fixture is deliberately broken.',
      requirements: ['Subtract the second operand from the first.'],
      constraints: ['Only modify the approved file.'],
      acceptanceCriteria: ['npm test exits successfully.'],
      assumptions: [], risks: [],
    },
  });
  expect(created.statusCode).toBe(200);
  const engineering = created.json<{ plan: { engineeringPlanId: string; version: number; contentDigest: string } }>();
  const approved = await server.inject({
    method: 'POST',
    url: `/v1/engineering-plans/${engineering.plan.engineeringPlanId}/approve`,
    headers,
    payload: { version: engineering.plan.version, contentDigest: engineering.plan.contentDigest },
  });
  expect(approved.statusCode).toBe(200);
  return {
    text: 'Fix subtraction so it returns the difference.',
    engineeringPlanId: engineering.plan.engineeringPlanId,
    engineeringPlanVersion: engineering.plan.version,
    engineeringPlanDigest: engineering.plan.contentDigest,
    filesToModify: ['src/calculator.js'],
    filesToCreate: [],
  };
}

describe('execution plan routes', () => {
  it('generates, persists, and reloads the exact reviewable plan', async () => {
    const server = makeServer();
    const request = await approvedRequest(server, 'load');
    const created = await server.inject({
      method: 'POST',
      url: '/v1/execution-plans',
      headers,
      payload: { projectId: 'sample-project', idempotencyKey: 'plan-key-1', request },
    });
    expect(created.statusCode).toBe(200);
    const body = PreparedExecutionPlanResponseSchema.parse(created.json());
    expect(body.plan.filesToModify).toEqual([
      path.join(canonicalSampleRoot, 'src/calculator.js'),
    ]);
    expect(body.plan.expectedCommands).toEqual(['npm test']);

    const loaded = await server.inject({
      method: 'GET',
      url: `/v1/execution-plans/${body.plan.executionPlanId}`,
      headers,
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toEqual(created.json());
  });

  it('is idempotent and never substitutes a second plan under the same key', async () => {
    const server = makeServer();
    const request = await approvedRequest(server, 'idempotent');
    const first = await server.inject({
      method: 'POST', url: '/v1/execution-plans', headers,
      payload: { projectId: 'sample-project', idempotencyKey: 'same-key', request },
    });
    const second = await server.inject({
      method: 'POST', url: '/v1/execution-plans', headers,
      payload: {
        projectId: 'sample-project', idempotencyKey: 'same-key',
        request: { ...request, text: 'A different request must not replace it.' },
      },
    });
    expect(second.json()).toEqual(first.json());
  });

  it('rejects paths outside the registered editable repository', async () => {
    const server = makeServer();
    const request = await approvedRequest(server, 'escape');
    const response = await server.inject({
      method: 'POST', url: '/v1/execution-plans', headers,
      payload: {
        projectId: 'sample-project', idempotencyKey: 'escape-key',
        request: { ...request, filesToModify: ['../../README.md'] },
      },
    });
    expect(response.statusCode).toBe(422);
  });

  it('starts a task only when the approved id and digest match the stored plan', async () => {
    const server = makeServer(true);
    const request = await approvedRequest(server, 'task');
    const created = await server.inject({
      method: 'POST', url: '/v1/execution-plans', headers,
      payload: { projectId: 'sample-project', idempotencyKey: 'approved-plan', request },
    });
    const prepared = PreparedExecutionPlanResponseSchema.parse(created.json());

    const rejected = await server.inject({
      method: 'POST', url: '/v1/tasks', headers,
      payload: {
        projectId: 'sample-project', idempotencyKey: 'bad-digest-task',
        executionPlanId: prepared.plan.executionPlanId,
        executionPlanDigest: '0'.repeat(64),
      },
    });
    expect(rejected.statusCode).toBe(422);

    const accepted = await server.inject({
      method: 'POST', url: '/v1/tasks', headers,
      payload: {
        projectId: 'sample-project', idempotencyKey: 'approved-task',
        executionPlanId: prepared.plan.executionPlanId,
        executionPlanDigest: prepared.plan.contentDigest,
      },
    });
    expect(accepted.statusCode).toBe(200);
  });
});
