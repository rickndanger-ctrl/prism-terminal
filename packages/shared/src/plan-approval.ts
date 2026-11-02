import {
  ApprovalStatus,
  ApprovalTargetType,
  createApprovalContract,
  transitionApprovalContract,
  type ApprovalContract,
} from './approval-contract.js';
import { canApproveEngineeringPlan } from './authorization.js';
import {
  EngineeringPlanStatus,
  transitionEngineeringPlan,
  type EngineeringPlan,
} from './engineering-plan.js';
import { ok, type Result } from './result.js';

export interface PlanApprovalInput {
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly approvalTimestamp: string;
  readonly approvalType: string;
  readonly notes: string;
  /** Version the approval was granted against; defaults to the plan's current version. */
  readonly pinnedVersion?: number;
  /** Content digest the approval was granted against; defaults to the plan's current digest. */
  readonly pinnedContentDigest?: string;
}

export interface PlanApprovalOutcome {
  readonly plan: EngineeringPlan;
  readonly approval: ApprovalContract;
}

export function requestApproval(
  plan: EngineeringPlan,
): Result<EngineeringPlan> {
  return transitionEngineeringPlan(
    plan,
    EngineeringPlanStatus.ReadyForApproval,
  );
}

export function approvePlan(
  plan: EngineeringPlan,
  approvalInput: PlanApprovalInput,
): Result<PlanApprovalOutcome> {
  const { pinnedVersion, pinnedContentDigest, ...approvalFields } =
    approvalInput;

  const created = createApprovalContract({
    ...approvalFields,
    approvalStatus: ApprovalStatus.Pending,
    target: {
      targetType: ApprovalTargetType.EngineeringPlan,
      targetId: plan.engineeringPlanId,
      targetVersion: pinnedVersion ?? plan.version,
      targetContentDigest: pinnedContentDigest ?? plan.contentDigest,
    },
  });
  if (!created.ok) return created;

  const binding = canApproveEngineeringPlan(created.value, plan);
  if (!binding.ok) return binding;

  const transitioned = transitionEngineeringPlan(
    plan,
    EngineeringPlanStatus.Approved,
  );
  if (!transitioned.ok) return transitioned;

  const approved = transitionApprovalContract(
    created.value,
    ApprovalStatus.Approved,
  );
  if (!approved.ok) return approved;

  return ok({ plan: transitioned.value, approval: approved.value });
}
