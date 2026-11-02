import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EngineeringPlanStatus,
  approvePlan,
  convertConversationToEngineeringPlan,
  createConversationSession,
  requestApproval,
  transitionConversationSession,
  transitionEngineeringPlan,
  type ConversationSession,
  type CreateConversationSessionInput,
  type EngineeringPlan,
  type PlanApprovalInput,
} from './index.js';

type PersistenceModule = typeof import('./persistence.js');

// The persistence module's only durable state lives on disk, so a process
// restart is simulated by resetting the module registry and importing a
// brand-new module instance pointed at the same data directory.
async function freshPersistenceModule(): Promise<PersistenceModule> {
  vi.resetModules();
  return import('./persistence.js');
}

const sessionInput: CreateConversationSessionInput = {
  conversationId: 'conversation-133',
  conversationStatus: 'Clarifying',
  projectName: 'Codex Lens',
  userGoal: 'Walk the full M1 lifecycle from conversation to approved plan.',
  background: 'Every lifecycle gate must hold when the modules are composed.',
  openQuestions: [
    {
      id: 'question-1',
      question: 'Which platforms must be supported?',
    },
  ],
  confirmedRequirements: ['Gate every lifecycle transition'],
  confirmedConstraints: ['Never throw for invalid input'],
  confirmedAcceptanceCriteria: ['Each lifecycle claim has an assertion'],
  assumptions: ['The caller provides the conversation content'],
  unresolvedRisks: ['Requirements may change after conversion'],
};

const approvalInput: PlanApprovalInput = {
  approvalId: 'approval-133',
  approvedBy: 'reviewer@example.com',
  approvalTimestamp: '2026-07-14T13:00:00.000Z',
  approvalType: 'EngineeringPlanApproval',
  notes: 'Reviewed as part of the full lifecycle.',
};

function makeSession(
  overrides: Partial<CreateConversationSessionInput> = {},
): ConversationSession {
  const result = createConversationSession({ ...sessionInput, ...overrides });
  if (!result.ok) {
    throw new Error(`test setup failed: ${result.error.message}`);
  }
  return result.value;
}

function makeResolvedReadySession(): ConversationSession {
  return makeSession({
    conversationStatus: 'ReadyForPlan',
    openQuestions: [
      {
        id: 'question-1',
        question: 'Which platforms must be supported?',
        answer: 'macOS and Linux',
      },
    ],
  });
}

function makeConvertedDraftPlan(): EngineeringPlan {
  const converted = convertConversationToEngineeringPlan(
    makeResolvedReadySession(),
  );
  if (!converted.ok) {
    throw new Error(`test setup failed: ${converted.error.message}`);
  }
  return converted.value.plan;
}

