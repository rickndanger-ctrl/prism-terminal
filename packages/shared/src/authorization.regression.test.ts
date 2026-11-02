import { describe, expect, it } from 'vitest';

import {
  ApprovalStatus,
  ApprovalTargetType,
  createApprovalContract,
  type ApprovalContract,
  type ApprovalContractInput,
} from './approval-contract.js';
import {
  createExecutionPlanFromApproval,
  type AuthorizedExecutionPlanInput,
} from './authorization.js';
import {
  createEngineeringPlan,
  EngineeringPlanStatus,
  type EngineeringPlan,
  type EngineeringPlanInput,
} from './engineering-plan.js';

function mustCreateEngineeringPlan(
  overrides: Partial<EngineeringPlanInput> = {},
): EngineeringPlan {
  const result = createEngineeringPlan({
    engineeringPlanId: 'engineering-plan-121',
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
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function mustCreateApproval(
  engineeringPlan: EngineeringPlan,
  overrides: Partial<ApprovalContractInput> = {},
): ApprovalContract {
  const result = createApprovalContract({
    approvalId: 'approval-121',
    approvedBy: 'reviewer@example.com',
    approvalTimestamp: '2026-07-14T14:00:00.000Z',
    approvalType: 'EngineeringPlanApproval',
    notes: 'Recorded against the current plan content.',
    approvalStatus: ApprovalStatus.Approved,
    target: {
      targetType: ApprovalTargetType.EngineeringPlan,
      targetId: engineeringPlan.engineeringPlanId,
      targetVersion: engineeringPlan.version,
      targetContentDigest: engineeringPlan.contentDigest,
    },
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const executionInput: AuthorizedExecutionPlanInput = {
  filesToModify: ['packages/shared/src/authorization.ts'],
  filesToCreate: ['packages/shared/src/authorization.regression.test.ts'],
  filesToDelete: [],
  implementationSteps: ['Validate approval binding', 'Create execution plan'],
  expectedCommands: ['npm run typecheck', 'npm test'],
  estimatedRisk: 'Low',
  estimatedComplexity: 'Medium',
  estimatedDuration: 45,
  rollbackStrategy: 'Revert the ticket commit.',
  executionStatus: 'Pending',
};

function expectRejection(
  approval: ApprovalContract,
  engineeringPlan: EngineeringPlan,
  expectedCode: string,
): void {
  const result = createExecutionPlanFromApproval(
    approval,
    engineeringPlan,
    executionInput,
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(expectedCode);
}

describe('authorization gate regression suite', () => {
  it('rejects an approval whose target version is stale', () => {
    const approvedPlan = mustCreateEngineeringPlan({ version: 3 });
    const approval = mustCreateApproval(approvedPlan);
    const revisedPlan = mustCreateEngineeringPlan({
      version: 4,
      updatedAt: '2026-07-14T15:00:00.000Z',
    });

    expectRejection(
      approval,
      revisedPlan,
      'AUTHORIZATION_TARGET_VERSION_MISMATCH',
    );
  });

  it('rejects an approval when the plan content was edited after approval', () => {
    const approvedPlan = mustCreateEngineeringPlan();
    const approval = mustCreateApproval(approvedPlan);
    const editedPlan = mustCreateEngineeringPlan({
      objective: 'Mint execution plans from any approval, even edited ones.',
    });

    expect(editedPlan.version).toBe(approvedPlan.version);
    expect(editedPlan.contentDigest).not.toBe(approvedPlan.contentDigest);

    expectRejection(
      approval,
      editedPlan,
      'AUTHORIZATION_TARGET_CONTENT_DIGEST_MISMATCH',
    );
  });

  it('rejects an approval whose target type is ExecutionPlan', () => {
    const engineeringPlan = mustCreateEngineeringPlan();
    const approval = mustCreateApproval(engineeringPlan, {
      target: {
        targetType: ApprovalTargetType.ExecutionPlan,
        targetId: engineeringPlan.engineeringPlanId,
        targetVersion: engineeringPlan.version,
        targetContentDigest: engineeringPlan.contentDigest,
      },
    });

    expectRejection(
      approval,
      engineeringPlan,
      'AUTHORIZATION_TARGET_TYPE_MISMATCH',
    );
  });

  it('rejects a Pending approval', () => {
    const engineeringPlan = mustCreateEngineeringPlan();
    const approval = mustCreateApproval(engineeringPlan, {
      approvalStatus: ApprovalStatus.Pending,
    });

    expectRejection(
      approval,
      engineeringPlan,
      'AUTHORIZATION_APPROVAL_NOT_APPROVED',
    );
  });

  it('rejects a Rejected approval', () => {
    const engineeringPlan = mustCreateEngineeringPlan();
    const approval = mustCreateApproval(engineeringPlan, {
      approvalStatus: ApprovalStatus.Rejected,
    });

    expectRejection(
      approval,
      engineeringPlan,
      'AUTHORIZATION_APPROVAL_NOT_APPROVED',
    );
  });

  it('rejects a Cancelled approval', () => {
    const engineeringPlan = mustCreateEngineeringPlan();
    const approval = mustCreateApproval(engineeringPlan, {
      approvalStatus: ApprovalStatus.Cancelled,
    });

    expectRejection(
      approval,
      engineeringPlan,
      'AUTHORIZATION_APPROVAL_NOT_APPROVED',
    );
  });
});
