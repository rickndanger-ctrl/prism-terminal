import {
  err,
  ok,
  parseExecutionPlan,
  type ExecutionPlan,
  type Result,
} from '@codex-lens/shared';

import type { Db } from './db/schema.js';
import type { ExecutionPlanRequest } from './plan-generation.js';

export interface PreparedExecutionPlan {
  projectId: string;
  idempotencyKey: string;
  request: ExecutionPlanRequest;
  plan: ExecutionPlan;
  createdAt: string;
}

interface PreparedRow {
  execution_plan_id: string;
  project_id: string;
  idempotency_key: string;
  request_json: string;
  plan_json: string;
  created_at: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rowToPrepared(row: PreparedRow): Result<PreparedExecutionPlan> {
  let request: unknown;
  let planValue: unknown;
  try {
    request = JSON.parse(row.request_json);
    planValue = JSON.parse(row.plan_json);
  } catch {
    return err('INVALID_STORED_EXECUTION_PLAN', 'Stored execution plan JSON is invalid');
  }

  const plan = parseExecutionPlan(planValue);
  if (!plan.ok) {
    return err('INVALID_STORED_EXECUTION_PLAN', plan.error.message);
  }
  if (plan.value.executionPlanId !== row.execution_plan_id) {
    return err('INVALID_STORED_EXECUTION_PLAN', 'Stored execution plan id does not match its row');
  }
  if (typeof request !== 'object' || request === null) {
    return err('INVALID_STORED_EXECUTION_PLAN', 'Stored execution request is invalid');
  }

  return ok(Object.freeze({
    projectId: row.project_id,
    idempotencyKey: row.idempotency_key,
    request: Object.freeze({ ...(request as ExecutionPlanRequest) }),
    plan: plan.value,
    createdAt: row.created_at,
  }));
}

export function savePreparedExecutionPlan(
  db: Db,
  input: Omit<PreparedExecutionPlan, 'createdAt'>,
): Result<PreparedExecutionPlan> {
  const createdAt = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO prepared_execution_plans (
         execution_plan_id, project_id, idempotency_key, request_json, plan_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (idempotency_key) DO NOTHING`,
    ).run(
      input.plan.executionPlanId,
      input.projectId,
      input.idempotencyKey,
      JSON.stringify(input.request),
      JSON.stringify(input.plan),
      createdAt,
    );

    return getPreparedExecutionPlanByKey(db, input.idempotencyKey);
  } catch (error) {
    return err('EXECUTION_PLAN_STORE_WRITE_FAILED', errorMessage(error));
  }
}

export function getPreparedExecutionPlan(
  db: Db,
  executionPlanId: string,
): Result<PreparedExecutionPlan> {
  if (executionPlanId.trim().length === 0) {
    return err('INVALID_EXECUTION_PLAN_ID', 'executionPlanId must not be empty');
  }
  try {
    const row = db.prepare(
      `SELECT execution_plan_id, project_id, idempotency_key, request_json, plan_json, created_at
       FROM prepared_execution_plans WHERE execution_plan_id = ?`,
    ).get(executionPlanId) as PreparedRow | undefined;
    return row === undefined
      ? err('EXECUTION_PLAN_NOT_FOUND', `No execution plan with id ${executionPlanId}`)
      : rowToPrepared(row);
  } catch (error) {
    return err('EXECUTION_PLAN_STORE_READ_FAILED', errorMessage(error));
  }
}

function getPreparedExecutionPlanByKey(
  db: Db,
  idempotencyKey: string,
): Result<PreparedExecutionPlan> {
  try {
    const row = db.prepare(
      `SELECT execution_plan_id, project_id, idempotency_key, request_json, plan_json, created_at
       FROM prepared_execution_plans WHERE idempotency_key = ?`,
    ).get(idempotencyKey) as PreparedRow | undefined;
    return row === undefined
      ? err('EXECUTION_PLAN_NOT_FOUND', `No execution plan with idempotency key ${idempotencyKey}`)
      : rowToPrepared(row);
  } catch (error) {
    return err('EXECUTION_PLAN_STORE_READ_FAILED', errorMessage(error));
  }
}
