import { z } from 'zod';

import { err, ok, type Result } from './result.js';

export const ApprovalTargetType = {
  EngineeringPlan: 'EngineeringPlan',
  ExecutionPlan: 'ExecutionPlan',
} as const;

export type ApprovalTargetType =
  (typeof ApprovalTargetType)[keyof typeof ApprovalTargetType];

export const ApprovalStatus = {
  Pending: 'Pending',
  Approved: 'Approved',
  Rejected: 'Rejected',
  Cancelled: 'Cancelled',
} as const;

export type ApprovalStatus =
  (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

function isValidIsoDateTime(value: string): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  if (!parts) return false;

  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return (
    daysInMonth[month - 1] !== undefined &&
    day >= 1 &&
    day <= daysInMonth[month - 1]! &&
    !Number.isNaN(Date.parse(value))
  );
}

const approvalTimestampSchema = z
  .iso.datetime({ offset: true })
  .refine(isValidIsoDateTime, 'must be a valid ISO-8601 timestamp');

const approvalTargetSchema = z
  .object({
    targetType: z.enum(ApprovalTargetType),
    targetId: z.string(),
    targetVersion: z.number().int().positive(),
    targetContentDigest: z.string(),
  })
  .strict();

export const approvalContractSchema = z
  .object({
    approvalId: z.string(),
    approvedBy: z.string().min(1),
    approvalTimestamp: approvalTimestampSchema,
    approvalType: z.string(),
    notes: z.string(),
    approvalStatus: z.enum(ApprovalStatus),
    target: approvalTargetSchema,
  })
  .strict();

export interface ApprovalTarget {
  readonly targetType: ApprovalTargetType;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly targetContentDigest: string;
}

export interface ApprovalContract {
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly approvalTimestamp: string;
  readonly approvalType: string;
  readonly notes: string;
  readonly approvalStatus: ApprovalStatus;
  readonly target: ApprovalTarget;
}

export type ApprovalContractInput = z.input<typeof approvalContractSchema>;

function validationError(error: z.ZodError): Result<never> {
  const issue = error.issues[0];
  if (!issue) {
    return err('INVALID_APPROVAL_CONTRACT', 'Invalid approval contract');
  }

  if (issue.code === 'unrecognized_keys') {
    const field = [...issue.path, issue.keys[0] ?? 'unknown'].join('.');
    return err(
      'INVALID_APPROVAL_CONTRACT',
      `Invalid approval contract field "${field}": unknown field`,
    );
  }

  const field = issue.path.length > 0 ? issue.path.join('.') : 'record';
  return err(
    'INVALID_APPROVAL_CONTRACT',
    `Invalid approval contract field "${field}": ${issue.message}`,
  );
}

function immutableContract(
  contract: z.output<typeof approvalContractSchema>,
): ApprovalContract {
  return Object.freeze({
    ...contract,
    target: Object.freeze({ ...contract.target }),
  });
}

export function createApprovalContract(
  input: ApprovalContractInput,
): Result<ApprovalContract> {
  const parsed = approvalContractSchema.safeParse(input);
  if (!parsed.success) {
    return validationError(parsed.error);
  }

  return ok(immutableContract(parsed.data));
}

const allowedTransitions: Readonly<
  Record<ApprovalStatus, readonly ApprovalStatus[]>
> = {
  Pending: [
    ApprovalStatus.Approved,
    ApprovalStatus.Rejected,
    ApprovalStatus.Cancelled,
  ],
  Approved: [],
  Rejected: [],
  Cancelled: [],
};

export function transitionApprovalContract(
  approval: ApprovalContract,
  toStatus: ApprovalStatus,
): Result<ApprovalContract> {
  if (!allowedTransitions[approval.approvalStatus].includes(toStatus)) {
    return err(
      'INVALID_APPROVAL_CONTRACT_TRANSITION',
      `Illegal approval contract transition from "${approval.approvalStatus}" to "${toStatus}"`,
    );
  }

  return ok(immutableContract({ ...approval, approvalStatus: toStatus }));
}

export function toJSON(contract: ApprovalContract): string {
  return JSON.stringify(contract);
}

export function parseApprovalContract(json: string): Result<ApprovalContract> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return err(
      'INVALID_APPROVAL_CONTRACT',
      'Invalid approval contract field "json": malformed JSON',
    );
  }

  const parsed = approvalContractSchema.safeParse(value);
  if (!parsed.success) {
    return validationError(parsed.error);
  }

  return ok(immutableContract(parsed.data));
}
