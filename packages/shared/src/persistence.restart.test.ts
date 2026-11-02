import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConversationSession } from './conversation-session.js';
import {
  createEngineeringPlan,
  EngineeringPlanStatus,
} from './engineering-plan.js';

type PersistenceModule = typeof import('./persistence.js');

// The persistence API is a module whose only durable state lives on disk, so a
// process restart is simulated by resetting the module registry and importing
// a brand-new module instance pointed at the same data directory.
async function freshPersistenceModule(): Promise<PersistenceModule> {
  vi.resetModules();
  return import('./persistence.js');
}

describe('persistence across a simulated process restart', () => {
  let dataDirectory: string;

  beforeEach(() => {
    dataDirectory = mkdtempSync(join(tmpdir(), 'codex-lens-restart-'));
    process.env.CODEX_LENS_DATA_DIR = dataDirectory;
  });

  afterEach(() => {
    delete process.env.CODEX_LENS_DATA_DIR;
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  it('loads saved artifacts from a fresh repository instance at the same location', async () => {
    const session = conversationSession('conversation-129');
    const plan = engineeringPlan('plan-129');

    const firstRepository = await freshPersistenceModule();
    expect(firstRepository.saveConversation(session)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(firstRepository.saveEngineeringPlan(plan)).toEqual({
      ok: true,
      value: undefined,
    });

    const restartedRepository = await freshPersistenceModule();
    expect(restartedRepository).not.toBe(firstRepository);

    expect(restartedRepository.loadConversation(session.conversationId)).toEqual({
      ok: true,
      value: session,
    });
    expect(restartedRepository.loadEngineeringPlan(plan.engineeringPlanId)).toEqual({
      ok: true,
      value: plan,
    });
  });
});

function conversationSession(conversationId: string) {
  const created = createConversationSession({
    conversationId,
    projectName: 'Codex Lens',
    userGoal: 'Prove persisted artifacts survive a process restart.',
    background: 'A fresh repository instance must read what another wrote.',
    openQuestions: [
      {
        id: 'question-1',
        question: 'How is a restart simulated in a unit test?',
        answer: 'By importing a brand-new persistence module instance.',
      },
    ],
    confirmedRequirements: ['Load artifacts written before the restart'],
    confirmedConstraints: ['Use only the persistence.ts API'],
    confirmedAcceptanceCriteria: ['Loaded artifacts deep-equal saved ones'],
    assumptions: ['The temp directory outlives the module instance'],
    unresolvedRisks: ['The data directory can be deleted between runs'],
    conversationStatus: 'ReadyForPlan',
  });
  if (!created.ok) {
    throw new Error(`test setup: ${created.error.message}`);
  }
  return created.value;
}

function engineeringPlan(engineeringPlanId: string) {
  const created = createEngineeringPlan({
    engineeringPlanId,
    version: 1,
    createdAt: '2026-07-14T12:00:00.000Z',
    updatedAt: '2026-07-14T12:30:00.000Z',
    projectName: 'Codex Lens',
    featureName: 'Restart survival',
    objective: 'Keep engineering plans readable after a restart.',
    background: 'Plans persisted to disk must outlive the writing process.',
    requirements: ['Round-trip every engineering plan field across restarts'],
    constraints: ['Use the M0 dependency set'],
    acceptanceCriteria: ['A fresh repository loads a deep-equal plan'],
    assumptions: ['The local filesystem is writable'],
    risks: ['External edits can corrupt persisted data'],
    status: EngineeringPlanStatus.ReadyForApproval,
  });
  if (!created.ok) {
    throw new Error(`test setup: ${created.error.message}`);
  }
  return created.value;
}
