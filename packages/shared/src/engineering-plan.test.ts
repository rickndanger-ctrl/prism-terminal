import { describe, expect, it } from 'vitest';

import { contentDigest } from './digest.js';
import {
  EngineeringPlanStatus,
  createEngineeringPlan,
  parseEngineeringPlan,
  toJSON,
  transitionEngineeringPlan,
  type EngineeringPlan,
  type EngineeringPlanInput,
} from './engineering-plan.js';

const validInput: EngineeringPlanInput = {
  engineeringPlanId: 'plan-114',
  version: 1,
  createdAt: '2026-07-14T12:00:00.000Z',
  updatedAt: '2026-07-14T12:00:00.000Z',
  projectName: 'Codex Lens',
  featureName: 'Engineering Plan',
  objective: 'Represent an approved engineering goal.',
  background: 'Plans are reviewed before code is changed.',
  requirements: ['Validate every field', 'Compute a stable digest'],
  constraints: ['Never throw for invalid input'],
  acceptanceCriteria: ['Valid plans round-trip through JSON'],
  assumptions: ['The caller supplies identity and timestamps'],
  risks: ['A stale digest could approve changed content'],
  status: EngineeringPlanStatus.Draft,
};

describe('EngineeringPlan', () => {
  it('constructs a valid immutable plan with a computed content digest', () => {
    const result = createEngineeringPlan(validInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).not.toBe(validInput);
    expect(result.value.contentDigest).toBe(
      contentDigest({
        projectName: validInput.projectName,
        featureName: validInput.featureName,
        objective: validInput.objective,
        background: validInput.background,
        requirements: validInput.requirements,
        constraints: validInput.constraints,
        acceptanceCriteria: validInput.acceptanceCriteria,
        assumptions: validInput.assumptions,
        risks: validInput.risks,
      }),
    );
    expect(result.value.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.requirements)).toBe(true);
  });

  it('rejects an unknown key', () => {
    const result = createEngineeringPlan({
      ...validInput,
      unexpected: true,
    } as EngineeringPlanInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('unexpected');
  });

  it('rejects an invalid status enum value', () => {
    const result = createEngineeringPlan({
      ...validInput,
      status: 'WaitingForApproval',
    } as unknown as EngineeringPlanInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('status');
  });

  it('rejects a non-ISO-8601 date', () => {
    const result = createEngineeringPlan({
      ...validInput,
      createdAt: 'July 14, 2026',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('createdAt');
  });

  it('rejects an impossible ISO-shaped calendar date', () => {
    const result = createEngineeringPlan({
      ...validInput,
      updatedAt: '2026-02-30T12:00:00.000Z',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('updatedAt');
  });

  it('round-trips through JSON and returns a deep-equal plan', () => {
    const created = createEngineeringPlan(validInput);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const parsed = parseEngineeringPlan(toJSON(created.value));

    expect(parsed).toEqual({ ok: true, value: created.value });
    if (!parsed.ok) return;
    expect(parsed.value).not.toBe(created.value);
    expect(Object.isFrozen(parsed.value)).toBe(true);
  });
});

describe('transitionEngineeringPlan', () => {
  const statuses = Object.values(EngineeringPlanStatus);
  const allowed = new Set([
    `${EngineeringPlanStatus.Draft}->${EngineeringPlanStatus.ReadyForApproval}`,
    `${EngineeringPlanStatus.ReadyForApproval}->${EngineeringPlanStatus.Approved}`,
    `${EngineeringPlanStatus.Approved}->${EngineeringPlanStatus.SentToCodex}`,
    `${EngineeringPlanStatus.SentToCodex}->${EngineeringPlanStatus.Completed}`,
  ]);

  function planWithStatus(status: EngineeringPlanStatus): EngineeringPlan {
    const created = createEngineeringPlan({ ...validInput, status });
    if (!created.ok) {
      throw new Error(`test setup: could not create plan with status ${status}`);
    }
    return created.value;
  }

  it('covers all 25 (from, to) status pairs', () => {
    const pairs = statuses.flatMap((fromStatus) =>
      statuses.map((toStatus) => [fromStatus, toStatus] as const),
    );
    expect(pairs).toHaveLength(25);

    for (const [fromStatus, toStatus] of pairs) {
      const result = transitionEngineeringPlan(planWithStatus(fromStatus), toStatus);

      if (allowed.has(`${fromStatus}->${toStatus}`)) {
        expect(result.ok, `${fromStatus} -> ${toStatus} should be allowed`).toBe(true);
        if (!result.ok) continue;
        expect(result.value.status).toBe(toStatus);
      } else {
        expect(result.ok, `${fromStatus} -> ${toStatus} should be rejected`).toBe(false);
        if (result.ok) continue;
        expect(result.error.code).toBe('ILLEGAL_ENGINEERING_PLAN_TRANSITION');
        expect(result.error.message).toContain(`from "${fromStatus}"`);
        expect(result.error.message).toContain(`to "${toStatus}"`);
      }
    }
  });

  it('refreshes updatedAt on a successful transition', () => {
    const plan = planWithStatus(EngineeringPlanStatus.Draft);
    const result = transitionEngineeringPlan(
      plan,
      EngineeringPlanStatus.ReadyForApproval,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Date.parse(result.value.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(plan.updatedAt),
    );
    expect(result.value.createdAt).toBe(plan.createdAt);
  });

  it('leaves the original plan deep-unchanged and returns a new reference', () => {
    const plan = planWithStatus(EngineeringPlanStatus.Approved);
    const snapshot = structuredClone(plan);

    const result = transitionEngineeringPlan(plan, EngineeringPlanStatus.SentToCodex);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBe(plan);
    expect(plan).toEqual(snapshot);
    expect(plan.status).toBe(EngineeringPlanStatus.Approved);
    expect(Object.isFrozen(result.value)).toBe(true);
  });
});
