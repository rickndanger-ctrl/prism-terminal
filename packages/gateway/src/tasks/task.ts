import { err, ok, type Result } from '@codex-lens/shared';
import { z } from 'zod';

export const TASK_STATES = [
  'queued',
  'running',
  'paused',
  'complete',
  'failed',
  'cancelled',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

const nonEmptyString = z.string().trim().min(1);

const taskObjectSchema = z
  .object({
    id: nonEmptyString,
    projectId: nonEmptyString,
    state: z.enum(TASK_STATES),
    idempotencyKey: nonEmptyString,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const TaskSchema = taskObjectSchema.readonly();

export const CreateTaskSchema = taskObjectSchema
  .pick({ projectId: true, idempotencyKey: true })
  .readonly();

export type Task = z.output<typeof TaskSchema>;
export type CreateTaskInput = z.input<typeof CreateTaskSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export function parseTask(input: unknown): Result<Task> {
  const parsed = TaskSchema.safeParse(input);
  if (!parsed.success) {
    return err('INVALID_TASK', formatIssues(parsed.error));
  }

  return ok(Object.freeze({ ...parsed.data }));
}

export function parseCreateTaskInput(
  input: unknown,
): Result<z.output<typeof CreateTaskSchema>> {
  const parsed = CreateTaskSchema.safeParse(input);
  if (!parsed.success) {
    return err('INVALID_CREATE_TASK_INPUT', formatIssues(parsed.error));
  }

  return ok(Object.freeze({ ...parsed.data }));
}
