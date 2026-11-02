import { describe, expect, it } from 'vitest';

import {
  ApprovalStatus,
  ApprovalTargetType,
  createApprovalContract,
  parseApprovalContract,
  toJSON,
  transitionApprovalContract,
  type ApprovalContract,
  type ApprovalContractInput,
} from './approval-contract.js';

const validInput: ApprovalContractInput = {
  approvalId: 'approval-116',
  approvedBy: 'reviewer@example.com',
  approvalTimestamp: '2026-07-14T12:00:00.000Z',
  approvalType: 'Implementation',
  notes: 'Approved for execution.',
  approvalStatus: ApprovalStatus.Approved,
  target: {
    targetType: ApprovalTargetType.ExecutionPlan,
    targetId: 'execution-plan-116',
    targetVersion: 1,
    targetContentDigest: 'abc123',
  },
};

describe('ApprovalContract', () => {
  it('constructs a valid immutable contract', () => {
    const result = createApprovalContract(validInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(validInput);
    expect(result.value).not.toBe(validInput);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.target)).toBe(true);
  });

  it('rejects an empty approvedBy', () => {
    const result = createApprovalContract({ ...validInput, approvedBy: '' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('approvedBy');
  });

  it('rejects an invalid approvalTimestamp', () => {
    const result = createApprovalContract({
      ...validInput,
      approvalTimestamp: '2026-02-30T12:00:00.000Z',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('approvalTimestamp');
  });

  it('rejects an invalid targetType enum value', () => {
    const result = createApprovalContract({
      ...validInput,
      target: { ...validInput.target, targetType: 'Release' },
    } as unknown as ApprovalContractInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('target.targetType');
  });

  it('rejects an invalid approvalStatus enum value', () => {
    const result = createApprovalContract({
      ...validInput,
      approvalStatus: 'Expired',
    } as unknown as ApprovalContractInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('approvalStatus');
  });

  it('rejects an unknown key', () => {
    const result = createApprovalContract({
      ...validInput,
      unexpected: true,
    } as ApprovalContractInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('unexpected');
  });

  it('round-trips through JSON and returns a deep-equal contract', () => {
    const created = createApprovalContract(validInput);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const parsed = parseApprovalContract(toJSON(created.value));

    expect(parsed).toEqual({ ok: true, value: created.value });
    if (!parsed.ok) return;
    expect(parsed.value).not.toBe(created.value);
    expect(parsed.value.target).not.toBe(created.value.target);
  });
});

describe('transitionApprovalContract', () => {
  const statuses = Object.values(ApprovalStatus);

  const allowedTransitions = new Set([
    'Pending->Approved',
    'Pending->Rejected',
    'Pending->Cancelled',
  ]);

  function mustCreate(approvalStatus: ApprovalStatus): ApprovalContract {
    const created = createApprovalContract({ ...validInput, approvalStatus });
    if (!created.ok) {
      throw new Error(`fixture creation failed: ${created.error.message}`);
    }
    return created.value;
  }

  it('lists the four statuses', () => {
    expect(statuses).toEqual(['Pending', 'Approved', 'Rejected', 'Cancelled']);
  });

  it('enforces every pair in the 4-by-4 transition matrix', () => {
    let checkedPairs = 0;

    for (const fromStatus of statuses) {
      for (const toStatus of statuses) {
        checkedPairs += 1;
        const contract = mustCreate(fromStatus);
        const result = transitionApprovalContract(contract, toStatus);
        const transition = `${fromStatus}->${toStatus}`;

        expect(result.ok, transition).toBe(allowedTransitions.has(transition));
        if (result.ok) {
          expect(result.value.approvalStatus, transition).toBe(toStatus);
        } else {
          expect(result.error.code, transition).toBe(
            'INVALID_APPROVAL_CONTRACT_TRANSITION',
          );
          expect(result.error.message, transition).toContain(fromStatus);
          expect(result.error.message, transition).toContain(toStatus);
        }
      }
    }

    expect(checkedPairs).toBe(16);
  });

  it('returns a new contract without changing the original', () => {
    const original = mustCreate(ApprovalStatus.Pending);
    const snapshot = toJSON(original);
    const result = transitionApprovalContract(original, ApprovalStatus.Approved);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBe(original);
    expect(result.value.approvalStatus).toBe(ApprovalStatus.Approved);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.target)).toBe(true);
    expect(toJSON(original)).toBe(snapshot);
    expect(original.approvalStatus).toBe(ApprovalStatus.Pending);
  });
});
