import { describe, expect, it } from 'vitest';

import {
  ApprovalStatus,
  ApprovalTargetType,
  createApprovalContract,
  createExecutionPlan,
  type ApprovalContract,
  type ApprovalContractInput,
  type ExecutionPlan,
} from '@codex-lens/shared';

import { assertExecutionApproved } from '../src/approval-binding.js';

function mustCreatePlan(): ExecutionPlan {
  const result = createExecutionPlan({
    engineeringPlanId: 'engineering-plan-150',
    filesToModify: ['packages/gateway/src/approval-binding.ts'],
    filesToCreate: ['packages/gateway/test/approval-binding.test.ts'],
    filesToDelete: [],
    implementationSteps: ['Bind execution approval to the exact plan'],
    expectedCommands: ['npm test -w @codex-lens/gateway'],
    estimatedRisk: 'Low',
    estimatedComplexity: 'Low',
    estimatedDuration: 30,
    rollbackStrategy: 'Revert the ticket commit.',
    executionStatus: 'Ready',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function mustCreateApproval(
  plan: ExecutionPlan,
  overrides: Partial<ApprovalContractInput> = {},
): ApprovalContract {
  const result = createApprovalContract({
    approvalId: 'approval-150',
    approvedBy: 'reviewer@example.com',
    approvalTimestamp: '2026-07-14T20:00:00.000Z',
    approvalType: 'ExecutionPlanApproval',
    notes: 'Approved for Codex execution.',
    approvalStatus: ApprovalStatus.Approved,
    target: {
      targetType: ApprovalTargetType.ExecutionPlan,
      targetId: plan.executionPlanId,
      targetVersion: plan.version,
      targetContentDigest: plan.contentDigest,
    },
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function expectFailure(
  plan: ExecutionPlan,
  approval: ApprovalContract,
  code: string,
): void {
  const result = assertExecutionApproved(plan, approval);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
}

describe('assertExecutionApproved', () => {
  it('accepts an Approved approval matching the exact execution plan', () => {
    const plan = mustCreatePlan();

    expect(assertExecutionApproved(plan, mustCreateApproval(plan))).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('rejects a stale content digest', () => {
    const plan = mustCreatePlan();
    const approval = mustCreateApproval(plan, {
      target: {
        targetType: ApprovalTargetType.ExecutionPlan,
        targetId: plan.executionPlanId,
        targetVersion: plan.version,
        targetContentDigest: '0'.repeat(64),
      },
    });

    expectFailure(
      plan,
      approval,
      'EXECUTION_APPROVAL_TARGET_CONTENT_DIGEST_MISMATCH',
    );
  });

  it('rejects a mismatched plan version', () => {
    const plan = mustCreatePlan();
    const approval = mustCreateApproval(plan, {
      target: {
        targetType: ApprovalTargetType.ExecutionPlan,
        targetId: plan.executionPlanId,
        targetVersion: plan.version + 1,
        targetContentDigest: plan.contentDigest,
      },
    });

    expectFailure(plan, approval, 'EXECUTION_APPROVAL_TARGET_VERSION_MISMATCH');
  });

  it('rejects a stale version even when the content digest is unchanged', () => {
    const plan = mustCreatePlan();
    const approval = mustCreateApproval(plan, {
      target: {
        targetType: ApprovalTargetType.ExecutionPlan,
        targetId: plan.executionPlanId,
        targetVersion: plan.version + 1,
        targetContentDigest: plan.contentDigest,
      },
    });

    expectFailure(plan, approval, 'EXECUTION_APPROVAL_TARGET_VERSION_MISMATCH');
  });

  it('recomputes the plan digest instead of trusting its stored digest', () => {
    const plan = mustCreatePlan();
    const approval = mustCreateApproval(plan);
    const editedPlan = {
      ...plan,
      implementationSteps: ['Run unapproved implementation steps'],
    } as ExecutionPlan;

    expectFailure(
      editedPlan,
      approval,
      'EXECUTION_APPROVAL_TARGET_CONTENT_DIGEST_MISMATCH',
    );
  });

  it('rejects a non-Approved status', () => {
    const plan = mustCreatePlan();
    const approval = mustCreateApproval(plan, {
      approvalStatus: ApprovalStatus.Pending,
    });

    expectFailure(plan, approval, 'EXECUTION_APPROVAL_NOT_APPROVED');
  });

  it('rejects the wrong target type', () => {
    const plan = mustCreatePlan();
    const approval = mustCreateApproval(plan, {
      target: {
        targetType: ApprovalTargetType.EngineeringPlan,
        targetId: plan.executionPlanId,
        targetVersion: plan.version,
        targetContentDigest: plan.contentDigest,
      },
    });

    expectFailure(plan, approval, 'EXECUTION_APPROVAL_TARGET_TYPE_MISMATCH');
  });

  it('rejects an approval for a different execution plan id', () => {
    const plan = mustCreatePlan();
    const approval = mustCreateApproval(plan, {
      target: {
        targetType: ApprovalTargetType.ExecutionPlan,
        targetId: 'different-execution-plan',
        targetVersion: plan.version,
        targetContentDigest: plan.contentDigest,
      },
    });

    expectFailure(plan, approval, 'EXECUTION_APPROVAL_TARGET_ID_MISMATCH');
  });
});
