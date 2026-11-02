import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../src/db/schema.js';
import { listEvents } from '../src/events/eventStore.js';
import { parseRegistryRecord } from '../src/registry/projectRegistry.js';
import { runMockTask } from '../src/runner/mockRunner.js';
import { createTask } from '../src/tasks/taskStore.js';
import type { Task } from '../src/tasks/task.js';

const dbs = new Set<Db>();

function open(): Db {
  const db = openDb(':memory:');
  dbs.add(db);
  return db;
}

afterEach(() => {
  for (const db of dbs) {
    db.close();
  }
  dbs.clear();
});

function mustSucceed<T>(result: { ok: true; value: T } | { ok: false }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('Expected successful Result');
  }
  return result.value;
}

const project = mustSucceed(
  parseRegistryRecord({
    id: 'project-1',
    displayName: 'Project One',
    path: '/tmp/project-one',
    allowedCommands: ['echo', 'node --version'],
    allowWorkspaceWrite: true,
    allowDependencyInstall: false,
    allowCommit: false,
    allowPush: false,
    allowDeploy: false,
  }),
);

function queuedTask(db: Db, idempotencyKey = 'key-1'): Task {
  return mustSucceed(createTask(db, { projectId: project.id, idempotencyKey }));
}

function fixedClock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
}

// Valid timestamps until failAtTick, then garbage: appendEvent rejects the
// event at exactly that lifecycle stage, simulating an event-write failure.
function failingClock(failAtTick: number): () => string {
  const base = fixedClock();
  let tick = 0;
  return () => (tick++ === failAtTick ? 'not-a-timestamp' : base());
}

function getTaskState(db: Db, taskId: string): string {
  const row = db.prepare('SELECT state FROM tasks WHERE id = ?').get(taskId) as {
    state: string;
  };
  return row.state;
}

