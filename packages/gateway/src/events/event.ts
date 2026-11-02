import { err, ok, type Result } from '@codex-lens/shared';
import { z } from 'zod';

export const CODEX_LENS_EVENT_TYPES = [
  'queued',
  'running',
  'log',
  'paused',
  'complete',
  'failed',
  'cancelled',
] as const;

const nonEmptyString = z.string().trim().min(1);

const codexLensEventObjectSchema = z
  .object({
    id: nonEmptyString,
    taskId: nonEmptyString,
    seq: z.number().int().nonnegative(),
    type: z.enum(CODEX_LENS_EVENT_TYPES),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const CodexLensEventSchema = codexLensEventObjectSchema.readonly();

export const AppendEventSchema = codexLensEventObjectSchema
  .omit({ seq: true })
  .readonly();

export type CodexLensEvent = z.output<typeof CodexLensEventSchema>;
export type AppendEventInput = z.input<typeof AppendEventSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export function parseCodexLensEvent(input: unknown): Result<CodexLensEvent> {
  const parsed = CodexLensEventSchema.safeParse(input);
  if (!parsed.success) {
    return err('INVALID_CODEX_LENS_EVENT', formatIssues(parsed.error));
  }

  return ok(
    Object.freeze({
      ...parsed.data,
      payload: Object.freeze({ ...parsed.data.payload }),
    }),
  );
}
