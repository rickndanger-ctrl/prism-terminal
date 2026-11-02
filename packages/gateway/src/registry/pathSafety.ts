import { realpathSync } from 'node:fs';
import path from 'node:path';

import { err, ok, type Result } from '@codex-lens/shared';

import type { RegistryRecord } from './projectRegistry.js';

export function canonicalizePath(candidatePath: string): string {
  return realpathSync.native(path.resolve(candidatePath));
}

/**
 * Containment check that never touches the filesystem. Both arguments must
 * already be canonical: this cannot see through a symlink, so passing it a
 * raw path proves nothing about where that path really lands. Use it only for
 * paths that cannot be canonicalized because they do not exist yet, and only
 * after the nearest existing ancestor has been canonicalized and checked.
 */
export function isInsideRootLexically(
  canonicalCandidate: string,
  canonicalRoot: string,
): boolean {
  const relative = path.relative(canonicalRoot, canonicalCandidate);

  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

export function isWithinRoot(candidate: string, root: string): boolean {
  try {
    return isInsideRootLexically(
      canonicalizePath(candidate),
      canonicalizePath(root),
    );
  } catch {
    return false;
  }
}

export function assertCommandAllowed(
  command: string,
  allowedCommands: readonly string[],
): Result<void> {
  if (!allowedCommands.includes(command)) {
    return err('COMMAND_NOT_ALLOWED', `Command is not allowed: "${command}"`);
  }

  return ok(undefined);
}

export function resolveWorkingDir(
  project: RegistryRecord,
  requestedPath?: string,
): Result<string> {
  let canonicalProjectPath: string;
  try {
    canonicalProjectPath = canonicalizePath(project.path);
  } catch {
    return err(
      'INVALID_PROJECT_PATH',
      `Project path does not exist or cannot be resolved: "${project.path}"`,
    );
  }

  if (requestedPath === undefined) {
    return ok(canonicalProjectPath);
  }

  const candidatePath = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(canonicalProjectPath, requestedPath);

  let canonicalCandidatePath: string;
  try {
    canonicalCandidatePath = canonicalizePath(candidatePath);
  } catch {
    return err(
      'INVALID_WORKING_DIRECTORY',
      `Requested working directory does not exist or cannot be resolved: "${requestedPath}"`,
    );
  }

  if (!isWithinRoot(canonicalCandidatePath, canonicalProjectPath)) {
    return err(
      'WORKING_DIRECTORY_OUTSIDE_PROJECT',
      `Requested working directory is outside project "${project.id}"`,
    );
  }

  return ok(canonicalCandidatePath);
}
