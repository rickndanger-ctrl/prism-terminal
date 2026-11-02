import { z } from 'zod';

import { contentDigest } from './digest.js';
import { err, ok, type Result } from './result.js';

export const EngineeringPlanStatus = {
  Draft: 'Draft',
  ReadyForApproval: 'ReadyForApproval',
  Approved: 'Approved',
  SentToCodex: 'SentToCodex',
  Completed: 'Completed',
} as const;

export type EngineeringPlanStatus =
  (typeof EngineeringPlanStatus)[keyof typeof EngineeringPlanStatus];

function isValidIsoDateTime(value: string): boolean {
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  if (!dateParts) return false;

  const year = Number(dateParts[1]);
  const month = Number(dateParts[2]);
  const day = Number(dateParts[3]);
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
  const maximumDay = daysInMonth[month - 1];

  return (
    maximumDay !== undefined &&
    day <= maximumDay &&
    !Number.isNaN(Date.parse(value))
  );
}

const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .refine(isValidIsoDateTime, 'must be a valid ISO-8601 date');

const contentFields = {
  projectName: z.string(),
  featureName: z.string(),
  objective: z.string(),
  background: z.string(),
  requirements: z.array(z.string()),
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
};

const engineeringPlanInputSchema = z
  .object({
    engineeringPlanId: z.string().min(1),
    version: z.number().int().positive(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    ...contentFields,
    status: z.enum(EngineeringPlanStatus),
  })
  .strict();

export const engineeringPlanSchema = engineeringPlanInputSchema
  .extend({ contentDigest: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

export interface EngineeringPlan {
  readonly engineeringPlanId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contentDigest: string;
  readonly projectName: string;
  readonly featureName: string;
  readonly objective: string;
  readonly background: string;
  readonly requirements: readonly string[];
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly assumptions: readonly string[];
  readonly risks: readonly string[];
  readonly status: EngineeringPlanStatus;
}

export type EngineeringPlanInput = z.input<typeof engineeringPlanInputSchema>;

type EngineeringPlanContent = Pick<
  EngineeringPlan,
  | 'projectName'
  | 'featureName'
  | 'objective'
  | 'background'
  | 'requirements'
  | 'constraints'
  | 'acceptanceCriteria'
  | 'assumptions'
  | 'risks'
>;

function planContent(plan: EngineeringPlanContent): EngineeringPlanContent {
  return {
    projectName: plan.projectName,
    featureName: plan.featureName,
    objective: plan.objective,
    background: plan.background,
    requirements: plan.requirements,
    constraints: plan.constraints,
    acceptanceCriteria: plan.acceptanceCriteria,
    assumptions: plan.assumptions,
    risks: plan.risks,
  };
}

export function engineeringPlanContentDigest(
  plan: EngineeringPlanContent,
): string {
  return contentDigest(planContent(plan));
}

function validationError(error: z.ZodError): Result<never> {
  const issue = error.issues[0];
  if (!issue) {
    return err('INVALID_ENGINEERING_PLAN', 'Invalid engineering plan');
  }

  if (issue.code === 'unrecognized_keys') {
    const field = issue.keys[0] ?? 'unknown';
    return err(
      'INVALID_ENGINEERING_PLAN',
      `Invalid engineering plan field "${field}": unknown field`,
    );
  }

  const field = issue.path.length > 0 ? issue.path.join('.') : 'record';
  return err(
    'INVALID_ENGINEERING_PLAN',
    `Invalid engineering plan field "${field}": ${issue.message}`,
  );
}

function immutablePlan(
  plan: z.output<typeof engineeringPlanSchema>,
): EngineeringPlan {
  return Object.freeze({
    ...plan,
    requirements: Object.freeze([...plan.requirements]),
    constraints: Object.freeze([...plan.constraints]),
    acceptanceCriteria: Object.freeze([...plan.acceptanceCriteria]),
    assumptions: Object.freeze([...plan.assumptions]),
    risks: Object.freeze([...plan.risks]),
  });
}

export function createEngineeringPlan(
  input: EngineeringPlanInput,
): Result<EngineeringPlan> {
  const parsed = engineeringPlanInputSchema.safeParse(input);
  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const candidate = {
    ...parsed.data,
    contentDigest: engineeringPlanContentDigest(parsed.data),
  };
  const validated = engineeringPlanSchema.safeParse(candidate);
  if (!validated.success) {
    return validationError(validated.error);
  }

  return ok(immutablePlan(validated.data));
}

const statusOrder: readonly EngineeringPlanStatus[] = [
  EngineeringPlanStatus.Draft,
  EngineeringPlanStatus.ReadyForApproval,
  EngineeringPlanStatus.Approved,
  EngineeringPlanStatus.SentToCodex,
  EngineeringPlanStatus.Completed,
];

export function transitionEngineeringPlan(
  plan: EngineeringPlan,
  toStatus: EngineeringPlanStatus,
): Result<EngineeringPlan> {
  const fromIndex = statusOrder.indexOf(plan.status);
  const toIndex = statusOrder.indexOf(toStatus);

  if (toIndex !== fromIndex + 1) {
    return err(
      'ILLEGAL_ENGINEERING_PLAN_TRANSITION',
      `Illegal engineering plan transition from "${plan.status}" to "${toStatus}"`,
    );
  }

  return ok(
    immutablePlan({
      ...plan,
      requirements: [...plan.requirements],
      constraints: [...plan.constraints],
      acceptanceCriteria: [...plan.acceptanceCriteria],
      assumptions: [...plan.assumptions],
      risks: [...plan.risks],
      status: toStatus,
      updatedAt: new Date().toISOString(),
    }),
  );
}

export function toJSON(plan: EngineeringPlan): string {
  return JSON.stringify(plan);
}

export function parseEngineeringPlan(json: string): Result<EngineeringPlan> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return err(
      'INVALID_ENGINEERING_PLAN',
      'Invalid engineering plan field "json": malformed JSON',
    );
  }

  const parsed = engineeringPlanSchema.safeParse(value);
  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const expectedDigest = engineeringPlanContentDigest(parsed.data);
  if (parsed.data.contentDigest !== expectedDigest) {
    return err(
      'INVALID_ENGINEERING_PLAN',
      'Invalid engineering plan field "contentDigest": does not match the plan content',
    );
  }

  return ok(immutablePlan(parsed.data));
}
