import { describe, expect, it } from 'vitest';

import { contentDigest } from './digest.js';
import {
  createExecutionPlan,
  EXECUTION_STATUSES,
  parseExecutionPlan,
  transitionExecutionPlan,
  toJSON,
  type CreateExecutionPlanInput,
  type ExecutionPlan,
} from './execution-plan.js';

const validInput: CreateExecutionPlanInput = {
  engineeringPlanId: 'ep-42',
  filesToModify: ['src/index.ts'],
  filesToCreate: ['src/execution-plan.ts'],
  filesToDelete: [],
  implementationSteps: ['define schema', 'wire exports'],
  expectedCommands: ['npm test', 'npm run typecheck'],
  estimatedRisk: 'Low',
  estimatedComplexity: 'Medium',
  estimatedDuration: 45,
  rollbackStrategy: 'git revert the commit',
  executionStatus: 'Pending',
};

function mustCreate(input: CreateExecutionPlanInput = validInput): ExecutionPlan {
  const result = createExecutionPlan(input);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
  return result.value;
}

describe('createExecutionPlan', () => {
  it('accepts valid input and computes contentDigest from content fields', () => {
    const result = createExecutionPlan(validInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.value;
    expect(plan.contentDigest).toBe(contentDigest(validInput));
    expect(plan.version).toBe(1);
    expect(plan.executionPlanId).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.createdAt).toBe(plan.updatedAt);
  });

  it('excludes identity and timestamps from the digest', () => {
    const a = mustCreate();
    const b = mustCreate();
    expect(a.executionPlanId).not.toBe(b.executionPlanId);
    expect(a.contentDigest).toBe(b.contentDigest);
  });

  it('defaults executionStatus to Pending', () => {
    const rest = { ...validInput };
    delete rest.executionStatus;
    const plan = mustCreate(rest);
    expect(plan.executionStatus).toBe('Pending');
  });

  it('rejects an unknown key', () => {
    const result = createExecutionPlan({ ...validInput, bogus: true } as CreateExecutionPlanInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EXECUTION_PLAN_INVALID_INPUT');
  });

  it('rejects an invalid status enum value', () => {
    const result = createExecutionPlan({
      ...validInput,
      executionStatus: 'Paused',
    } as unknown as CreateExecutionPlanInput);
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid risk enum value', () => {
    const result = createExecutionPlan({
      ...validInput,
      estimatedRisk: 'Extreme',
    } as unknown as CreateExecutionPlanInput);
    expect(result.ok).toBe(false);
  });

  it('returns frozen records', () => {
    const plan = mustCreate();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.filesToModify)).toBe(true);
  });
});

describe('parseExecutionPlan', () => {
  it('rejects an unknown key', () => {
    const json = { ...toJSON(mustCreate()), extra: 'nope' };
    const result = parseExecutionPlan(json);
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid status enum value', () => {
    const json = { ...toJSON(mustCreate()), executionStatus: 'Done' };
    const result = parseExecutionPlan(json);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-ISO-8601 date', () => {
    const json = { ...toJSON(mustCreate()), createdAt: '14/07/2026 10:00' };
    const result = parseExecutionPlan(json);
    expect(result.ok).toBe(false);
  });

  it('rejects an ISO-shaped but impossible date', () => {
    const json = { ...toJSON(mustCreate()), updatedAt: '2026-02-30T00:00:00Z' };
    const result = parseExecutionPlan(json);
    expect(result.ok).toBe(false);
  });

  it('rejects a contentDigest that does not match the content fields', () => {
    const json = { ...toJSON(mustCreate()), rollbackStrategy: 'tampered' };
    const result = parseExecutionPlan(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EXECUTION_PLAN_DIGEST_MISMATCH');
  });

  it('rejects non-object input', () => {
    expect(parseExecutionPlan('not a plan').ok).toBe(false);
    expect(parseExecutionPlan(null).ok).toBe(false);
  });
});

describe('toJSON round-trip', () => {
  it('toJSON then parse deep-equals the original', () => {
    const plan = mustCreate();
    const result = parseExecutionPlan(JSON.parse(JSON.stringify(toJSON(plan))));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(plan);
  });
});

describe('EXECUTION_STATUSES', () => {
  it('lists the six statuses', () => {
    expect(EXECUTION_STATUSES).toEqual([
      'Pending',
      'Ready',
      'Running',
      'Blocked',
      'Complete',
      'Failed',
    ]);
  });
});

describe('transitionExecutionPlan', () => {
  const allowedTransitions = new Set([
    'Pending->Ready',
    'Ready->Running',
    'Running->Blocked',
    'Running->Complete',
    'Running->Failed',
    'Blocked->Ready',
  ]);

  it('enforces every pair in the 6-by-6 transition matrix', () => {
    let checkedPairs = 0;

    for (const fromStatus of EXECUTION_STATUSES) {
      for (const toStatus of EXECUTION_STATUSES) {
        checkedPairs += 1;
        const plan = mustCreate({ ...validInput, executionStatus: fromStatus });
        const result = transitionExecutionPlan(plan, toStatus);
        const transition = `${fromStatus}->${toStatus}`;

        expect(result.ok, transition).toBe(allowedTransitions.has(transition));
        if (!result.ok) {
          expect(result.error.code, transition).toBe('EXECUTION_PLAN_INVALID_TRANSITION');
        }
      }
    }

    expect(checkedPairs).toBe(36);
  });

  it('returns a new plan without changing the original', () => {
    const original = mustCreate();
    const snapshot = toJSON(original);
    const result = transitionExecutionPlan(original, 'Ready');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBe(original);
    expect(result.value.executionStatus).toBe('Ready');
    expect(result.value.updatedAt).not.toBe(original.updatedAt);
    expect(result.value.contentDigest).not.toBe(original.contentDigest);
    expect(original).toEqual(snapshot);
    expect(original.executionStatus).toBe('Pending');
  });
});
