import { err, ok, type Result } from '@codex-lens/shared';

import type { Db } from '../db/schema.js';

export interface TaskRunRecord {
  taskId: string;
  executionPlanId: string;
  executionPlanDigest: string;
  codexThreadId?: string;
  followUpMessage?: string;
  updatedAt: string;
}

interface TaskRunRow {
  task_id: string;
  execution_plan_id: string;
  execution_plan_digest: string;
  codex_thread_id: string | null;
  follow_up_message: string | null;
  updated_at: string;
}

function fromRow(row: TaskRunRow): TaskRunRecord {
  return {
    taskId: row.task_id,
    executionPlanId: row.execution_plan_id,
    executionPlanDigest: row.execution_plan_digest,
    ...(row.codex_thread_id === null ? {} : { codexThreadId: row.codex_thread_id }),
    ...(row.follow_up_message === null ? {} : { followUpMessage: row.follow_up_message }),
    updatedAt: row.updated_at,
  };
}

export function bindTaskRun(
  db: Db,
  taskId: string,
  executionPlanId: string,
  executionPlanDigest: string,
): Result<TaskRunRecord> {
  try {
    db.prepare(`
      INSERT INTO task_runs (task_id, execution_plan_id, execution_plan_digest, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (task_id) DO NOTHING
    `).run(taskId, executionPlanId, executionPlanDigest, new Date().toISOString());
    const loaded = getTaskRun(db, taskId);
    if (!loaded.ok) return loaded;
    if (
      loaded.value.executionPlanId !== executionPlanId ||
      loaded.value.executionPlanDigest !== executionPlanDigest
    ) {
      return err(
        'TASK_RUN_BINDING_MISMATCH',
        'That idempotent task is already bound to a different execution plan.',
      );
    }
    return loaded;
  } catch (error) {
    return err('TASK_RUN_STORE_WRITE_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export function getTaskRun(db: Db, taskId: string): Result<TaskRunRecord> {
  try {
    const row = db.prepare('SELECT * FROM task_runs WHERE task_id = ?').get(taskId) as TaskRunRow | undefined;
    return row === undefined
      ? err('TASK_RUN_NOT_FOUND', `No execution binding for task ${taskId}`)
      : ok(fromRow(row));
  } catch (error) {
    return err('TASK_RUN_STORE_READ_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export function setTaskThread(db: Db, taskId: string, threadId: string): Result<TaskRunRecord> {
  try {
    const row = db.prepare(`
      UPDATE task_runs SET codex_thread_id = ?, updated_at = ? WHERE task_id = ? RETURNING *
    `).get(threadId, new Date().toISOString(), taskId) as TaskRunRow | undefined;
    return row === undefined ? err('TASK_RUN_NOT_FOUND', `No execution binding for task ${taskId}`) : ok(fromRow(row));
  } catch (error) {
    return err('TASK_RUN_STORE_WRITE_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export function setTaskFollowUp(db: Db, taskId: string, message: string): Result<TaskRunRecord> {
  try {
    const row = db.prepare(`
      UPDATE task_runs SET follow_up_message = ?, updated_at = ? WHERE task_id = ? RETURNING *
    `).get(message, new Date().toISOString(), taskId) as TaskRunRow | undefined;
    return row === undefined ? err('TASK_RUN_NOT_FOUND', `No execution binding for task ${taskId}`) : ok(fromRow(row));
  } catch (error) {
    return err('TASK_RUN_STORE_WRITE_FAILED', error instanceof Error ? error.message : String(error));
  }
}
