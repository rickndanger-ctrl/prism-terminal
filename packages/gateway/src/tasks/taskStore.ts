import { randomUUID } from 'node:crypto';

import { err, type Result } from '@codex-lens/shared';

import type { Db } from '../db/schema.js';
import {
  parseCreateTaskInput,
  parseTask,
  TASK_STATES,
  type CreateTaskInput,
  type Task,
  type TaskState,
} from './task.js';

interface TaskRow {
  id: string;
  project_id: string;
  state: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

const TASK_COLUMNS = `
  id,
  project_id,
  state,
  idempotency_key,
  created_at,
  updated_at
`;

const VALID_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ['running'],
  running: ['paused', 'complete', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  complete: [],
  failed: [],
  cancelled: [],
};

function rowToTask(row: TaskRow): Result<Task> {
  const parsed = parseTask({
    id: row.id,
    projectId: row.project_id,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (!parsed.ok) {
    return err('INVALID_STORED_TASK', parsed.error.message);
  }

  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTask(db: Db, input: CreateTaskInput): Result<Task> {
  const parsed = parseCreateTaskInput(input);
  if (!parsed.ok) {
    return parsed;
  }

  const now = new Date().toISOString();

  try {
    const row = db
      .prepare(
        `INSERT INTO tasks (id, project_id, state, idempotency_key, created_at, updated_at)
         VALUES (@id, @projectId, 'queued', @idempotencyKey, @now, @now)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${TASK_COLUMNS}`,
      )
      .get({
        id: randomUUID(),
        projectId: parsed.value.projectId,
        idempotencyKey: parsed.value.idempotencyKey,
        now,
      }) as TaskRow | undefined;

    if (row !== undefined) {
      return rowToTask(row);
    }

    const existing = db
      .prepare(
        `SELECT ${TASK_COLUMNS}
         FROM tasks
         WHERE idempotency_key = ?`,
      )
      .get(parsed.value.idempotencyKey) as TaskRow | undefined;

    if (existing === undefined) {
      return err(
        'TASK_STORE_WRITE_FAILED',
        `Task with idempotencyKey ${parsed.value.idempotencyKey} was neither created nor found`,
      );
    }

    return rowToTask(existing);
  } catch (error) {
    return err('TASK_STORE_WRITE_FAILED', errorMessage(error));
  }
}

export function getTaskById(db: Db, taskId: string): Result<Task> {
  if (taskId.trim().length === 0) {
    return err('INVALID_TASK_ID', 'taskId must not be empty');
  }

  try {
    const row = db
      .prepare(
        `SELECT ${TASK_COLUMNS}
         FROM tasks
         WHERE id = ?`,
      )
      .get(taskId) as TaskRow | undefined;

    if (row === undefined) {
      return err('TASK_NOT_FOUND', `No task with id ${taskId}`);
    }

    return rowToTask(row);
  } catch (error) {
    return err('TASK_STORE_READ_FAILED', errorMessage(error));
  }
}

export function claimQueuedTask(
  db: Db,
  taskId: string,
  projectId: string,
): Result<Task> {
  if (taskId.trim().length === 0) {
    return err('INVALID_TASK_ID', 'taskId must not be empty');
  }
  if (projectId.trim().length === 0) {
    return err('INVALID_PROJECT_ID', 'projectId must not be empty');
  }

  try {
    // The conditional UPDATE is the claim: of any number of concurrent
    // claimants, exactly one sees the queued row and wins the transition.
    const claimed = db
      .prepare(
        `UPDATE tasks
         SET state = 'running', updated_at = @now
         WHERE id = @taskId AND state = 'queued' AND project_id = @projectId
         RETURNING ${TASK_COLUMNS}`,
      )
      .get({
        taskId,
        projectId,
        now: new Date().toISOString(),
      }) as TaskRow | undefined;

    if (claimed !== undefined) {
      return rowToTask(claimed);
    }

    const row = db
      .prepare(
        `SELECT ${TASK_COLUMNS}
         FROM tasks
         WHERE id = ?`,
      )
      .get(taskId) as TaskRow | undefined;

    if (row === undefined) {
      return err('TASK_NOT_FOUND', `No task with id ${taskId}`);
    }

    if (row.project_id !== projectId) {
      return err(
        'TASK_PROJECT_MISMATCH',
        `Task ${taskId} belongs to project "${row.project_id}", not "${projectId}"`,
      );
    }

    return err(
      'TASK_NOT_RUNNABLE',
      `Task ${taskId} is in state "${row.state}"; only queued tasks can be run`,
    );
  } catch (error) {
    return err('TASK_STORE_WRITE_FAILED', errorMessage(error));
  }
}

export function transitionTask(
  db: Db,
  taskId: string,
  toState: TaskState,
): Result<Task> {
  if (taskId.trim().length === 0) {
    return err('INVALID_TASK_ID', 'taskId must not be empty');
  }
  if (!TASK_STATES.includes(toState)) {
    return err(
      'INVALID_TASK_STATE',
      `Unknown task state ${String(toState)}; expected one of ${TASK_STATES.join(', ')}`,
    );
  }

  try {
    const row = db
      .prepare(
        `SELECT ${TASK_COLUMNS}
         FROM tasks
         WHERE id = ?`,
      )
      .get(taskId) as TaskRow | undefined;

    if (row === undefined) {
      return err('TASK_NOT_FOUND', `No task with id ${taskId}`);
    }

    const current = rowToTask(row);
    if (!current.ok) {
      return current;
    }

    if (current.value.state === toState) {
      return current;
    }

    if (!VALID_TRANSITIONS[current.value.state].includes(toState)) {
      return err(
        'INVALID_TASK_TRANSITION',
        `Task ${taskId} cannot transition from ${current.value.state} to ${toState}`,
      );
    }

    const updated = db
      .prepare(
        `UPDATE tasks
         SET state = @toState, updated_at = @now
         WHERE id = @taskId AND state = @fromState
         RETURNING ${TASK_COLUMNS}`,
      )
      .get({
        taskId,
        toState,
        fromState: current.value.state,
        now: new Date().toISOString(),
      }) as TaskRow | undefined;

    if (updated !== undefined) {
      return rowToTask(updated);
    }

    // A concurrent writer changed the state between our read and the
    // conditional update; reload and re-evaluate against the fresh state.
    const reloadedRow = db
      .prepare(
        `SELECT ${TASK_COLUMNS}
         FROM tasks
         WHERE id = ?`,
      )
      .get(taskId) as TaskRow | undefined;

    if (reloadedRow === undefined) {
      return err('TASK_NOT_FOUND', `No task with id ${taskId}`);
    }

    const reloaded = rowToTask(reloadedRow);
    if (!reloaded.ok) {
      return reloaded;
    }

    if (reloaded.value.state === toState) {
      return reloaded;
    }

    return err(
      'INVALID_TASK_TRANSITION',
      `Task ${taskId} cannot transition from ${reloaded.value.state} to ${toState}`,
    );
  } catch (error) {
    return err('TASK_STORE_WRITE_FAILED', errorMessage(error));
  }
}
