import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConversationSession } from './conversation-session.js';
import {
  createEngineeringPlan,
  EngineeringPlanStatus,
} from './engineering-plan.js';
import {
  loadConversation,
  loadEngineeringPlan,
  saveConversation,
  saveEngineeringPlan,
} from './persistence.js';

describe('persistence', () => {
  let dataDirectory: string;

  beforeEach(() => {
    dataDirectory = mkdtempSync(join(tmpdir(), 'codex-lens-persistence-'));
    process.env.CODEX_LENS_DATA_DIR = dataDirectory;
  });

  afterEach(() => {
    delete process.env.CODEX_LENS_DATA_DIR;
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  it('saves and loads a deep-equal conversation session', () => {
    const created = createConversationSession({
      conversationId: 'conversation-128',
      projectName: 'Codex Lens',
      userGoal: 'Persist clarified engineering conversations.',
      background: 'Sessions must survive process restarts.',
      openQuestions: [
        {
          id: 'question-1',
          question: 'Where should local data live?',
          answer: 'Under CODEX_LENS_DATA_DIR.',
        },
      ],
      confirmedRequirements: ['Round-trip every session field'],
      confirmedConstraints: ['Add no persistence dependency'],
      confirmedAcceptanceCriteria: ['Loaded sessions are deep equal'],
      assumptions: ['The local filesystem is writable'],
      unresolvedRisks: ['A file can be edited outside the application'],
      conversationStatus: 'ReadyForPlan',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(saveConversation(created.value)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(loadConversation(created.value.conversationId)).toEqual({
      ok: true,
      value: created.value,
    });
  });

  it('saves and loads a deep-equal engineering plan with a verified digest', () => {
    const created = engineeringPlan('plan-128');

    expect(saveEngineeringPlan(created)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(loadEngineeringPlan(created.engineeringPlanId)).toEqual({
      ok: true,
      value: created,
    });
  });

  it('returns a Result error when a persisted plan digest is tampered with', () => {
    const created = engineeringPlan('tampered-plan-128');
    expect(saveEngineeringPlan(created).ok).toBe(true);

    const path = join(dataDirectory, 'persistence.json');
    const store = JSON.parse(readFileSync(path, 'utf8')) as {
      engineeringPlans: Record<string, { contentDigest: string }>;
    };
    const persisted = store.engineeringPlans[created.engineeringPlanId];
    if (!persisted) throw new Error('test setup: persisted plan is missing');
    persisted.contentDigest = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(store), 'utf8');

    const loaded = loadEngineeringPlan(created.engineeringPlanId);

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe('INVALID_ENGINEERING_PLAN');
    expect(loaded.error.message).toContain('contentDigest');
  });
});

function engineeringPlan(engineeringPlanId: string) {
  const created = createEngineeringPlan({
    engineeringPlanId,
    version: 1,
    createdAt: '2026-07-14T12:00:00.000Z',
    updatedAt: '2026-07-14T12:30:00.000Z',
    projectName: 'Codex Lens',
    featureName: 'Persistence',
    objective: 'Persist engineering plans without losing integrity.',
    background: 'Plans must retain timestamps, status, and content digest.',
    requirements: ['Round-trip every engineering plan field'],
    constraints: ['Use the M0 dependency set'],
    acceptanceCriteria: ['Reject a plan with a mismatched digest'],
    assumptions: ['The local filesystem is writable'],
    risks: ['External edits can corrupt persisted data'],
    status: EngineeringPlanStatus.ReadyForApproval,
  });
  if (!created.ok) {
    throw new Error(`test setup: ${created.error.message}`);
  }
  return created.value;
}
