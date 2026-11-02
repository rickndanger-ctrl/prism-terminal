import { err, ok, type Result } from '@codex-lens/shared';
import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);

export const RegistryRecordSchema = z
  .object({
    id: nonEmptyString,
    displayName: nonEmptyString,
    path: nonEmptyString,
    allowedCommands: z.array(nonEmptyString).readonly(),
    allowWorkspaceWrite: z.boolean(),
    allowDependencyInstall: z.boolean(),
    allowCommit: z.boolean(),
    allowPush: z.boolean(),
    allowDeploy: z.boolean(),
  })
  .strict()
  .readonly();

export const projectRegistryRecordSchema = RegistryRecordSchema;

export type RegistryRecord = z.output<typeof RegistryRecordSchema>;
export type RegistryRecordInput = z.input<typeof RegistryRecordSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export function parseRegistryRecord(input: unknown): Result<RegistryRecord> {
  const parsed = RegistryRecordSchema.safeParse(input);
  if (!parsed.success) {
    return err('INVALID_REGISTRY_RECORD', formatIssues(parsed.error));
  }

  return ok(
    Object.freeze({
      ...parsed.data,
      allowedCommands: Object.freeze([...parsed.data.allowedCommands]),
    }),
  );
}
