import type { Db } from '../db/schema.js';
import { immutableVisualReferences, VisualReferencesSchema, type VisualReference } from './visualReferences.js';

export const ASSISTANT_TASK_STATES = [
  'prepared',
  'running',
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'expired',
] as const;

export type AssistantTaskState = typeof ASSISTANT_TASK_STATES[number];
export type AssistantTaskScope = 'project' | 'mac';

export const UNRECONCILED_ASSISTANT_TASK_FAILURE_CODES = [
  'GATEWAY_RESTART_OUTCOME_UNCERTAIN',
  'ASSISTANT_TASK_START_OUTCOME_UNCONFIRMED',
  'ASSISTANT_TASK_CANCEL_UNCONFIRMED',
  'ASSISTANT_TASK_TIMEOUT_UNCONFIRMED',
  'ASSISTANT_TASK_PROCESS_CLEANUP_UNCONFIRMED',
] as const;

const unreconciledFailureCodes = new Set<string>(
  UNRECONCILED_ASSISTANT_TASK_FAILURE_CODES,
);

export interface AssistantTaskProjectPolicy {
  readonly root: string;
  readonly allowedCommands: readonly string[];
  readonly allowDependencyInstall: boolean;
  readonly allowCommit: boolean;
  readonly allowPush: boolean;
  readonly allowDeploy: boolean;
}

export interface AssistantTaskRecord {
  taskId: string;
  confirmationId: string;
  digest: string;
  instruction: string;
  visualReferences?: readonly VisualReference[];
  scope: AssistantTaskScope;
  projectId?: string;
  workingDirectory: string;
  projectPolicy?: AssistantTaskProjectPolicy;
  state: AssistantTaskState;
  model: string;
  reasoningEffort: string;
  requiresExplicitConfirmation: boolean;
  preparedAt: string;
  expiresAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  threadId?: string;
  turnId?: string;
  summary?: string;
  failureCode?: string;
  reconciledAt?: string;
}

export interface AssistantTaskUpdate {
  state: AssistantTaskState;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  threadId?: string;
  turnId?: string;
  summary?: string;
  failureCode?: string;
}

export interface AssistantTaskStore {
  insert(record: AssistantTaskRecord): void;
  getByTaskId(taskId: string): AssistantTaskRecord | undefined;
  getByConfirmationId(confirmationId: string): AssistantTaskRecord | undefined;
  getUnreconciledTask(): AssistantTaskRecord | undefined;
  reconcileUnknownOutcome(taskId: string, reconciledAt: string): boolean;
  hasRunningTask(): boolean;
  transition(taskId: string, expected: readonly AssistantTaskState[], update: AssistantTaskUpdate): boolean;
  failInterrupted(updatedAt: string): number;
}

export function isAssistantTaskOutcomeUnreconciled(
  record: AssistantTaskRecord,
): boolean {
  return record.state === 'failed'
    && record.reconciledAt === undefined
    && record.failureCode !== undefined
    && unreconciledFailureCodes.has(record.failureCode);
}

export function immutableAssistantTaskProjectPolicy(
  policy: AssistantTaskProjectPolicy,
): AssistantTaskProjectPolicy {
  return Object.freeze({
    root: policy.root,
    allowedCommands: Object.freeze([...policy.allowedCommands]),
    allowDependencyInstall: policy.allowDependencyInstall,
    allowCommit: policy.allowCommit,
    allowPush: policy.allowPush,
    allowDeploy: policy.allowDeploy,
  });
}

function clone(record: AssistantTaskRecord): AssistantTaskRecord {
  return {
    ...record,
    ...(record.visualReferences === undefined ? {} : { visualReferences: immutableVisualReferences(record.visualReferences) }),
    ...(record.projectPolicy === undefined
      ? {}
      : { projectPolicy: immutableAssistantTaskProjectPolicy(record.projectPolicy) }),
  };
}

