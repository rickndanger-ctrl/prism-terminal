import { err, ok, type Result } from '@codex-lens/shared';
import { z } from 'zod';

export const BoundaryBadRequestSchema = z
  .object({
    statusCode: z.literal(400),
    error: z.literal('Bad Request'),
    message: z.string().min(1),
  })
  .strict();

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export function validateBoundary<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
  errorCode: string,
): Result<z.output<TSchema>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return err(errorCode, formatIssues(parsed.error));
  }

  return ok(parsed.data);
}
