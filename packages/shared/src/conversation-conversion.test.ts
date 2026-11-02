import { describe, expect, it } from 'vitest';

import { convertConversationToEngineeringPlan } from './conversation-conversion.js';
import {
  createConversationSession,
  type ConversationSession,
  type CreateConversationSessionInput,
} from './conversation-session.js';
import { EngineeringPlanStatus } from './engineering-plan.js';

const validInput: CreateConversationSessionInput = {
  conversationId: 'conversation-126',
  conversationStatus: 'ReadyForPlan',
  projectName: 'Codex Lens',
  userGoal: 'Turn a clarified conversation into an engineering plan.',
  background: 'The user and AI engineer refined the work before planning.',
  openQuestions: [
    {
      id: 'question-1',
      question: 'Which platforms must be supported?',
      answer: 'macOS and Linux',
    },
  ],
  confirmedRequirements: ['Capture the user goal', 'Create a Draft plan'],
  confirmedConstraints: ['Never throw for invalid input'],
  confirmedAcceptanceCriteria: ['The plan carries all confirmed content'],
  assumptions: ['The conversation content has been confirmed'],
  unresolvedRisks: ['Requirements may change after conversion'],
};

function makeSession(
  overrides: Partial<CreateConversationSessionInput> = {},
): ConversationSession {
  const result = createConversationSession({ ...validInput, ...overrides });
  if (!result.ok) {
    throw new Error(`test setup failed: ${result.error.message}`);
  }
  return result.value;
}

describe('convertConversationToEngineeringPlan', () => {
  it('converts a ready, resolved conversation into a Draft engineering plan', () => {
    const original = makeSession();
    const result = convertConversationToEngineeringPlan(original);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.session.conversationStatus).toBe(
      'ConvertedToEngineeringPlan',
    );
    expect(original.conversationStatus).toBe('ReadyForPlan');

    const { plan } = result.value;
    expect(plan.status).toBe(EngineeringPlanStatus.Draft);
    expect(plan.engineeringPlanId).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.version).toBe(1);
    expect(plan.createdAt).toBe(plan.updatedAt);
    expect(plan.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan).toMatchObject({
      projectName: validInput.projectName,
      featureName: validInput.projectName,
      objective: validInput.userGoal,
      background: validInput.background,
      requirements: validInput.confirmedRequirements,
      constraints: validInput.confirmedConstraints,
      acceptanceCriteria: validInput.confirmedAcceptanceCriteria,
      assumptions: validInput.assumptions,
      risks: validInput.unresolvedRisks,
    });
  });

  it('rejects conversion unless the session is ReadyForPlan', () => {
    const result = convertConversationToEngineeringPlan(
      makeSession({ conversationStatus: 'Clarifying' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONVERSATION_NOT_READY_FOR_PLAN');
  });

  it('rejects conversion when an open question remains unresolved', () => {
    const result = convertConversationToEngineeringPlan(
      makeSession({
        openQuestions: [
          {
            id: 'question-1',
            question: 'Which platforms must be supported?',
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('UNRESOLVED_OPEN_QUESTIONS');
  });
});