export function createMemoryAssistantTaskStore(): AssistantTaskStore {
  const records = new Map<string, AssistantTaskRecord>();
  return {
    insert(record) {
      if (records.has(record.taskId)) {
        throw new Error(`Duplicate assistant task id: ${record.taskId}`);
      }
      if ([...records.values()].some((item) => item.confirmationId === record.confirmationId)) {
        throw new Error(`Duplicate assistant confirmation id: ${record.confirmationId}`);
      }
      records.set(record.taskId, clone(record));
    },
    getByTaskId(taskId) {
      const record = records.get(taskId);
      return record === undefined ? undefined : clone(record);
    },
    getByConfirmationId(confirmationId) {
      const record = [...records.values()].find((item) => item.confirmationId === confirmationId);
      return record === undefined ? undefined : clone(record);
    },
    getUnreconciledTask() {
      const record = [...records.values()].find(isAssistantTaskOutcomeUnreconciled);
      return record === undefined ? undefined : clone(record);
    },
    reconcileUnknownOutcome(taskId, reconciledAt) {
      const record = records.get(taskId);
      if (record === undefined || !isAssistantTaskOutcomeUnreconciled(record)) return false;
      records.set(taskId, { ...record, reconciledAt, updatedAt: reconciledAt });
      return true;
    },
    hasRunningTask() {
      return [...records.values()].some((item) => item.state === 'running');
    },
    transition(taskId, expected, update) {
      const record = records.get(taskId);
      if (record === undefined || !expected.includes(record.state)) return false;
      records.set(taskId, { ...record, ...update });
      return true;
    },
    failInterrupted(updatedAt) {
      let count = 0;
      for (const [taskId, record] of records) {
        if (record.state !== 'running') continue;
        records.set(taskId, {
          ...record,
          state: 'failed',
          updatedAt,
          finishedAt: updatedAt,
          summary: 'The Mac gateway restarted before a final result. The outcome is unknown; inspect the target before preparing another task.',
          failureCode: 'GATEWAY_RESTART_OUTCOME_UNCERTAIN',
        });
        count += 1;
      }
      return count;
    },
  };
}

interface AssistantTaskRow {
  task_id: string;
  confirmation_id: string;
  digest: string;
  instruction: string;
  scope: AssistantTaskScope;
  project_id: string | null;
  working_directory: string;
  project_policy_json: string | null;
  visual_references_json: string | null;
  state: AssistantTaskState;
  model: string;
  reasoning_effort: string;
  requires_explicit_confirmation: number;
  prepared_at: string;
  expires_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  thread_id: string | null;
  turn_id: string | null;
  summary: string | null;
  failure_code: string | null;
  reconciled_at: string | null;
}

function parseProjectPolicy(value: string | null): AssistantTaskProjectPolicy | undefined {
  if (value === null) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Stored assistant task project policy must be an object');
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.root !== 'string'
    || candidate.root.trim() === ''
    || !Array.isArray(candidate.allowedCommands)
    || !candidate.allowedCommands.every((command) => typeof command === 'string' && command.trim() !== '')
    || typeof candidate.allowDependencyInstall !== 'boolean'
    || typeof candidate.allowCommit !== 'boolean'
    || typeof candidate.allowPush !== 'boolean'
    || typeof candidate.allowDeploy !== 'boolean'
  ) {
    throw new Error('Stored assistant task project policy is invalid');
  }
  return immutableAssistantTaskProjectPolicy({
    root: candidate.root,
    allowedCommands: candidate.allowedCommands as string[],
    allowDependencyInstall: candidate.allowDependencyInstall,
    allowCommit: candidate.allowCommit,
    allowPush: candidate.allowPush,
    allowDeploy: candidate.allowDeploy,
  });
}

function fromRow(row: AssistantTaskRow): AssistantTaskRecord {
  const projectPolicy = parseProjectPolicy(row.project_policy_json);
  return {
    taskId: row.task_id,
    confirmationId: row.confirmation_id,
    digest: row.digest,
    instruction: row.instruction,
    ...(row.visual_references_json == null ? {} : { visualReferences: immutableVisualReferences(VisualReferencesSchema.parse(JSON.parse(row.visual_references_json))) }),
    scope: row.scope,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    workingDirectory: row.working_directory,
    ...(projectPolicy === undefined ? {} : { projectPolicy }),
    state: row.state,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    requiresExplicitConfirmation: row.requires_explicit_confirmation !== 0,
    preparedAt: row.prepared_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    ...(row.reconciled_at === null ? {} : { reconciledAt: row.reconciled_at }),
  };
}

const SELECT_FIELDS = `
  task_id, confirmation_id, digest, instruction, scope, project_id,
  working_directory, project_policy_json, visual_references_json, state, model, reasoning_effort,
  requires_explicit_confirmation, prepared_at, expires_at,
  updated_at, started_at, finished_at, thread_id, turn_id, summary, failure_code, reconciled_at
`;