describe('runMockTask', () => {
  it('runs a normal task to complete with ordered queued/running/log/complete events', async () => {
    const db = open();
    const task = queuedTask(db);

    const result = mustSucceed(
      await runMockTask(db, task, project, { clock: fixedClock() }),
    );

    expect(result.task.id).toBe(task.id);
    expect(result.task.state).toBe('complete');
    expect(getTaskState(db, task.id)).toBe('complete');

    const events = mustSucceed(listEvents(db, task.id));
    expect(events.map((event) => event.type)).toEqual([
      'queued',
      'running',
      'log',
      'log',
      'complete',
    ]);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(result.events).toEqual(events);
  });

  it('emits one log event per allowed simulated command', async () => {
    const db = open();
    const task = queuedTask(db);

    mustSucceed(
      await runMockTask(db, task, project, {
        commands: ['echo'],
        clock: fixedClock(),
      }),
    );

    const events = mustSucceed(listEvents(db, task.id));
    const logs = events.filter((event) => event.type === 'log');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.payload).toMatchObject({ command: 'echo' });
  });

  it('ends in failed when a simulated command is not in allowedCommands', async () => {
    const db = open();
    const task = queuedTask(db);

    const result = mustSucceed(
      await runMockTask(db, task, project, {
        commands: ['echo', 'rm -rf /'],
        clock: fixedClock(),
      }),
    );

    expect(result.task.state).toBe('failed');
    expect(getTaskState(db, task.id)).toBe('failed');

    const events = mustSucceed(listEvents(db, task.id));
    expect(events.map((event) => event.type)).toEqual([
      'queued',
      'running',
      'log',
      'failed',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      command: 'rm -rf /',
      code: 'COMMAND_NOT_ALLOWED',
    });
  });

  it('rejects a task that is not queued without writing events', async () => {
    const db = open();
    const task = queuedTask(db);
    mustSucceed(await runMockTask(db, task, project, { clock: fixedClock() }));

    const again = await runMockTask(db, task, project, { clock: fixedClock() });

    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe('TASK_NOT_RUNNABLE');
    }
    expect(mustSucceed(listEvents(db, task.id))).toHaveLength(5);
  });

  it('rejects a task that belongs to a different project', async () => {
    const db = open();
    const task = mustSucceed(
      createTask(db, { projectId: 'other-project', idempotencyKey: 'key-x' }),
    );

    const result = await runMockTask(db, task, project, { clock: fixedClock() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TASK_PROJECT_MISMATCH');
    }
    expect(mustSucceed(listEvents(db, task.id))).toHaveLength(0);
  });

  it('rejects a task whose stored project_id no longer matches, even with a matching snapshot', async () => {
    const db = open();
    const task = queuedTask(db);
    // Simulate drift between the caller's snapshot and the store: the
    // in-memory task still claims project.id, but the row moved elsewhere.
    db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(
      'other-project',
      task.id,
    );
    expect(task.projectId).toBe(project.id);

    const result = await runMockTask(db, task, project, { clock: fixedClock() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TASK_PROJECT_MISMATCH');
    }
    expect(getTaskState(db, task.id)).toBe('queued');
    expect(mustSucceed(listEvents(db, task.id))).toHaveLength(0);
  });

  it('lets exactly one of two concurrent runners claim the task', async () => {
    const db = open();
    const task = queuedTask(db);

    const [first, second] = await Promise.all([
      runMockTask(db, task, project, { clock: fixedClock() }),
      runMockTask(db, task, project, { clock: fixedClock() }),
    ]);

    const outcomes = [first, second];
    const winners = outcomes.filter((result) => result.ok);
    const losers = outcomes.filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (!losers[0]!.ok) {
      expect(losers[0]!.error.code).toBe('TASK_NOT_RUNNABLE');
    }

    expect(getTaskState(db, task.id)).toBe('complete');
    // Exactly one lifecycle's worth of events: the loser never emitted.
    expect(
      mustSucceed(listEvents(db, task.id)).map((event) => event.type),
    ).toEqual(['queued', 'running', 'log', 'log', 'complete']);
  });

  it('stamps events with the injected clock', async () => {
    const db = open();
    const task = queuedTask(db);

    mustSucceed(
      await runMockTask(db, task, project, {
        commands: ['echo'],
        clock: fixedClock(),
      }),
    );

    const events = mustSucceed(listEvents(db, task.id));
    expect(events.map((event) => event.createdAt)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:03.000Z',
    ]);
  });

  it('rolls back the claim when the queued event cannot be written', async () => {
    const db = open();
    const task = queuedTask(db);

    const result = await runMockTask(db, task, project, {
      clock: failingClock(0),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_CODEX_LENS_EVENT');
    }
    expect(getTaskState(db, task.id)).toBe('queued');
    expect(mustSucceed(listEvents(db, task.id))).toHaveLength(0);
  });

  it('keeps the task running when the complete event write fails', async () => {
    const db = open();
    const task = queuedTask(db);

    // Ticks: 0 queued, 1 running, 2 log, 3 complete <- fails.
    const result = await runMockTask(db, task, project, {
      commands: ['echo'],
      clock: failingClock(3),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_CODEX_LENS_EVENT');
    }
    expect(getTaskState(db, task.id)).toBe('running');
    expect(
      mustSucceed(listEvents(db, task.id)).map((event) => event.type),
    ).toEqual(['queued', 'running', 'log']);
  });

  it('keeps the task running when the failed event write fails', async () => {
    const db = open();
    const task = queuedTask(db);

    // Ticks: 0 queued, 1 running, 2 failed <- fails.
    const result = await runMockTask(db, task, project, {
      commands: ['rm -rf /'],
      clock: failingClock(2),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_CODEX_LENS_EVENT');
    }
    expect(getTaskState(db, task.id)).toBe('running');
    expect(
      mustSucceed(listEvents(db, task.id)).map((event) => event.type),
    ).toEqual(['queued', 'running']);
  });

  it('rolls back the terminal event when the transition to complete fails', async () => {
    const db = open();
    const task = queuedTask(db);
    const base = fixedClock();
    let tick = 0;
    const clock = (): string => {
      // Tick 2 is the log emit, which runs outside the terminal
      // transaction: an external writer forces the task terminal there, so
      // the later running -> complete transition must fail and take its
      // already-appended complete event down with it.
      if (tick === 2) {
        db.prepare("UPDATE tasks SET state = 'failed' WHERE id = ?").run(
          task.id,
        );
      }
      tick++;
      return base();
    };

    const result = await runMockTask(db, task, project, {
      commands: ['echo'],
      clock,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TASK_TRANSITION');
    }
    expect(getTaskState(db, task.id)).toBe('failed');
    expect(
      mustSucceed(listEvents(db, task.id)).map((event) => event.type),
    ).toEqual(['queued', 'running', 'log']);
  });

  it('never imports child_process, git, or network modules', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/runner/mockRunner.ts', import.meta.url)),
      'utf8',
    );

    const forbidden = [
      'child_process',
      'node:net',
      'node:http',
      'node:https',
      'node:dgram',
      'node:tls',
      'simple-git',
      'isomorphic-git',
      'undici',
      'fetch(',
    ];
    for (const specifier of forbidden) {
      expect(source).not.toContain(specifier);
    }
  });
});
