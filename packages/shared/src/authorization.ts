import {
  ApprovalStatus,
  ApprovalTargetType,
  type ApprovalContract,
} from './approval-contract.js';
import {
  engineeringPlanContentDigest,
  type EngineeringPlan,
} from './engineering-plan.js';
import {
  createExecutionPlan,
  type CreateExecutionPlanInput,
  type ExecutionPlan,
} from './execution-plan.js';
import { err, ok, type Result } from './result.js';

export type AuthorizedExecutionPlanInput = Omit<
  CreateExecutionPlanInput,
  'engineeringPlanId'
>;

function verifyEngineeringPlanBinding(
  approval: ApprovalContract,
  engineeringPlan: EngineeringPlan,
): Result<true> {
  if (approval.target.targetType !== ApprovalTargetType.EngineeringPlan) {
    return err(
      'AUTHORIZATION_TARGET_TYPE_MISMATCH',
      `Approval target type must be "${ApprovalTargetType.EngineeringPlan}", got "${approval.target.targetType}"`,
    );
  }

  if (approval.target.targetId !== engineeringPlan.engineeringPlanId) {
    return err(
      'AUTHORIZATION_TARGET_ID_MISMATCH',
      `Approval target id "${approval.target.targetId}" does not match engineering plan id "${engineeringPlan.engineeringPlanId}"`,
    );
  }

  if (approval.target.targetVersion !== engineeringPlan.version) {
    return err(
      'AUTHORIZATION_TARGET_VERSION_MISMATCH',
      `Approval target version ${approval.target.targetVersion} does not match current engineering plan version ${engineeringPlan.version}`,
    );
  }

  const currentContentDigest = engineeringPlanContentDigest(engineeringPlan);
  if (approval.target.targetContentDigest !== currentContentDigest) {
    return err(
      'AUTHORIZATION_TARGET_CONTENT_DIGEST_MISMATCH',
      'Approval target content digest does not match the digest recomputed from the current engineering plan content',
    );
  }

  return ok(true);
}

export function canApproveEngineeringPlan(
  approval: ApprovalContract,
  engineeringPlan: EngineeringPlan,
): Result<true> {
  return verifyEngineeringPlanBinding(approval, engineeringPlan);
}

export function createExecutionPlanFromApproval(
  approval: ApprovalContract,
  engineeringPlan: EngineeringPlan,
  input: AuthorizedExecutionPlanInput,
): Result<ExecutionPlan> {
  if (approval.approvalStatus !== ApprovalStatus.Approved) {
    return err(
      'AUTHORIZATION_APPROVAL_NOT_APPROVED',
      `Approval status must be "${ApprovalStatus.Approved}", got "${approval.approvalStatus}"`,
    );
  }

  const binding = verifyEngineeringPlanBinding(approval, engineeringPlan);
  if (!binding.ok) return binding;

  return createExecutionPlan({
    ...input,
    engineeringPlanId: engineeringPlan.engineeringPlanId,
  });
}
