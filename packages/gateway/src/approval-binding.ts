import {
  ApprovalStatus,
  ApprovalTargetType,
  err,
  executionPlanContentDigest,
  ok,
  type ApprovalContract,
  type ExecutionPlan,
  type Result,
} from '@codex-lens/shared';

/**
 * Proves that an execution approval authorizes this exact execution plan.
 * This check must run immediately before any Codex edit is started.
 */
export function assertExecutionApproved(
  plan: ExecutionPlan,
  approval: ApprovalContract,
): Result<void> {
  if (approval.approvalStatus !== ApprovalStatus.Approved) {
    return err(
      'EXECUTION_APPROVAL_NOT_APPROVED',
      `Approval status must be "${ApprovalStatus.Approved}", got "${approval.approvalStatus}"`,
    );
  }

  if (approval.target.targetType !== ApprovalTargetType.ExecutionPlan) {
    return err(
      'EXECUTION_APPROVAL_TARGET_TYPE_MISMATCH',
      `Approval target type must be "${ApprovalTargetType.ExecutionPlan}", got "${approval.target.targetType}"`,
    );
  }

  if (approval.target.targetId !== plan.executionPlanId) {
    return err(
      'EXECUTION_APPROVAL_TARGET_ID_MISMATCH',
      `Approval target id "${approval.target.targetId}" does not match execution plan id "${plan.executionPlanId}"`,
    );
  }

  if (approval.target.targetVersion !== plan.version) {
    return err(
      'EXECUTION_APPROVAL_TARGET_VERSION_MISMATCH',
      `Approval target version ${approval.target.targetVersion} does not match execution plan version ${plan.version}`,
    );
  }

  const currentContentDigest = executionPlanContentDigest(plan);
  if (approval.target.targetContentDigest !== currentContentDigest) {
    return err(
      'EXECUTION_APPROVAL_TARGET_CONTENT_DIGEST_MISMATCH',
      'Approval target content digest does not match the digest recomputed from the current execution plan content',
    );
  }

  return ok(undefined);
}
