import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConversationSessionSchema,
  createConversationSession,
  hasUnresolvedQuestions,
  transitionConversationSession,
  type ConversationSession,
  type ConversationStatus,
  type CreateConversationSessionInput,
} from './conversation-session.js';

const validInput: CreateConversationSessionInput = {
  projectName: 'Codex Lens',
  userGoal: 'Turn a clarified conversation into an engineering plan.',
  background: 'The user and AI engineer refine the work before planning.',
  openQuestions: [
    {
      id: 'question-1',
      question: 'Which platforms must be supported?',
    },
  ],
  confirmedRequirements: ['Capture the user goal'],
  confirmedConstraints: ['Never throw for invalid input'],
  confirmedAcceptanceCriteria: ['Valid sessions pass schema validation'],
  assumptions: ['The caller provides the conversation content'],
  unresolvedRisks: ['Requirements may still change'],
};

describe('createConversationSession', () => {
  it('creates a valid frozen session with generated metadata and Draft status', () => {
    const result = createConversationSession(validInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(ConversationSessionSchema.safeParse(result.value).success).toBe(
      true,
    );
    expect(result.value.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.value.createdAt).toBe(result.value.updatedAt);
    expect(result.value.conversationStatus).toBe('Draft');
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.openQuestions)).toBe(true);
    expect(Object.isFrozen(result.value.openQuestions[0])).toBe(true);
    expect(Object.isFrozen(result.value.confirmedRequirements)).toBe(true);
  });

  it('preserves a supplied conversationId and status', () => {
    const result = createConversationSession({
      ...validInput,
      conversationId: 'conversation-124',
      conversationStatus: 'Clarifying',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.conversationId).toBe('conversation-124');
    expect(result.value.conversationStatus).toBe('Clarifying');
  });

  it('returns an error instead of throwing when userGoal is missing', () => {
    const invalidInput = { ...validInput } as Record<string, unknown>;
    delete invalidInput.userGoal;

    expect(() =>
      createConversationSession(
        invalidInput as unknown as CreateConversationSessionInput,
      ),
    ).not.toThrow();

    const result = createConversationSession(
      invalidInput as unknown as CreateConversationSessionInput,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_CONVERSATION_SESSION');
    expect(result.error.message).toContain('userGoal');
  });

  it('rejects unknown fields', () => {
    const result = createConversationSession({
      ...validInput,
      unexpected: true,
    } as CreateConversationSessionInput);

    expect(result.ok).toBe(false);
  });
});

const ALL_STATUSES: readonly ConversationStatus[] = [
  'Draft',
  'Clarifying',
  'ReadyForPlan',
  'ConvertedToEngineeringPlan',
  'Cancelled',
];

const ALLOWED_TRANSITIONS: Record<
  ConversationStatus,
  readonly ConversationStatus[]
> = {
  Draft: ['Clarifying', 'Cancelled'],
  Clarifying: ['ReadyForPlan', 'Cancelled'],
  ReadyForPlan: ['ConvertedToEngineeringPlan', 'Cancelled'],
  ConvertedToEngineeringPlan: [],
  Cancelled: [],
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

function makeAnsweredSession(
  conversationStatus: ConversationStatus,
): ConversationSession {
  return makeSession({
    conversationStatus,
    openQuestions: [
      {
        id: 'question-1',
        question: 'Which platforms must be supported?',
        answer: 'macOS and Linux',
      },
    ],
  });
}

describe('hasUnresolvedQuestions', () => {
  it('returns true when a question lacks an answer', () => {
    expect(hasUnresolvedQuestions(makeSession())).toBe(true);
  });

  it('returns true when any of several questions is unanswered', () => {
    const session = makeSession({
      openQuestions: [
        { id: 'q-1', question: 'Answered?', answer: 'Yes' },
        { id: 'q-2', question: 'Unanswered?' },
      ],
    });
    expect(hasUnresolvedQuestions(session)).toBe(true);
  });

  it('returns true when an answer is only whitespace', () => {
    const session = makeSession({
      openQuestions: [{ id: 'q-1', question: 'Blank?', answer: ' ' }],
    });
    expect(hasUnresolvedQuestions(session)).toBe(true);
  });

  it('returns false when every question has a non-empty answer', () => {
    expect(hasUnresolvedQuestions(makeAnsweredSession('Draft'))).toBe(false);
  });

  it('returns false when there are no open questions', () => {
    expect(hasUnresolvedQuestions(makeSession({ openQuestions: [] }))).toBe(
      false,
    );
  });
});

describe('transitionConversationSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const allowedPairs = ALL_STATUSES.flatMap((from) =>
    ALLOWED_TRANSITIONS[from].map((to) => [from, to] as const),
  );
  const rejectedPairs = ALL_STATUSES.flatMap((from) =>
    ALL_STATUSES.filter((to) => !ALLOWED_TRANSITIONS[from].includes(to)).map(
      (to) => [from, to] as const,
    ),
  );

  it.each(allowedPairs)(
    'allows %s -> %s and returns a new frozen session',
    (from, to) => {
      const session = makeAnsweredSession(from);
      const result = transitionConversationSession(session, to);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).not.toBe(session);
      expect(result.value.conversationStatus).toBe(to);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.openQuestions)).toBe(true);
      expect(Object.isFrozen(result.value.openQuestions[0])).toBe(true);
      expect(Object.isFrozen(result.value.confirmedRequirements)).toBe(true);
      expect(ConversationSessionSchema.safeParse(result.value).success).toBe(
        true,
      );
      // The input session is untouched.
      expect(session.conversationStatus).toBe(from);
    },
  );

  it.each(rejectedPairs)(
    'rejects %s -> %s with an error, leaving the input unchanged',
    (from, to) => {
      const session = makeAnsweredSession(from);
      const snapshot = structuredClone(session);
      const result = transitionConversationSession(session, to);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('ILLEGAL_CONVERSATION_SESSION_TRANSITION');
      expect(session).toEqual(snapshot);
      expect(session.conversationStatus).toBe(from);
    },
  );

  it('refreshes updatedAt on success and preserves everything else', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T10:00:00.000Z'));
    const session = makeAnsweredSession('Draft');

    vi.setSystemTime(new Date('2026-07-14T11:30:00.000Z'));
    const result = transitionConversationSession(session, 'Clarifying');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.updatedAt).toBe('2026-07-14T11:30:00.000Z');
    expect(result.value.createdAt).toBe(session.createdAt);
    expect(result.value.conversationId).toBe(session.conversationId);
    expect(result.value.openQuestions).toEqual(session.openQuestions);
    expect(session.updatedAt).toBe('2026-07-14T10:00:00.000Z');
  });

  it('returns an error instead of throwing when the update date is invalid', () => {
    vi.useFakeTimers();
    const session = makeAnsweredSession('Draft');
    vi.setSystemTime(Number.NaN);

    expect(() =>
      transitionConversationSession(session, 'Clarifying'),
    ).not.toThrow();
    const result = transitionConversationSession(session, 'Clarifying');

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INVALID_CONVERSATION_SESSION_DATE',
        message: 'Current time is not a valid date',
      },
    });
  });

  it('returns an error instead of throwing when the session contains an invalid date', () => {
    const session = {
      ...makeAnsweredSession('Draft'),
      updatedAt: '2026-02-30T10:00:00.000Z',
    } as ConversationSession;

    expect(() =>
      transitionConversationSession(session, 'Clarifying'),
    ).not.toThrow();
    const result = transitionConversationSession(session, 'Clarifying');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_CONVERSATION_SESSION');
    expect(result.error.message).toContain('updatedAt');
  });

  it('rejects transition into ReadyForPlan while a question has no answer', () => {
    const session = makeSession({ conversationStatus: 'Clarifying' });
    const result = transitionConversationSession(session, 'ReadyForPlan');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('UNRESOLVED_OPEN_QUESTIONS');
    expect(session.conversationStatus).toBe('Clarifying');
  });

  it('rejects transition into ReadyForPlan when one of several questions is unanswered', () => {
    const session = makeSession({
      conversationStatus: 'Clarifying',
      openQuestions: [
        { id: 'q-1', question: 'Answered?', answer: 'Yes' },
        { id: 'q-2', question: 'Unanswered?' },
      ],
    });
    const result = transitionConversationSession(session, 'ReadyForPlan');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('UNRESOLVED_OPEN_QUESTIONS');
  });

  it('allows transition into ReadyForPlan once every question is answered', () => {
    const session = makeAnsweredSession('Clarifying');
    const result = transitionConversationSession(session, 'ReadyForPlan');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.conversationStatus).toBe('ReadyForPlan');
  });

  it('allows transition into ReadyForPlan when there are no open questions', () => {
    const session = makeSession({
      conversationStatus: 'Clarifying',
      openQuestions: [],
    });
    const result = transitionConversationSession(session, 'ReadyForPlan');

    expect(result.ok).toBe(true);
  });

  it('rejects ConvertedToEngineeringPlan from every status except ReadyForPlan', () => {
    for (const from of ALL_STATUSES.filter((s) => s !== 'ReadyForPlan')) {
      const result = transitionConversationSession(
        makeAnsweredSession(from),
        'ConvertedToEngineeringPlan',
      );
      expect(result.ok).toBe(false);
    }
  });

  it('rejects every transition out of the terminal states', () => {
    for (const from of ['ConvertedToEngineeringPlan', 'Cancelled'] as const) {
      for (const to of ALL_STATUSES) {
        const result = transitionConversationSession(
          makeAnsweredSession(from),
          to,
        );
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.error.message).toContain('terminal');
      }
    }
  });

  it('returns an error without mutating the input session on failure', () => {
    const session = makeSession();
    const openQuestionsRef = session.openQuestions;
    const snapshot = structuredClone(session);

    const result = transitionConversationSession(session, 'ReadyForPlan');

    expect(result.ok).toBe(false);
    expect(session).toEqual(snapshot);
    expect(session.openQuestions).toBe(openQuestionsRef);
    expect(session.conversationStatus).toBe('Draft');
    expect(session.updatedAt).toBe(snapshot.updatedAt);
  });
});
