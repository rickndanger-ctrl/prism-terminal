import { describe, expect, it } from 'vitest';

import {
  ApprovalStatus,
  ApprovalTargetType,
  createApprovalContract,
  type ApprovalContract,
} from './approval-contract.js';
import {
  canApproveEngineeringPlan,
  createExecutionPlanFromApproval,
  type AuthorizedExecutionPlanInput,
} from './authorization.js';
import { contentDigest } from './digest.js';
import {
  createEngineeringPlan,
  EngineeringPlanStatus,
  type EngineeringPlan,
} from './engineering-plan.js';

function mustCreateEngineeringPlan(): EngineeringPlan {
  const result = createEngineeringPlan({
    engineeringPlanId: 'engineering-plan-120',
    version: 3,
    createdAt: '2026-07-14T12:00:00.000Z',
    updatedAt: '2026-07-14T13:00:00.000Z',
    projectName: 'Codex Lens',
    featureName: 'Authorization gate',
    objective: 'Mint execution plans only from valid approvals.',
    background: 'Engineering plans must be approved before implementation.',
    requirements: ['Bind approval to exact current plan content'],
    constraints: ['Never trust a stored digest without recomputing it'],
    acceptanceCriteria: ['A matching approval creates a linked execution plan'],
    assumptions: ['Approval contracts are already schema-valid'],
    risks: ['Edited content could otherwise reuse a stale approval'],
    status: EngineeringPlanStatus.ReadyForApproval,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function mustCreateApproval(
  engineeringPlan: EngineeringPlan,
): ApprovalContract {
  const recomputedDigest = contentDigest({
    projectName: engineeringPlan.projectName,
    featureName: engineeringPlan.featureName,
    objective: engineeringPlan.objective,
    background: engineeringPlan.background,
    requirements: engineeringPlan.requirements,
    constraints: engineeringPlan.constraints,
    acceptanceCriteria: engineeringPlan.acceptanceCriteria,
    assumptions: engineeringPlan.assumptions,
    risks: engineeringPlan.risks,
  });
  expect(recomputedDigest).toBe(engineeringPlan.contentDigest);

  const result = createApprovalContract({
    approvalId: 'approval-120',
    approvedBy: 'reviewer@example.com',
    approvalTimestamp: '2026-07-14T14:00:00.000Z',
    approvalType: 'EngineeringPlanApproval',
    notes: 'Approved for execution planning.',
    approvalStatus: ApprovalStatus.Approved,
    target: {
      targetType: ApprovalTargetType.EngineeringPlan,
      targetId: engineeringPlan.engineeringPlanId,
      targetVersion: engineeringPlan.version,
      targetContentDigest: recomputedDigest,
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const executionInput: AuthorizedExecutionPlanInput = {
  filesToModify: ['packages/shared/src/authorization.ts'],
  filesToCreate: ['packages/shared/src/authorization.test.ts'],
  filesToDelete: [],
  implementationSteps: ['Validate approval binding', 'Create execution plan'],
  expectedCommands: ['npm run typecheck', 'npm test'],
  estimatedRisk: 'Low',
  estimatedComplexity: 'Medium',
  estimatedDuration: 45,
  rollbackStrategy: 'Revert the ticket commit.',
  executionStatus: 'Pending',
};

describe('engineering plan authorization', () => {
  it('accepts a valid approval bound to a fresh digest recomputation', () => {
    const engineeringPlan = mustCreateEngineeringPlan();
    const approval = mustCreateApproval(engineeringPlan);

    expect(canApproveEngineeringPlan(approval, engineeringPlan)).toEqual({
      ok: true,
      value: true,
    });
  });

  it('creates an execution plan linked to the approved engineering plan', () => {
    const engineeringPlan = mustCreateEngineeringPlan();
    const approval = mustCreateApproval(engineeringPlan);

    const result = createExecutionPlanFromApproval(
      approval,
      engineeringPlan,
      executionInput,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.engineeringPlanId).toBe(
      engineeringPlan.engineeringPlanId,
    );
  });
});
