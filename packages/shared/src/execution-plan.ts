import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { contentDigest } from './digest.js';
import { err, ok, type Result } from './result.js';

export const EXECUTION_STATUSES = [
  'Pending',
  'Ready',
  'Running',
  'Blocked',
  'Complete',
  'Failed',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const ESTIMATE_LEVELS = ['Low', 'Medium', 'High'] as const;
export type EstimateLevel = (typeof ESTIMATE_LEVELS)[number];

const isoDateTime = z.iso
  .datetime({ offset: true })
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'must be a parseable ISO-8601 date-time',
  });

const nonEmptyString = z.string().min(1);
const stringList = z.array(nonEmptyString).readonly();

const contentFieldsSchema = z.object({
  engineeringPlanId: nonEmptyString,
  filesToModify: stringList,
  filesToCreate: stringList,
  filesToDelete: stringList,
  implementationSteps: stringList,
  expectedCommands: stringList,
  estimatedRisk: z.enum(ESTIMATE_LEVELS),
  estimatedComplexity: z.enum(ESTIMATE_LEVELS),
  /** Estimated duration in minutes. */
  estimatedDuration: z.number().int().positive(),
  rollbackStrategy: nonEmptyString,
  executionStatus: z.enum(EXECUTION_STATUSES),
});

type ExecutionPlanContent = z.output<typeof contentFieldsSchema>;

function planContent(plan: ExecutionPlanContent): ExecutionPlanContent {
  return Object.fromEntries(
    Object.keys(contentFieldsSchema.shape).map((key) => [
      key,
      plan[key as keyof ExecutionPlanContent],
    ]),
  ) as unknown as ExecutionPlanContent;
}

export function executionPlanContentDigest(plan: ExecutionPlanContent): string {
  return contentDigest(planContent(plan));
}

export const executionPlanSchema = contentFieldsSchema
  .extend({
    executionPlanId: z.uuid(),
    version: z.number().int().min(1),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .readonly();

export type ExecutionPlan = z.output<typeof executionPlanSchema>;

const createExecutionPlanInputSchema = contentFieldsSchema
  .extend({
    executionStatus: z.enum(EXECUTION_STATUSES).default('Pending'),
  })
  .strict();

export type CreateExecutionPlanInput = z.input<
  typeof createExecutionPlanInputSchema
>;

export type ExecutionPlanJson = {
  -readonly [
    K in keyof ExecutionPlan
  ]: ExecutionPlan[K] extends readonly (infer E)[] ? E[] : ExecutionPlan[K];
};

const allowedTransitions: Readonly<
  Record<ExecutionStatus, readonly ExecutionStatus[]>
> = {
  Pending: ['Ready'],
  Ready: ['Running'],
  Running: ['Blocked', 'Complete', 'Failed'],
  Blocked: ['Ready'],
  Complete: [],
  Failed: [],
};

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export function createExecutionPlan(
  input: CreateExecutionPlanInput,
): Result<ExecutionPlan> {
  const parsedInput = createExecutionPlanInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return err('EXECUTION_PLAN_INVALID_INPUT', formatIssues(parsedInput.error));
  }
  const now = new Date().toISOString();
  const parsed = executionPlanSchema.safeParse({
    ...parsedInput.data,
    executionPlanId: randomUUID(),
    version: 1,
    createdAt: now,
    updatedAt: now,
    contentDigest: executionPlanContentDigest(parsedInput.data),
  });
  if (!parsed.success) {
    return err('EXECUTION_PLAN_INVALID', formatIssues(parsed.error));
  }
  return ok(parsed.data);
}

export function parseExecutionPlan(json: unknown): Result<ExecutionPlan> {
  const parsed = executionPlanSchema.safeParse(json);
  if (!parsed.success) {
    return err('EXECUTION_PLAN_INVALID', formatIssues(parsed.error));
  }
  if (executionPlanContentDigest(parsed.data) !== parsed.data.contentDigest) {
    return err(
      'EXECUTION_PLAN_DIGEST_MISMATCH',
      'contentDigest does not match the content fields',
    );
  }
  return ok(parsed.data);
}

export function transitionExecutionPlan(
  plan: ExecutionPlan,
  toStatus: ExecutionStatus,
): Result<ExecutionPlan> {
  if (!allowedTransitions[plan.executionStatus].includes(toStatus)) {
    return err(
      'EXECUTION_PLAN_INVALID_TRANSITION',
      `Cannot transition execution plan from ${plan.executionStatus} to ${toStatus}`,
    );
  }

  const updatedAt = new Date(
    Math.max(Date.now(), Date.parse(plan.updatedAt) + 1),
  ).toISOString();
  const content = {
    ...Object.fromEntries(
      Object.keys(contentFieldsSchema.shape).map((key) => [
        key,
        plan[key as keyof typeof contentFieldsSchema.shape],
      ]),
    ),
    executionStatus: toStatus,
  };
  const parsed = executionPlanSchema.safeParse({
    ...plan,
    executionStatus: toStatus,
    updatedAt,
    contentDigest: executionPlanContentDigest(content as ExecutionPlanContent),
  });
  if (!parsed.success) {
    return err('EXECUTION_PLAN_INVALID', formatIssues(parsed.error));
  }

  return ok(parsed.data);
}

export function toJSON(plan: ExecutionPlan): ExecutionPlanJson {
  return {
    ...plan,
    filesToModify: [...plan.filesToModify],
    filesToCreate: [...plan.filesToCreate],
    filesToDelete: [...plan.filesToDelete],
    implementationSteps: [...plan.implementationSteps],
    expectedCommands: [...plan.expectedCommands],
  };
}