export function createSqliteAssistantTaskStore(db: Db): AssistantTaskStore {
  const insert = db.prepare(`
    INSERT INTO assistant_tasks (
      task_id, confirmation_id, digest, instruction, scope, project_id,
      working_directory, project_policy_json, visual_references_json, state, model, reasoning_effort,
      requires_explicit_confirmation, prepared_at, expires_at,
      updated_at, started_at, finished_at, thread_id, turn_id, summary, failure_code, reconciled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const byTaskId = db.prepare(`SELECT ${SELECT_FIELDS} FROM assistant_tasks WHERE task_id = ?`);
  const byConfirmationId = db.prepare(`SELECT ${SELECT_FIELDS} FROM assistant_tasks WHERE confirmation_id = ?`);
  const unreconciled = db.prepare(`
    SELECT ${SELECT_FIELDS}
    FROM assistant_tasks
    WHERE state = 'failed'
      AND failure_code IN (${UNRECONCILED_ASSISTANT_TASK_FAILURE_CODES.map(() => '?').join(', ')})
      AND reconciled_at IS NULL
    ORDER BY updated_at ASC
    LIMIT 1
  `);
  const running = db.prepare(`SELECT 1 FROM assistant_tasks WHERE state = 'running' LIMIT 1`);
  const reconcile = db.prepare(`
    UPDATE assistant_tasks
    SET reconciled_at = ?, updated_at = ?
    WHERE task_id = ?
      AND state = 'failed'
      AND failure_code IN (${UNRECONCILED_ASSISTANT_TASK_FAILURE_CODES.map(() => '?').join(', ')})
      AND reconciled_at IS NULL
  `);

  return {
    insert(record) {
      insert.run(
        record.taskId,
        record.confirmationId,
        record.digest,
        record.instruction,
        record.scope,
        record.projectId ?? null,
        record.workingDirectory,
        record.projectPolicy === undefined ? null : JSON.stringify(record.projectPolicy),
        record.visualReferences === undefined ? null : JSON.stringify(record.visualReferences),
        record.state,
        record.model,
        record.reasoningEffort,
        record.requiresExplicitConfirmation ? 1 : 0,
        record.preparedAt,
        record.expiresAt,
        record.updatedAt,
        record.startedAt ?? null,
        record.finishedAt ?? null,
        record.threadId ?? null,
        record.turnId ?? null,
        record.summary ?? null,
        record.failureCode ?? null,
        record.reconciledAt ?? null,
      );
    },
    getByTaskId(taskId) {
      const row = byTaskId.get(taskId) as AssistantTaskRow | undefined;
      return row === undefined ? undefined : fromRow(row);
    },
    getByConfirmationId(confirmationId) {
      const row = byConfirmationId.get(confirmationId) as AssistantTaskRow | undefined;
      return row === undefined ? undefined : fromRow(row);
    },
    getUnreconciledTask() {
      const row = unreconciled.get(
        ...UNRECONCILED_ASSISTANT_TASK_FAILURE_CODES,
      ) as AssistantTaskRow | undefined;
      return row === undefined ? undefined : fromRow(row);
    },
    reconcileUnknownOutcome(taskId, reconciledAt) {
      const result = reconcile.run(
        reconciledAt,
        reconciledAt,
        taskId,
        ...UNRECONCILED_ASSISTANT_TASK_FAILURE_CODES,
      );
      return result.changes === 1;
    },
    hasRunningTask() {
      return running.get() !== undefined;
    },
    transition(taskId, expected, update) {
      if (expected.length === 0) return false;
      const placeholders = expected.map(() => '?').join(', ');
      const statement = db.prepare(`
        UPDATE assistant_tasks
        SET state = ?, updated_at = ?, started_at = COALESCE(?, started_at),
            finished_at = COALESCE(?, finished_at), thread_id = COALESCE(?, thread_id),
            turn_id = COALESCE(?, turn_id), summary = COALESCE(?, summary),
            failure_code = COALESCE(?, failure_code)
        WHERE task_id = ? AND state IN (${placeholders})
      `);
      const result = statement.run(
        update.state,
        update.updatedAt,
        update.startedAt ?? null,
        update.finishedAt ?? null,
        update.threadId ?? null,
        update.turnId ?? null,
        update.summary ?? null,
        update.failureCode ?? null,
        taskId,
        ...expected,
      );
      return result.changes === 1;
    },
    failInterrupted(updatedAt) {
      const result = db.prepare(`
        UPDATE assistant_tasks
        SET state = 'failed', updated_at = ?, finished_at = ?,
            summary = 'The Mac gateway restarted before a final result. The outcome is unknown; inspect the target before preparing another task.',
            failure_code = 'GATEWAY_RESTART_OUTCOME_UNCERTAIN'
        WHERE state = 'running'
      `).run(updatedAt, updatedAt);
      return result.changes;
    },
  };
}