describe('M1 lifecycle integration', () => {
  describe('claim (a): unresolved open questions block ReadyForPlan', () => {
    it('rejects the ReadyForPlan transition while a question is unanswered', () => {
      const session = makeSession();

      const result = transitionConversationSession(session, 'ReadyForPlan');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('UNRESOLVED_OPEN_QUESTIONS');
      expect(session.conversationStatus).toBe('Clarifying');
    });
  });

  describe('claim (b): a conversation with unresolved open questions cannot convert', () => {
    it('rejects conversion because the unresolved session never reached ReadyForPlan', () => {
      const result = convertConversationToEngineeringPlan(makeSession());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('CONVERSATION_NOT_READY_FOR_PLAN');
    });

    it('rejects conversion even for a session claiming ReadyForPlan with an unresolved question', () => {
      const session = makeSession({ conversationStatus: 'ReadyForPlan' });

      const result = convertConversationToEngineeringPlan(session);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('UNRESOLVED_OPEN_QUESTIONS');
    });
  });

  describe('claim (c): an Engineering Plan cannot advance past Draft without approval', () => {
    it('rejects approving a converted plan that is still in Draft', () => {
      const plan = makeConvertedDraftPlan();

      const result = approvePlan(plan, approvalInput);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('ILLEGAL_ENGINEERING_PLAN_TRANSITION');
      expect(plan.status).toBe(EngineeringPlanStatus.Draft);
    });

    it('rejects every direct transition from Draft past ReadyForApproval', () => {
      const plan = makeConvertedDraftPlan();

      for (const target of [
        EngineeringPlanStatus.Approved,
        EngineeringPlanStatus.SentToCodex,
        EngineeringPlanStatus.Completed,
      ]) {
        const result = transitionEngineeringPlan(plan, target);
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.error.code).toBe('ILLEGAL_ENGINEERING_PLAN_TRANSITION');
      }
      expect(plan.status).toBe(EngineeringPlanStatus.Draft);
    });
  });

  describe('claim (d): an approval bound to the wrong version or digest is rejected', () => {
    function readyPlan(): EngineeringPlan {
      const requested = requestApproval(makeConvertedDraftPlan());
      if (!requested.ok) {
        throw new Error(`test setup failed: ${requested.error.message}`);
      }
      return requested.value;
    }

    it('rejects an approval pinned to a different plan version', () => {
      const plan = readyPlan();

      const result = approvePlan(plan, {
        ...approvalInput,
        pinnedVersion: plan.version + 1,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('AUTHORIZATION_TARGET_VERSION_MISMATCH');
      expect(plan.status).toBe(EngineeringPlanStatus.ReadyForApproval);
    });

    it('rejects an approval pinned to a different content digest', () => {
      const plan = readyPlan();

      const result = approvePlan(plan, {
        ...approvalInput,
        pinnedContentDigest: 'f'.repeat(64),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(
        'AUTHORIZATION_TARGET_CONTENT_DIGEST_MISMATCH',
      );
      expect(plan.status).toBe(EngineeringPlanStatus.ReadyForApproval);
    });
  });

  describe('claim (e): session and plan survive a simulated restart', () => {
    let dataDirectory: string;

    beforeEach(() => {
      dataDirectory = mkdtempSync(join(tmpdir(), 'codex-lens-lifecycle-'));
      process.env.CODEX_LENS_DATA_DIR = dataDirectory;
    });

    afterEach(() => {
      delete process.env.CODEX_LENS_DATA_DIR;
      rmSync(dataDirectory, { recursive: true, force: true });
    });

    it('reloads the full lifecycle output from a fresh persistence module', async () => {
      // Run the whole happy path first: clarify, resolve, convert, approve.
      const clarifying = makeSession();
      const answered = makeSession({
        openQuestions: [
          {
            id: 'question-1',
            question: 'Which platforms must be supported?',
            answer: 'macOS and Linux',
          },
        ],
      });
      expect(clarifying.conversationStatus).toBe('Clarifying');

      const ready = transitionConversationSession(answered, 'ReadyForPlan');
      expect(ready.ok).toBe(true);
      if (!ready.ok) return;

      const converted = convertConversationToEngineeringPlan(ready.value);
      expect(converted.ok).toBe(true);
      if (!converted.ok) return;
      expect(converted.value.session.conversationStatus).toBe(
        'ConvertedToEngineeringPlan',
      );

      const requested = requestApproval(converted.value.plan);
      expect(requested.ok).toBe(true);
      if (!requested.ok) return;

      const approved = approvePlan(requested.value, approvalInput);
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.value.plan.status).toBe(EngineeringPlanStatus.Approved);

      const firstProcess = await freshPersistenceModule();
      expect(firstProcess.saveConversation(converted.value.session)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(firstProcess.saveEngineeringPlan(approved.value.plan)).toEqual({
        ok: true,
        value: undefined,
      });

      const restartedProcess = await freshPersistenceModule();
      expect(restartedProcess).not.toBe(firstProcess);

      expect(
        restartedProcess.loadConversation(
          converted.value.session.conversationId,
        ),
      ).toEqual({ ok: true, value: converted.value.session });
      expect(
        restartedProcess.loadEngineeringPlan(
          approved.value.plan.engineeringPlanId,
        ),
      ).toEqual({ ok: true, value: approved.value.plan });
    });
  });
});
