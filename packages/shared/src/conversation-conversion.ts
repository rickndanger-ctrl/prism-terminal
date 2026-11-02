import { randomUUID } from 'node:crypto';

import {
  hasUnresolvedQuestions,
  transitionConversationSession,
  type ConversationSession,
} from './conversation-session.js';
import {
  createEngineeringPlan,
  EngineeringPlanStatus,
  type EngineeringPlan,
} from './engineering-plan.js';
import { err, ok, type Result } from './result.js';

export interface ConversationConversion {
  readonly session: ConversationSession;
  readonly plan: EngineeringPlan;
}

export function convertConversationToEngineeringPlan(
  session: ConversationSession,
): Result<ConversationConversion> {
  if (session.conversationStatus !== 'ReadyForPlan') {
    return err(
      'CONVERSATION_NOT_READY_FOR_PLAN',
      `Cannot convert conversation session with status "${session.conversationStatus}"; expected "ReadyForPlan"`,
    );
  }

  if (hasUnresolvedQuestions(session)) {
    return err(
      'UNRESOLVED_OPEN_QUESTIONS',
      'Cannot convert conversation session while open questions remain unresolved',
    );
  }

  const now = new Date().toISOString();
  const planResult = createEngineeringPlan({
    engineeringPlanId: randomUUID(),
    version: 1,
    createdAt: now,
    updatedAt: now,
    projectName: session.projectName,
    featureName: session.projectName,
    objective: session.userGoal,
    background: session.background,
    requirements: [...session.confirmedRequirements],
    constraints: [...session.confirmedConstraints],
    acceptanceCriteria: [...session.confirmedAcceptanceCriteria],
    assumptions: [...session.assumptions],
    risks: [...session.unresolvedRisks],
    status: EngineeringPlanStatus.Draft,
  });
  if (!planResult.ok) return planResult;

  const sessionResult = transitionConversationSession(
    session,
    'ConvertedToEngineeringPlan',
  );
  if (!sessionResult.ok) return sessionResult;

  return ok({ session: sessionResult.value, plan: planResult.value });
}
