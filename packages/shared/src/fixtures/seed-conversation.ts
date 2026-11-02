import {
  createConversationSession,
  type ConversationSession,
} from '../conversation-session.js';

export interface ResolvedAnswer {
  readonly id: string;
  readonly answer: string;
}

export const resolvedAnswers: readonly ResolvedAnswer[] = Object.freeze([
  Object.freeze({
    id: 'supported-platforms',
    answer: 'Support the latest stable versions of Chrome, Firefox, and Safari.',
  }),
  Object.freeze({
    id: 'retention-period',
    answer: 'Retain completed conversation sessions for 90 days.',
  }),
]);

export function makeSeedConversation(): ConversationSession {
  const result = createConversationSession({
    conversationId: 'seed-conversation-session',
    projectName: 'Codex Lens',
    userGoal:
      'Turn a clarified product conversation into a reviewable Engineering Plan.',
    background:
      'Product owners need a reliable way to capture intent, resolve important unknowns, and hand complete requirements to an AI engineering workflow.',
    openQuestions: [
      {
        id: 'supported-platforms',
        question: 'Which browser platforms must the first release support?',
      },
      {
        id: 'retention-period',
        question: 'How long should completed conversation sessions be retained?',
      },
    ],
    confirmedRequirements: [
      'Capture the project name, user goal, and relevant background.',
      'Track open questions and their answers before planning begins.',
      'Convert a ready conversation into an immutable Engineering Plan.',
    ],
    confirmedConstraints: [
      'Use the existing shared TypeScript domain models and Zod validation.',
      'Do not allow plan conversion while any open question is unanswered.',
    ],
    confirmedAcceptanceCriteria: [
      'A complete conversation can transition to ReadyForPlan.',
      'The converted Engineering Plan preserves requirements, constraints, assumptions, acceptance criteria, and risks.',
      'Invalid or incomplete conversation data returns a typed error instead of throwing.',
    ],
    assumptions: [
      'The first release has one active conversation per planned feature.',
      'Authenticated product owners are allowed to answer open questions.',
    ],
    unresolvedRisks: [
      'Late requirement changes could invalidate an Engineering Plan awaiting approval.',
      'Retention requirements may change after privacy review.',
    ],
    conversationStatus: 'Draft',
  });

  if (!result.ok) {
    throw new Error(`Invalid seed conversation: ${result.error.message}`);
  }

  return result.value;
}
