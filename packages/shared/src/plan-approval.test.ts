import { describe, expect, it } from 'vitest';

import { ApprovalStatus, ApprovalTargetType } from './approval-contract.js';
import {
  EngineeringPlanStatus,
  createEngineeringPlan,
  type EngineeringPlan,
  type EngineeringPlanInput,
} from './engineering-plan.js';
import {
  approvePlan,
  requestApproval,
  type PlanApprovalInput,
} from './plan-approval.js';

const planInput: EngineeringPlanInput = {
  engineeringPlanId: 'plan-127',
  version: 1,
  createdAt: '2026-07-14T12:00:00.000Z',
  updatedAt: '2026-07-14T12:00:00.000Z',
  projectName: 'Codex Lens',
  featureName: 'Approval gate',
  objective: 'Gate plan approval behind a pinned approval contract.',
  background: 'Approvals must bind to the exact reviewed content.',
  requirements: ['Pin version and digest', 'Reject stale approvals'],
  constraints: ['Reuse M0 verification logic'],
  acceptanceCriteria: ['Only correctly pinned approvals advance the plan'],
  assumptions: ['The caller supplies identity and timestamps'],
  risks: ['A stale approval could authorize changed content'],
  status: EngineeringPlanStatus.Draft,
};

const approvalInput: PlanApprovalInput = {
  approvalId: 'approval-127',
  approvedBy: 'reviewer@example.com',
  approvalTimestamp: '2026-07-14T13:00:00.000Z',
  approvalType: 'EngineeringPlanApproval',
  notes: 'Looks good.',
};

function draftPlan(): EngineeringPlan {
  const result = createEngineeringPlan(planInput);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function readyPlan(): EngineeringPlan {
  const result = requestApproval(draftPlan());
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('requestApproval', () => {
  it('transitions a Draft plan to ReadyForApproval', () => {
    const result = requestApproval(draftPlan());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe(EngineeringPlanStatus.ReadyForApproval);
  });

  it('rejects a plan that is not in Draft', () => {
    const result = requestApproval(readyPlan());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ILLEGAL_ENGINEERING_PLAN_TRANSITION');
  });
});

describe('approvePlan', () => {
  it('rejects a Draft plan going directly to Approved', () => {
    const plan = draftPlan();
    const result = approvePlan(plan, approvalInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ILLEGAL_ENGINEERING_PLAN_TRANSITION');
    expect(plan.status).toBe(EngineeringPlanStatus.Draft);
  });

  it('rejects an approval pinned to a stale version and leaves the plan unchanged', () => {
    const plan = readyPlan();
    const result = approvePlan(plan, {
      ...approvalInput,
      pinnedVersion: plan.version + 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTHORIZATION_TARGET_VERSION_MISMATCH');
    expect(plan.status).toBe(EngineeringPlanStatus.ReadyForApproval);
  });

  it('rejects an approval pinned to a wrong content digest and leaves the plan unchanged', () => {
    const plan = readyPlan();
    const result = approvePlan(plan, {
      ...approvalInput,
      pinnedContentDigest: 'f'.repeat(64),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(
      'AUTHORIZATION_TARGET_CONTENT_DIGEST_MISMATCH',
    );
    expect(plan.status).toBe(EngineeringPlanStatus.ReadyForApproval);
  });

  it('advances a ReadyForApproval plan with a correctly pinned approval', () => {
    const plan = readyPlan();
    const result = approvePlan(plan, approvalInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.plan.status).toBe(EngineeringPlanStatus.Approved);
    expect(result.value.approval.approvalStatus).toBe(ApprovalStatus.Approved);
    expect(result.value.approval.target).toEqual({
      targetType: ApprovalTargetType.EngineeringPlan,
      targetId: plan.engineeringPlanId,
      targetVersion: plan.version,
      targetContentDigest: plan.contentDigest,
    });
  });

  it('requires passing through ReadyForApproval to reach Approved', () => {
    const requested = requestApproval(draftPlan());
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const result = approvePlan(requested.value, approvalInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plan.status).toBe(EngineeringPlanStatus.Approved);
  });
});
