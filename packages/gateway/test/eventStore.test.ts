import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../src/db/schema.js';
import {
  appendEvent,
  listEvents,
  listEventsAfter,
} from '../src/events/eventStore.js';

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

describe('eventStore', () => {
  it('assigns monotonic per-task sequence numbers and lists events in order', () => {
    const db = open(':memory:');
    const createdAt = '2026-07-14T12:00:00.000Z';

    const appended = [
      appendEvent(db, {
        id: 'event-1',
        taskId: 'task-1',
        type: 'queued',
        payload: { source: 'test' },
        createdAt,
      }),
      appendEvent(db, {
        id: 'event-2',
        taskId: 'task-1',
        type: 'running',
        payload: {},
        createdAt,
      }),
      appendEvent(db, {
        id: 'event-3',
        taskId: 'task-1',
        type: 'complete',
        payload: { exitCode: 0 },
        createdAt,
      }),
    ].map(mustSucceed);

    expect(appended.map((event) => event.seq)).toEqual([0, 1, 2]);

    const listed = mustSucceed(listEvents(db, 'task-1'));
    expect(listed.map((event) => event.id)).toEqual([
      'event-1',
      'event-2',
      'event-3',
    ]);
    expect(listed.map((event) => event.seq)).toEqual([0, 1, 2]);
  });

  it('persists events after the database is closed and reopened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-event-store-test-'));
    tempDirs.add(dir);
    const path = join(dir, 'gateway.sqlite');

    const firstDb = open(path);
    mustSucceed(
      appendEvent(firstDb, {
        id: 'persistent-event',
        taskId: 'persistent-task',
        type: 'log',
        payload: { message: 'still here' },
        createdAt: '2026-07-14T12:00:00.000Z',
      }),
    );
    close(firstDb);

    const reopenedDb = open(path);
    const events = mustSucceed(listEvents(reopenedDb, 'persistent-task'));

    expect(events).toEqual([
      {
        id: 'persistent-event',
        taskId: 'persistent-task',
        seq: 0,
        type: 'log',
        payload: { message: 'still here' },
        createdAt: '2026-07-14T12:00:00.000Z',
      },
    ]);
  });

  it('returns a failed Result when an event does not match the schema', () => {
    const db = open(':memory:');

    const result = appendEvent(db, {
      id: 'bad-event',
      taskId: 'task-1',
      type: 'log',
      payload: {},
      createdAt: 'not-a-date',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_CODEX_LENS_EVENT');
    }
  });

  describe('listEventsAfter (cursor)', () => {
    const createdAt = '2026-07-14T12:00:00.000Z';

    function seed(db: Db, taskId: string, count: number): void {
      for (let index = 0; index < count; index += 1) {
        mustSucceed(
          appendEvent(db, {
            id: `${taskId}-e${index}`,
            taskId,
            type: 'log',
            payload: {},
            createdAt,
          }),
        );
      }
    }

    it('returns only events strictly newer than the cursor', () => {
      const db = open(':memory:');
      seed(db, 'task-1', 5); // seq 0..4
      const after1 = mustSucceed(listEventsAfter(db, 'task-1', 1));
      expect(after1.map((event) => event.seq)).toEqual([2, 3, 4]);
    });

    it('treats -1 as the whole log, identical to listEvents', () => {
      const db = open(':memory:');
      seed(db, 'task-1', 3);
      expect(mustSucceed(listEventsAfter(db, 'task-1', -1)).map((e) => e.seq)).toEqual([0, 1, 2]);
      expect(mustSucceed(listEvents(db, 'task-1')).map((e) => e.seq)).toEqual([0, 1, 2]);
    });

    it('returns empty when the cursor is at or beyond the last seq (replayed tail)', () => {
      const db = open(':memory:');
      seed(db, 'task-1', 3); // last seq = 2
      expect(mustSucceed(listEventsAfter(db, 'task-1', 2))).toEqual([]);
      // A replayed / over-shot cursor is harmless, not an error.
      expect(mustSucceed(listEventsAfter(db, 'task-1', 99))).toEqual([]);
    });

    it('keeps concurrent task streams isolated, each with its own seq space', () => {
      const db = open(':memory:');
      seed(db, 'task-a', 3);
      seed(db, 'task-b', 2);
      const a = mustSucceed(listEventsAfter(db, 'task-a', -1));
      const b = mustSucceed(listEventsAfter(db, 'task-b', -1));
      expect(a.map((e) => e.seq)).toEqual([0, 1, 2]);
      expect(b.map((e) => e.seq)).toEqual([0, 1]);
      expect(a.every((e) => e.taskId === 'task-a')).toBe(true);
      expect(b.every((e) => e.taskId === 'task-b')).toBe(true);
      // A cursor into task-a (seq 0,1,2) returns only seq 2, never task-b.
      expect(mustSucceed(listEventsAfter(db, 'task-a', 1)).map((e) => e.taskId)).toEqual([
        'task-a',
      ]);
    });

    it('rejects a cursor below -1 rather than silently coercing', () => {
      const db = open(':memory:');
      seed(db, 'task-1', 1);
      const result = listEventsAfter(db, 'task-1', -2);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_EVENT_CURSOR');
      }
    });

    it('rejects a non-integer cursor', () => {
      const db = open(':memory:');
      seed(db, 'task-1', 1);
      const result = listEventsAfter(db, 'task-1', 1.5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_EVENT_CURSOR');
      }
    });

    it('rejects an empty taskId', () => {
      const db = open(':memory:');
      const result = listEventsAfter(db, '   ', 0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_TASK_ID');
      }
    });
  });
});
