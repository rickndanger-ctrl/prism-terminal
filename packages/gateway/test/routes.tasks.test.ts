import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import { openDb, type Db } from '../src/db/schema.js';
import { seedRegistry } from '../src/registry/registry.js';
import {
  TaskEventsResponseSchema,
  TaskResponseSchema,
} from '../src/routes/tasks.js';
import { buildServer } from '../src/server.js';
import type { Task } from '../src/tasks/task.js';

const TEST_TOKEN = 'routes-tasks-test-token';
const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN}` };
const SEEDED_PROJECT_ID = 'sample-project';

const servers = new Set<ReturnType<typeof buildServer>>();
const dbs = new Set<Db>();
let originalToken: string | undefined;
let keyCounter = 0;

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

function nextIdempotencyKey(): string {
  keyCounter += 1;
  return `routes-tasks-key-${keyCounter}`;
}

async function postTask(
  server: ReturnType<typeof buildServer>,
  body: Record<string, unknown>,
) {
  return server.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: AUTH_HEADERS,
    payload: body,
  });
}

async function waitForTerminalState(
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
    const task = response.json() as Task;
    if (task.state === 'complete' || task.state === 'failed') {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Task ${taskId} never reached a terminal state`);
}

describe('POST /v1/tasks', () => {
  it('returns 401 without a token', async () => {
    const server = makeSeededServer();

    const response = await server.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        projectId: SEEDED_PROJECT_ID,
        idempotencyKey: nextIdempotencyKey(),
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('creates a schema-valid task against the seeded project', async () => {
    const server = makeSeededServer();
    const idempotencyKey = nextIdempotencyKey();

    const response = await postTask(server, {
      projectId: SEEDED_PROJECT_ID,
      idempotencyKey,
    });

    expect(response.statusCode).toBe(200);
    const task = response.json() as Task;
    expect(TaskResponseSchema.safeParse(task).success).toBe(true);
    expect(task.projectId).toBe(SEEDED_PROJECT_ID);
    expect(task.idempotencyKey).toBe(idempotencyKey);
  });

  it('rejects an unregistered projectId with 404', async () => {
    const server = makeSeededServer();

    const response = await postTask(server, {
      projectId: 'no-such-project',
      idempotencyKey: nextIdempotencyKey(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
    });
  });

  it('rejects a path-traversed requestedPath with 422 and creates no task', async () => {
    const server = makeSeededServer();
    const idempotencyKey = nextIdempotencyKey();

    const response = await postTask(server, {
      projectId: SEEDED_PROJECT_ID,
      idempotencyKey,
      requestedPath: '../',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      statusCode: 422,
      error: 'Unprocessable Entity',
    });

    // A rejected request must not have created a task under that key.
    const retry = await postTask(server, {
      projectId: SEEDED_PROJECT_ID,
      idempotencyKey,
    });
    expect(retry.statusCode).toBe(200);
    const task = retry.json() as Task;
    expect(task.createdAt).toBe(task.updatedAt);
  });

  it('rejects a requestedPath escaping via absolute path with 422', async () => {
    const server = makeSeededServer();

    const response = await postTask(server, {
      projectId: SEEDED_PROJECT_ID,
      idempotencyKey: nextIdempotencyKey(),
      requestedPath: '/',
    });

    expect(response.statusCode).toBe(422);
  });

  it('rejects a malformed body with 400', async () => {
    const server = makeSeededServer();

    const response = await postTask(server, {
      projectId: SEEDED_PROJECT_ID,
      idempotencyKey: nextIdempotencyKey(),
      unexpected: 'field',
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns the same task id when the idempotencyKey is repeated', async () => {
    const server = makeSeededServer();
    const idempotencyKey = nextIdempotencyKey();

    const first = await postTask(server, {
      projectId: SEEDED_PROJECT_ID,
      idempotencyKey,
    });
    expect(first.statusCode).toBe(200);
    const firstTask = first.json() as Task;

    const second = await postTask(server, {
      projectId: SEEDED_PROJECT_ID,
      idempotencyKey,
    });
    expect(second.statusCode).toBe(200);
    const secondTask = second.json() as Task;

    expect(secondTask.id).toBe(firstTask.id);
    expect(secondTask.idempotencyKey).toBe(idempotencyKey);

    await waitForTerminalState(server, firstTask.id);

    // Exactly one lifecycle happened: one queued event, one terminal event.
    const events = await server.inject({
      method: 'GET',
      url: `/v1/tasks/${firstTask.id}/events`,
      headers: AUTH_HEADERS,
    });
    const body = events.json() as { events: { type: string }[] };
    expect(body.events.filter((event) => event.type === 'queued')).toHaveLength(1);
  });
});

describe('GET /v1/tasks/:taskId', () => {
  it('returns 401 without a token', async () => {
    const server = makeSeededServer();

    const response = await server.inject({
      method: 'GET',
      url: '/v1/tasks/some-task',
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for an unknown task', async () => {
    const server = makeSeededServer();

    const response = await server.inject({
      method: 'GET',
      url: '/v1/tasks/does-not-exist',
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns the persisted task state', async () => {
    const server = makeSeededServer();

    const created = await postTask(server, {
      projectId: SEEDED_PROJECT_ID,
      idempotencyKey: nextIdempotencyKey(),
    });
    expect(created.statusCode).toBe(200);
    const createdTask = created.json() as Task;

    const task = await waitForTerminalState(server, createdTask.id);
    expect(TaskResponseSchema.safeParse(task).success).toBe(true);
    expect(task.id).toBe(createdTask.id);
    expect(task.projectId).toBe(SEEDED_PROJECT_ID);
    expect(task.state).toBe('complete');
  });
});

describe('GET /v1/tasks/:taskId/events', () => {
  it('returns 401 without a token', async () => {
    const server = makeSeededServer();

    const response = await server.inject({
      method: 'GET',
      url: '/v1/tasks/some-task/events',
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for an unknown task', async () => {
    const server = makeSeededServer();

    const response = await server.inject({
      method: 'GET',
      url: '/v1/tasks/does-not-exist/events',
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns the persisted event log ordered by seq', async () => {
    const server = makeSeededServer();

    const created = await postTask(server, {
      projectId: SEEDED_PROJECT_ID,
      idempotencyKey: nextIdempotencyKey(),
    });
    expect(created.statusCode).toBe(200);
    const createdTask = created.json() as Task;

    const task = await waitForTerminalState(server, createdTask.id);
    expect(task.state).toBe('complete');

    const response = await server.inject({
      method: 'GET',
      url: `/v1/tasks/${createdTask.id}/events`,
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      events: { taskId: string; seq: number; type: string }[];
    };
    expect(TaskEventsResponseSchema.safeParse(body).success).toBe(true);

    expect(body.events.map((event) => event.seq)).toEqual(
      body.events.map((_, index) => index),
    );
    for (const event of body.events) {
      expect(event.taskId).toBe(createdTask.id);
    }

    // Seeded project allows two commands, so the mock run is:
    // queued, running, one log per command, complete.
    expect(body.events.map((event) => event.type)).toEqual([
      'queued',
      'running',
      'log',
      'log',
      'complete',
    ]);
    // A full read reports the cursor to resume from.
    expect(body).toHaveProperty('nextCursor', 4);
  });

  it('streams only events newer than the cursor and advances nextCursor', async () => {
    const server = makeSeededServer();

    const created = await postTask(server, {
      projectId: SEEDED_PROJECT_ID,
      idempotencyKey: nextIdempotencyKey(),
    });
    const createdTask = created.json() as Task;
    await waitForTerminalState(server, createdTask.id);

    // First page: everything, cursor advances to the last seq.
    const first = await server.inject({
      method: 'GET',
      url: `/v1/tasks/${createdTask.id}/events`,
      headers: AUTH_HEADERS,
    });
    const firstBody = first.json() as {
      events: { seq: number }[];
      nextCursor: number;
    };
    expect(firstBody.nextCursor).toBe(4);
    expect(firstBody.events).toHaveLength(5);

    // Polling from the tail returns nothing new and does not rewind.
    const tail = await server.inject({
      method: 'GET',
      url: `/v1/tasks/${createdTask.id}/events?after=${String(firstBody.nextCursor)}`,
      headers: AUTH_HEADERS,
    });
    const tailBody = tail.json() as {
      events: { seq: number }[];
      nextCursor: number;
    };
    expect(tailBody.events).toHaveLength(0);
    expect(tailBody.nextCursor).toBe(4);

    // A mid-stream cursor returns only the strictly-newer events.
    const mid = await server.inject({
      method: 'GET',
      url: `/v1/tasks/${createdTask.id}/events?after=1`,
      headers: AUTH_HEADERS,
    });
    const midBody = mid.json() as { events: { seq: number }[]; nextCursor: number };
    expect(midBody.events.map((event) => event.seq)).toEqual([2, 3, 4]);
    expect(midBody.nextCursor).toBe(4);
  });

  it('rejects a malformed cursor with 400', async () => {
    const server = makeSeededServer();

    const created = await postTask(server, {
      projectId: SEEDED_PROJECT_ID,
      idempotencyKey: nextIdempotencyKey(),
    });
    const createdTask = created.json() as Task;

    const response = await server.inject({
      method: 'GET',
      url: `/v1/tasks/${createdTask.id}/events?after=not-a-number`,
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an out-of-range cursor (below -1) with 400', async () => {
    const server = makeSeededServer();
    const created = await postTask(server, {
      projectId: SEEDED_PROJECT_ID,
      idempotencyKey: nextIdempotencyKey(),
    });
    const createdTask = created.json() as Task;

    const response = await server.inject({
      method: 'GET',
      url: `/v1/tasks/${createdTask.id}/events?after=-2`,
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns an empty page that echoes the cursor when it is past the end', async () => {
    const server = makeSeededServer();
    const created = await postTask(server, {
      projectId: SEEDED_PROJECT_ID,
      idempotencyKey: nextIdempotencyKey(),
    });
    const createdTask = created.json() as Task;
    await waitForTerminalState(server, createdTask.id);

    const response = await server.inject({
      method: 'GET',
      url: `/v1/tasks/${createdTask.id}/events?after=999`,
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { events: unknown[]; nextCursor: number };
    expect(body.events).toHaveLength(0);
    expect(body.nextCursor).toBe(999);
  });
});
