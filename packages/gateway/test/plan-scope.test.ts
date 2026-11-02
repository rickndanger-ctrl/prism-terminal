import os from 'node:os';
import path from 'node:path';

import { createExecutionPlan, type ExecutionPlan } from '@codex-lens/shared';
import { describe, expect, it } from 'vitest';

import { assertEditInScope, resolvePlanScope } from '../src/plan-scope.js';
import {
  CODEX_LENS_REPO_ID,
  SAMPLE_REPO_ID,
  SAMPLE_REPO_ROOT,
} from '../src/registryConfig.js';

/** An existing file in the sample repo, and one that is not there. */
const CALCULATOR = 'src/calculator.js';
const ABSENT = 'src/not-written-yet.js';

interface PlanFiles {
  modify?: readonly string[];
  create?: readonly string[];
  delete?: readonly string[];
}

/**
 * A plan naming the given files, as absolute paths under the sample repo —
 * which is the shape `generateExecutionPlan` resolves its files to. Built
 * through the real constructor so these are plans, not plan-shaped objects.
 */
function planFor(files: PlanFiles): ExecutionPlan {
  // `resolve`, so a test may name an absolute path outside the repo and have it
  // stay outside rather than be reparented under the root.
  const absolute = (file: string): string => path.resolve(SAMPLE_REPO_ROOT, file);
  const created = createExecutionPlan({
    engineeringPlanId: 'engineering-plan-155',
    filesToModify: (files.modify ?? []).map(absolute),
    filesToCreate: (files.create ?? []).map(absolute),
    filesToDelete: (files.delete ?? []).map(absolute),
    implementationSteps: ['Make the change.'],
    expectedCommands: ['npm test'],
    estimatedRisk: 'Low',
    estimatedComplexity: 'Low',
    estimatedDuration: 5,
    rollbackStrategy: 'git restore.',
    executionStatus: 'Pending',
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function scopeFor(files: PlanFiles, repoId = SAMPLE_REPO_ID): ReturnType<
  typeof resolvePlanScope
> {
  return resolvePlanScope(planFor(files), repoId);
}

describe('resolvePlanScope', () => {
  it('maps the plan\'s absolute files to repo-relative roles', () => {
    const scope = scopeFor({
      modify: [CALCULATOR],
      create: ['src/multiply.js'],
      delete: ['README.md'],
    });

    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect([...scope.value.roles]).toEqual([
      [CALCULATOR, 'modify'],
      ['src/multiply.js', 'create'],
      ['README.md', 'delete'],
    ]);
  });

  it('refuses a plan file that does not land inside the named repo', () => {
    // A scope that silently dropped this would describe a plan nobody wrote.
    const scope = scopeFor({ modify: [path.join(os.tmpdir(), 'elsewhere.js')] });

    expect(scope).toMatchObject({
      ok: false,
      error: { code: 'PLAN_FILE_OUTSIDE_REPO' },
    });
  });

  it('scopes nothing an edit can match when plan and repo disagree', () => {
    // The sample repo sits inside the codex-lens checkout, so a sample-repo plan
    // scoped against codex-lens resolves to real paths rather than escapes —
    // just deeper ones. What matters is the direction that mismatch fails in:
    // the keys no longer match what a sandbox of that repo would be asked to
    // write, so every edit is refused. A mismatch can narrow scope, never widen
    // it.
    const scope = scopeFor({ modify: [CALCULATOR] }, CODEX_LENS_REPO_ID);

    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.value.roles.has(CALCULATOR)).toBe(false);
    expect(
      assertEditInScope(scope.value, SAMPLE_REPO_ROOT, CALCULATOR),
    ).toMatchObject({ ok: false, error: { code: 'PLAN_FILE_OUT_OF_SCOPE' } });
  });

  it('refuses an unregistered repo rather than scoping against it', () => {
    const scope = scopeFor({ modify: [CALCULATOR] }, 'no-such-repo');

    expect(scope.ok).toBe(false);
  });
});

describe('assertEditInScope', () => {
  it('permits an edit to a file the plan names to modify', () => {
    const scope = scopeFor({ modify: [CALCULATOR] });
    if (!scope.ok) throw new Error(scope.error.message);

    expect(
      assertEditInScope(scope.value, SAMPLE_REPO_ROOT, CALCULATOR),
    ).toEqual({ ok: true, value: undefined });
  });

  it('permits an edit to a file the plan names to create', () => {
    const scope = scopeFor({ create: [ABSENT] });
    if (!scope.ok) throw new Error(scope.error.message);

    expect(assertEditInScope(scope.value, SAMPLE_REPO_ROOT, ABSENT)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('refuses an edit to a file the plan does not name', () => {
    const scope = scopeFor({ modify: [CALCULATOR] });
    if (!scope.ok) throw new Error(scope.error.message);

    expect(
      assertEditInScope(scope.value, SAMPLE_REPO_ROOT, 'README.md'),
    ).toMatchObject({ ok: false, error: { code: 'PLAN_FILE_OUT_OF_SCOPE' } });
  });

  it('judges the resolved path, not the spelling Codex used', () => {
    const scope = scopeFor({ modify: [CALCULATOR] });
    if (!scope.ok) throw new Error(scope.error.message);

    // The same file, spelled two other ways. Both are in scope, because scope
    // is a question about files and these are that file.
    for (const spelling of ['./src/calculator.js', 'src/../src/calculator.js']) {
      expect(assertEditInScope(scope.value, SAMPLE_REPO_ROOT, spelling)).toEqual({
        ok: true,
        value: undefined,
      });
    }
  });

  it('refuses writing a file the plan names for deletion', () => {
    const scope = scopeFor({ delete: [CALCULATOR] });
    if (!scope.ok) throw new Error(scope.error.message);

    expect(
      assertEditInScope(scope.value, SAMPLE_REPO_ROOT, CALCULATOR),
    ).toMatchObject({ ok: false, error: { code: 'PLAN_FILE_ROLE_MISMATCH' } });
  });

  it('refuses creating a file that is already there', () => {
    // The reviewer approved a new file. The file exists, so writing it would be
    // an overwrite — a modification the approval never covered.
    const scope = scopeFor({ create: [CALCULATOR] });
    if (!scope.ok) throw new Error(scope.error.message);

    const result = assertEditInScope(scope.value, SAMPLE_REPO_ROOT, CALCULATOR);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PLAN_FILE_ROLE_MISMATCH' },
    });
    if (result.ok) return;
    expect(result.error.message).toContain('already exists');
  });

  it('refuses modifying a file that is not there', () => {
    // The mirror image: approved as an edit to something existing, but nothing
    // is there, so the write would create a file rather than change one.
    const scope = scopeFor({ modify: [ABSENT] });
    if (!scope.ok) throw new Error(scope.error.message);

    const result = assertEditInScope(scope.value, SAMPLE_REPO_ROOT, ABSENT);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PLAN_FILE_ROLE_MISMATCH' },
    });
    if (result.ok) return;
    expect(result.error.message).toContain('does not exist');
  });
});
