import { describe, expect, it } from 'vitest';

import {
  ConversationSessionSchema,
  hasUnresolvedQuestions,
} from '../conversation-session.js';
import { makeSeedConversation, resolvedAnswers } from './seed-conversation.js';

describe('makeSeedConversation', () => {
  it('returns a valid frozen Draft session with unresolved open questions', () => {
    const session = makeSeedConversation();

    expect(ConversationSessionSchema.safeParse(session).success).toBe(true);
    expect(session.conversationStatus).toBe('Draft');
    expect(session.openQuestions.length).toBeGreaterThanOrEqual(2);
    expect(session.openQuestions.every(({ answer }) => answer === undefined)).toBe(
      true,
    );
    expect(hasUnresolvedQuestions(session)).toBe(true);
    expect(Object.isFrozen(session)).toBe(true);
    expect(resolvedAnswers.map(({ id }) => id)).toEqual(
      session.openQuestions.map(({ id }) => id),
    );
  });
});
