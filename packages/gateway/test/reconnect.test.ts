import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import { openDb } from '../src/db/schema.js';
import { seedRegistry } from '../src/registry/registry.js';
import {
  TaskEventsResponseSchema,
  TaskResponseSchema,
  type TaskEventsResponse,
} from '../src/routes/tasks.js';
import { buildServer } from '../src/server.js';
import type { Task } from '../src/tasks/task.js';

const TEST_TOKEN = 'reconnect-test-token';
const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN}` };
const SEEDED_PROJECT_ID = 'sample-project';

const servers = new Set<ReturnType<typeof buildServer>>();
const tempDirs = new Set<string>();
let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env[GATEWAY_TOKEN_ENV];
  process.env[GATEWAY_TOKEN_ENV] = TEST_TOKEN;
});

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => server.close()));
  servers.clear();

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();

  if (originalToken === undefined) {
    delete process.env[GATEWAY_TOKEN_ENV];
  } else {
    process.env[GATEWAY_TOKEN_ENV] = originalToken;
  }
});

async function waitForTerminalTask(
  server: ReturnType<typeof buildServer>,
  taskId: string,
): Promise<Task> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}`,
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(200);

    const task = TaskResponseSchema.parse(response.json());
    if (task.state === 'complete' || task.state === 'failed') {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Task ${taskId} never reached a terminal state`);
}

async function getEvents(
  server: ReturnType<typeof buildServer>,
  taskId: string,
): Promise<TaskEventsResponse> {
  const response = await server.inject({
    method: 'GET',
    url: `/v1/tasks/${taskId}/events`,
    headers: AUTH_HEADERS,
  });
  expect(response.statusCode).toBe(200);
  return TaskEventsResponseSchema.parse(response.json());
}

describe('gateway reconnect recovery', () => {
  it('recovers a completed task and its normalized events after restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'gateway-reconnect-test-'));
    tempDirs.add(tempDir);
    const dbPath = join(tempDir, 'gateway.sqlite');

    const seedDb = openDb(dbPath);
    const seeded = seedRegistry(seedDb);
    expect(seeded.ok).toBe(true);
    seedDb.close();

    const serverA = buildServer({ dbPath });
    servers.add(serverA);

    const createResponse = await serverA.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: AUTH_HEADERS,
      payload: {
        projectId: SEEDED_PROJECT_ID,
        idempotencyKey: 'survives-gateway-restart',
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdTask = TaskResponseSchema.parse(createResponse.json());

    const taskBeforeRestart = await waitForTerminalTask(serverA, createdTask.id);
    expect(taskBeforeRestart.state).toBe('complete');
    const eventsBeforeRestart = await getEvents(serverA, createdTask.id);
    expect(eventsBeforeRestart.events.map((event) => event.type)).toEqual([
      'queued',
      'running',
      'log',
      'log',
      'complete',
    ]);

    await serverA.close();
    servers.delete(serverA);

    const serverB = buildServer({ dbPath });
    servers.add(serverB);

    const taskResponse = await serverB.inject({
      method: 'GET',
      url: `/v1/tasks/${createdTask.id}`,
      headers: AUTH_HEADERS,
    });
    expect(taskResponse.statusCode).toBe(200);
    const taskAfterRestart = TaskResponseSchema.parse(taskResponse.json());

    const eventsAfterRestart = await getEvents(serverB, createdTask.id);

    expect(taskAfterRestart).toEqual(taskBeforeRestart);
    expect(eventsAfterRestart).toEqual(eventsBeforeRestart);
  });
});
