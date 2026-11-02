import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  approvePlan,
  ApprovalStatus,
  ApprovalTargetType,
  ConversationSessionSchema,
  contentDigest,
  createApprovalContract,
  createConversationSession,
  createEngineeringPlan,
  createExecutionPlanFromApproval,
  convertConversationToEngineeringPlan,
  EngineeringPlanStatus,
  hasUnresolvedQuestions,
  loadConversation,
  loadEngineeringPlan,
  requestApproval,
  saveConversation,
  saveEngineeringPlan,
  transitionConversationSession,
  transitionEngineeringPlan,
} from '@codex-lens/shared';
import type { ConversationSession } from '@codex-lens/shared';

describe('@codex-lens/shared', () => {
  it('exports the M1 public API through the package entry point', () => {
    expect(ConversationSessionSchema).toBeDefined();
    expectTypeOf<ConversationSession>().toHaveProperty('conversationId');

    const functions = [
      createConversationSession,
      hasUnresolvedQuestions,
      transitionConversationSession,
      convertConversationToEngineeringPlan,
      requestApproval,
      approvePlan,
      saveConversation,
      loadConversation,
      saveEngineeringPlan,
      loadEngineeringPlan,
    ];

    for (const exportedFunction of functions) {
      expect(typeof exportedFunction).toBe('function');
    }
  });

  it('mints an execution plan through the public package entry point', () => {
    const createdPlan = createEngineeringPlan({
      engineeringPlanId: 'engineering-plan-122',
      version: 1,
      createdAt: '2026-07-14T12:00:00.000Z',
      updatedAt: '2026-07-14T12:00:00.000Z',
      projectName: 'Codex Lens',
      featureName: 'Shared package barrel',
      objective: 'Expose the shared domain API from one package entry point.',
      background: 'Consumers should not import internal source modules.',
      requirements: ['Export models and authorization helpers'],
      constraints: ['Use the package entry point exclusively'],
      acceptanceCriteria: ['An approved plan mints an execution plan'],
      assumptions: ['Workspace package self-references resolve through exports'],
      risks: ['A missing barrel export can break downstream consumers'],
      status: EngineeringPlanStatus.Draft,
    });
    expect(createdPlan.ok).toBe(true);
    if (!createdPlan.ok) return;

    const readyPlan = transitionEngineeringPlan(
      createdPlan.value,
      EngineeringPlanStatus.ReadyForApproval,
    );
    expect(readyPlan.ok).toBe(true);
    if (!readyPlan.ok) return;

    const approvedPlan = transitionEngineeringPlan(
      readyPlan.value,
      EngineeringPlanStatus.Approved,
    );
    expect(approvedPlan.ok).toBe(true);
    if (!approvedPlan.ok) return;

    const planDigest = contentDigest({
      projectName: approvedPlan.value.projectName,
      featureName: approvedPlan.value.featureName,
      objective: approvedPlan.value.objective,
      background: approvedPlan.value.background,
      requirements: approvedPlan.value.requirements,
      constraints: approvedPlan.value.constraints,
      acceptanceCriteria: approvedPlan.value.acceptanceCriteria,
      assumptions: approvedPlan.value.assumptions,
      risks: approvedPlan.value.risks,
    });
    const approval = createApprovalContract({
      approvalId: 'approval-122',
      approvedBy: 'reviewer@example.com',
      approvalTimestamp: '2026-07-14T13:00:00.000Z',
      approvalType: 'EngineeringPlanApproval',
      notes: 'Approved for execution.',
      approvalStatus: ApprovalStatus.Approved,
      target: {
        targetType: ApprovalTargetType.EngineeringPlan,
        targetId: approvedPlan.value.engineeringPlanId,
        targetVersion: approvedPlan.value.version,
        targetContentDigest: planDigest,
      },
    });
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;

    const executionPlan = createExecutionPlanFromApproval(
      approval.value,
      approvedPlan.value,
      {
        filesToModify: ['packages/shared/src/index.ts'],
        filesToCreate: [],
        filesToDelete: [],
        implementationSteps: ['Publish the shared package barrel'],
        expectedCommands: ['npm run typecheck', 'npm test'],
        estimatedRisk: 'Low',
        estimatedComplexity: 'Low',
        estimatedDuration: 15,
        rollbackStrategy: 'Revert the package barrel commit.',
      },
    );

    expect(executionPlan.ok).toBe(true);
    if (!executionPlan.ok) return;
    expect(executionPlan.value.engineeringPlanId).toBe(
      approvedPlan.value.engineeringPlanId,
    );
  });
});
