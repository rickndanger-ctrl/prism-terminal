import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import { openDb, type Db } from '../src/db/schema.js';
import { seedRegistry } from '../src/registry/registry.js';
import { EngineeringPlanResponseSchema } from '../src/routes/engineering-plans.js';
import { buildServer } from '../src/server.js';

const TOKEN = 'engineering-plan-route-token';
const headers = { authorization: `Bearer ${TOKEN}` };
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

function makeServer() {
  const db = openDb(':memory:');
  dbs.add(db);
  const seeded = seedRegistry(db);
  if (!seeded.ok) throw new Error(seeded.error.message);
  const server = buildServer({ db });
  servers.add(server);
  return server;
}

const payload = {
  projectId: 'sample-project',
  idempotencyKey: 'engineering-key',
  featureName: 'Correct calculator behavior',
  objective: 'Fix subtraction without changing addition.',
  background: 'The sample calculator has a deliberate defect.',
  requirements: ['Subtraction returns the mathematical difference.'],
  constraints: ['Only the allowlisted repository may be changed.'],
  acceptanceCriteria: ['npm test exits 0.'],
  assumptions: [],
  risks: ['An incorrect edit could break addition.'],
};

describe('engineering plan routes', () => {
  it('persists a reviewable plan and approves only its exact version and digest', async () => {
    const server = makeServer();
    const created = await server.inject({ method: 'POST', url: '/v1/engineering-plans', headers, payload });
    expect(created.statusCode).toBe(200);
    const prepared = EngineeringPlanResponseSchema.parse(created.json());
    expect(prepared.plan.status).toBe('ReadyForApproval');
    expect(prepared.approval).toBeUndefined();

    const mismatch = await server.inject({
      method: 'POST', url: `/v1/engineering-plans/${prepared.plan.engineeringPlanId}/approve`, headers,
      payload: { version: prepared.plan.version, contentDigest: '0'.repeat(64) },
    });
    expect(mismatch.statusCode).toBe(422);

    const approved = await server.inject({
      method: 'POST', url: `/v1/engineering-plans/${prepared.plan.engineeringPlanId}/approve`, headers,
      payload: { version: prepared.plan.version, contentDigest: prepared.plan.contentDigest },
    });
    expect(approved.statusCode).toBe(200);
    const outcome = EngineeringPlanResponseSchema.parse(approved.json());
    expect(outcome.plan.status).toBe('Approved');
    expect(outcome.approval?.approvalStatus).toBe('Approved');

    const loaded = await server.inject({
      method: 'GET', url: `/v1/engineering-plans/${prepared.plan.engineeringPlanId}`, headers,
    });
    expect(loaded.json()).toEqual(approved.json());

    const replay = await server.inject({
      method: 'POST', url: `/v1/engineering-plans/${prepared.plan.engineeringPlanId}/approve`, headers,
      payload: { version: prepared.plan.version, contentDigest: prepared.plan.contentDigest },
    });
    expect(replay.statusCode).toBe(409);
  });

  it('is idempotent and does not replace a plan under the same key', async () => {
    const server = makeServer();
    const first = await server.inject({ method: 'POST', url: '/v1/engineering-plans', headers, payload });
    const second = await server.inject({
      method: 'POST', url: '/v1/engineering-plans', headers,
      payload: { ...payload, objective: 'A different objective must not replace the first.' },
    });
    expect(second.json()).toEqual(first.json());
  });

  it('refuses an Execution Plan until the Engineering Plan is approved', async () => {
    const server = makeServer();
    const created = await server.inject({ method: 'POST', url: '/v1/engineering-plans', headers, payload });
    const prepared = EngineeringPlanResponseSchema.parse(created.json());
    const execution = await server.inject({
      method: 'POST', url: '/v1/execution-plans', headers,
      payload: {
        projectId: 'sample-project', idempotencyKey: 'premature-execution',
        request: {
          text: prepared.plan.objective,
          engineeringPlanId: prepared.plan.engineeringPlanId,
          engineeringPlanVersion: prepared.plan.version,
          engineeringPlanDigest: prepared.plan.contentDigest,
          filesToModify: ['src/calculator.js'], filesToCreate: [],
        },
      },
    });
    expect(execution.statusCode).toBe(422);
  });
});
