import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../src/db/schema.js';
import {
  claimQueuedTask,
  createTask,
  transitionTask,
} from '../src/tasks/taskStore.js';

const dbs = new Set<Db>();
const tempDirs = new Set<string>();

function open(path: string): Db {
  const db = openDb(path);
  dbs.add(db);
  return db;
}

function close(db: Db): void {
  db.close();
  dbs.delete(db);
}

function mustSucceed<T>(result: { ok: true; value: T } | { ok: false }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('Expected successful Result');
  }
  return result.value;
}

// Wraps a db so that a competing write runs just before transitionTask's
// UPDATE executes, simulating another writer racing between its validation
// read and its conditional update.
function withConcurrentWriter(db: Db, competingWrite: () => void): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (sql.trimStart().startsWith('UPDATE')) {
          const realGet = statement.get.bind(statement);
          statement.get = (...args: unknown[]) => {
            competingWrite();
            return realGet(...args);
          };
        }
        return statement;
      };
    },
  });
}

function setState(db: Db, taskId: string, state: string): void {
  db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run(state, taskId);
}

function getState(db: Db, taskId: string): string {
  const row = db.prepare('SELECT state FROM tasks WHERE id = ?').get(taskId) as {
    state: string;
  };
  return row.state;
}

function countTasks(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as {
    count: number;
  };
  return row.count;
}

afterEach(() => {
  for (const db of dbs) {
    db.close();
  }
  dbs.clear();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('createTask', () => {
  it('creates a queued task with generated id and timestamps', () => {
    const db = open(':memory:');

    const task = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );

    expect(task.id).not.toHaveLength(0);
    expect(task.projectId).toBe('project-1');
    expect(task.state).toBe('queued');
    expect(task.idempotencyKey).toBe('key-1');
    expect(task.createdAt).toBe(task.updatedAt);
    expect(countTasks(db)).toBe(1);
  });

  it('returns the existing task for a duplicate idempotencyKey without adding a row', () => {
    const db = open(':memory:');

    const first = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );
    const second = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );

    expect(second.id).toBe(first.id);
    expect(second).toEqual(first);
    expect(countTasks(db)).toBe(1);
  });

  it('creates distinct tasks for distinct idempotencyKeys', () => {
    const db = open(':memory:');

    const first = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );
    const second = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-2' }),
    );

    expect(second.id).not.toBe(first.id);
    expect(countTasks(db)).toBe(2);
  });

  it('returns a failed Result for invalid input', () => {
    const db = open(':memory:');

    const result = createTask(db, { projectId: '', idempotencyKey: 'key-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_CREATE_TASK_INPUT');
    }
  });
});

describe('transitionTask', () => {
  it('walks the full lifecycle queued -> running -> complete', () => {
    const db = open(':memory:');
    const task = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );

    const running = mustSucceed(transitionTask(db, task.id, 'running'));
    expect(running.state).toBe('running');

    const complete = mustSucceed(transitionTask(db, task.id, 'complete'));
    expect(complete.state).toBe('complete');
  });

  it('allows running -> failed', () => {
    const db = open(':memory:');
    const task = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );

    mustSucceed(transitionTask(db, task.id, 'running'));
    const failed = mustSucceed(transitionTask(db, task.id, 'failed'));
    expect(failed.state).toBe('failed');
  });

  it('rejects the illegal skip transition queued -> complete', () => {
    const db = open(':memory:');
    const task = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );

    const result = transitionTask(db, task.id, 'complete');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TASK_TRANSITION');
    }
  });

  it('rejects transitions out of a terminal state', () => {
    const db = open(':memory:');
    const task = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );
    mustSucceed(transitionTask(db, task.id, 'running'));
    mustSucceed(transitionTask(db, task.id, 'complete'));

    const result = transitionTask(db, task.id, 'failed');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TASK_TRANSITION');
    }
  });

  it('treats re-applying the current state as a no-op success', () => {
    const db = open(':memory:');
    const task = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );
    const running = mustSucceed(transitionTask(db, task.id, 'running'));

    const again = mustSucceed(transitionTask(db, task.id, 'running'));

    expect(again).toEqual(running);
    expect(countTasks(db)).toBe(1);
  });

  it('returns idempotent success when a concurrent writer already applied the same state', () => {
    const db = open(':memory:');
    const task = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );

    const racingDb = withConcurrentWriter(db, () => {
      setState(db, task.id, 'running');
    });
    const result = mustSucceed(transitionTask(racingDb, task.id, 'running'));

    expect(result.state).toBe('running');
    expect(getState(db, task.id)).toBe('running');
  });

  it('rejects a transition made stale by a concurrent writer', () => {
    const db = open(':memory:');
    const task = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );
    mustSucceed(transitionTask(db, task.id, 'running'));

    const racingDb = withConcurrentWriter(db, () => {
      setState(db, task.id, 'failed');
    });
    const result = transitionTask(racingDb, task.id, 'complete');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TASK_TRANSITION');
    }
    expect(getState(db, task.id)).toBe('failed');
  });

  it('returns a failed Result for an unknown task id', () => {
    const db = open(':memory:');

    const result = transitionTask(db, 'missing-task', 'running');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TASK_NOT_FOUND');
    }
  });

  it('persists state changes across database reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-task-store-test-'));
    tempDirs.add(dir);
    const path = join(dir, 'gateway.sqlite');

    const firstDb = open(path);
    const task = mustSucceed(
      createTask(firstDb, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );
    mustSucceed(transitionTask(firstDb, task.id, 'running'));
    close(firstDb);

    const reopenedDb = open(path);
    const reapplied = mustSucceed(transitionTask(reopenedDb, task.id, 'running'));
    expect(reapplied.state).toBe('running');

    const complete = mustSucceed(transitionTask(reopenedDb, task.id, 'complete'));
    expect(complete.state).toBe('complete');
    expect(complete.id).toBe(task.id);
  });
});

describe('claimQueuedTask', () => {
  it('claims a queued task, moving it to running', () => {
    const db = open(':memory:');
    const task = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );

    const claimed = mustSucceed(claimQueuedTask(db, task.id, 'project-1'));

    expect(claimed.id).toBe(task.id);
    expect(claimed.state).toBe('running');
    expect(getState(db, task.id)).toBe('running');
  });

  it('rejects a second claim on an already-claimed task', () => {
    const db = open(':memory:');
    const task = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );
    mustSucceed(claimQueuedTask(db, task.id, 'project-1'));

    const again = claimQueuedTask(db, task.id, 'project-1');

    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe('TASK_NOT_RUNNABLE');
    }
    expect(getState(db, task.id)).toBe('running');
  });

  it('rejects a claim when the stored project_id does not match', () => {
    const db = open(':memory:');
    const task = mustSucceed(
      createTask(db, { projectId: 'project-1', idempotencyKey: 'key-1' }),
    );

    const result = claimQueuedTask(db, task.id, 'project-2');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TASK_PROJECT_MISMATCH');
    }
    expect(getState(db, task.id)).toBe('queued');
  });

  it('returns a failed Result for an unknown task id', () => {
    const db = open(':memory:');

    const result = claimQueuedTask(db, 'missing-task', 'project-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TASK_NOT_FOUND');
    }
  });
});
