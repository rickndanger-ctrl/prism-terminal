import {
  err,
  ok,
  parseApprovalContract,
  parseEngineeringPlan,
  type ApprovalContract,
  type EngineeringPlan,
  type Result,
} from '@codex-lens/shared';

import type { Db } from './db/schema.js';

export interface PreparedEngineeringPlan {
  projectId: string;
  idempotencyKey: string;
  plan: EngineeringPlan;
  approval?: ApprovalContract;
  createdAt: string;
  updatedAt: string;
}

interface EngineeringPlanRow {
  engineering_plan_id: string;
  project_id: string;
  idempotency_key: string;
  plan_json: string;
  approval_json: string | null;
  created_at: string;
  updated_at: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fromRow(row: EngineeringPlanRow): Result<PreparedEngineeringPlan> {
  const plan = parseEngineeringPlan(row.plan_json);
  if (!plan.ok) {
    return err('INVALID_STORED_ENGINEERING_PLAN', plan.error.message);
  }
  if (plan.value.engineeringPlanId !== row.engineering_plan_id) {
    return err('INVALID_STORED_ENGINEERING_PLAN', 'Stored engineering plan id does not match its row');
  }

  let approval: ApprovalContract | undefined;
  if (row.approval_json !== null) {
    const parsed = parseApprovalContract(row.approval_json);
    if (!parsed.ok) {
      return err('INVALID_STORED_ENGINEERING_PLAN', parsed.error.message);
    }
    approval = parsed.value;
  }

  return ok(Object.freeze({
    projectId: row.project_id,
    idempotencyKey: row.idempotency_key,
    plan: plan.value,
    ...(approval === undefined ? {} : { approval }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

const SELECT = `SELECT engineering_plan_id, project_id, idempotency_key,
  plan_json, approval_json, created_at, updated_at
  FROM prepared_engineering_plans`;

export function saveEngineeringPlan(
  db: Db,
  input: Omit<PreparedEngineeringPlan, 'createdAt' | 'updatedAt'>,
): Result<PreparedEngineeringPlan> {
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO prepared_engineering_plans (
        engineering_plan_id, project_id, idempotency_key, plan_json,
        approval_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (idempotency_key) DO NOTHING`,
    ).run(
      input.plan.engineeringPlanId,
      input.projectId,
      input.idempotencyKey,
      JSON.stringify(input.plan),
      input.approval === undefined ? null : JSON.stringify(input.approval),
      now,
      now,
    );
    return getEngineeringPlanByKey(db, input.idempotencyKey);
  } catch (error) {
    return err('ENGINEERING_PLAN_STORE_WRITE_FAILED', message(error));
  }
}

export function updateEngineeringPlanApproval(
  db: Db,
  engineeringPlanId: string,
  plan: EngineeringPlan,
  approval: ApprovalContract,
): Result<PreparedEngineeringPlan> {
  const now = new Date().toISOString();
  try {
    const result = db.prepare(
      `UPDATE prepared_engineering_plans
       SET plan_json = ?, approval_json = ?, updated_at = ?
       WHERE engineering_plan_id = ? AND approval_json IS NULL`,
    ).run(JSON.stringify(plan), JSON.stringify(approval), now, engineeringPlanId);
    if (result.changes !== 1) {
      return err('ENGINEERING_PLAN_ALREADY_RESOLVED', 'Engineering plan approval is already resolved');
    }
    return getEngineeringPlan(db, engineeringPlanId);
  } catch (error) {
    return err('ENGINEERING_PLAN_STORE_WRITE_FAILED', message(error));
  }
}

export function getEngineeringPlan(
  db: Db,
  engineeringPlanId: string,
): Result<PreparedEngineeringPlan> {
  if (engineeringPlanId.trim().length === 0) {
    return err('INVALID_ENGINEERING_PLAN_ID', 'engineeringPlanId must not be empty');
  }
  try {
    const row = db.prepare(`${SELECT} WHERE engineering_plan_id = ?`).get(
      engineeringPlanId,
    ) as EngineeringPlanRow | undefined;
    return row === undefined
      ? err('ENGINEERING_PLAN_NOT_FOUND', `No engineering plan with id ${engineeringPlanId}`)
      : fromRow(row);
  } catch (error) {
    return err('ENGINEERING_PLAN_STORE_READ_FAILED', message(error));
  }
}

function getEngineeringPlanByKey(
  db: Db,
  idempotencyKey: string,
): Result<PreparedEngineeringPlan> {
  try {
    const row = db.prepare(`${SELECT} WHERE idempotency_key = ?`).get(
      idempotencyKey,
    ) as EngineeringPlanRow | undefined;
    return row === undefined
      ? err('ENGINEERING_PLAN_NOT_FOUND', `No engineering plan with idempotency key ${idempotencyKey}`)
      : fromRow(row);
  } catch (error) {
    return err('ENGINEERING_PLAN_STORE_READ_FAILED', message(error));
  }
}
