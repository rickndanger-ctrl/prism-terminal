export const packageName = '@codex-lens/shared';

export {
  ApprovalStatus,
  ApprovalTargetType,
  approvalContractSchema,
  createApprovalContract,
  parseApprovalContract,
  toJSON as approvalContractToJSON,
  transitionApprovalContract,
} from './approval-contract.js';
export type {
  ApprovalContract,
  ApprovalContractInput,
  ApprovalStatus as ApprovalStatusValue,
  ApprovalTarget,
  ApprovalTargetType as ApprovalTargetTypeValue,
} from './approval-contract.js';
export {
  canApproveEngineeringPlan,
  createExecutionPlanFromApproval,
} from './authorization.js';
export type { AuthorizedExecutionPlanInput } from './authorization.js';
export {
  ConversationSessionSchema,
  createConversationSession,
  hasUnresolvedQuestions,
  transitionConversationSession,
} from './conversation-session.js';
export type {
  ConversationSession,
  ConversationStatus,
  CreateConversationSessionInput,
} from './conversation-session.js';
export { convertConversationToEngineeringPlan } from './conversation-conversion.js';
export type { ConversationConversion } from './conversation-conversion.js';
export { contentDigest } from './digest.js';
export {
  EngineeringPlanStatus,
  createEngineeringPlan,
  engineeringPlanContentDigest,
  engineeringPlanSchema,
  parseEngineeringPlan,
  toJSON as engineeringPlanToJSON,
  transitionEngineeringPlan,
} from './engineering-plan.js';
export type {
  EngineeringPlan,
  EngineeringPlanInput,
  EngineeringPlanStatus as EngineeringPlanStatusValue,
} from './engineering-plan.js';
export {
  createExecutionPlan,
  executionPlanContentDigest,
  ESTIMATE_LEVELS,
  EXECUTION_STATUSES,
  executionPlanSchema,
  parseExecutionPlan,
  transitionExecutionPlan,
  toJSON,
  toJSON as executionPlanToJSON,
} from './execution-plan.js';
export type {
  CreateExecutionPlanInput,
  EstimateLevel,
  ExecutionPlan,
  ExecutionPlanJson,
  ExecutionStatus,
} from './execution-plan.js';
export { approvePlan, requestApproval } from './plan-approval.js';
export type {
  PlanApprovalInput,
  PlanApprovalOutcome,
} from './plan-approval.js';
export {
  loadConversation,
  loadEngineeringPlan,
  saveConversation,
  saveEngineeringPlan,
} from './persistence.js';
export { err, ok } from './result.js';
export type { DomainError, Result } from './result.js';
