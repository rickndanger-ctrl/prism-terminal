import { err, ok, type Result } from '@codex-lens/shared';

import { canonicalizePath, isWithinRoot } from './registry/pathSafety.js';
import { CODEX_LENS_REPO_ROOT, REPO_REGISTRY } from './registryConfig.js';

export interface RegisteredRepo {
  id: string;
  path: string;
  editable: boolean;
}

function hasTraversalSegment(candidatePath: string): boolean {
  return candidatePath.split(/[\\/]+/u).includes('..');
}

export function resolveRepo(id: string): Result<RegisteredRepo> {
  if (typeof id !== 'string' || id.trim().length === 0) {
    return err('INVALID_REPO_ID', 'Repo id must be a non-empty string');
  }

  const entry = REPO_REGISTRY.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    return err('UNKNOWN_REPO', `Repo is not registered: "${id}"`);
  }

  return ok({ id: entry.id, path: entry.path, editable: entry.editable });
}

export function assertEditableTarget(targetPath: string): Result<string> {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    return err('INVALID_TARGET_PATH', 'Target path must be a non-empty string');
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = canonicalizePath(targetPath);
  } catch {
    return err(
      'INVALID_TARGET_PATH',
      `Target path does not exist or cannot be resolved: "${targetPath}"`,
    );
  }

  let canonicalCodexLensRoot: string;
  try {
    canonicalCodexLensRoot = canonicalizePath(CODEX_LENS_REPO_ROOT);
  } catch {
    return err(
      'INVALID_REGISTRY_CONFIG',
      'The codex-lens repo root cannot be resolved',
    );
  }

  if (canonicalTarget === canonicalCodexLensRoot) {
    return err(
      'CODEX_LENS_ROOT_FORBIDDEN',
      'The codex-lens repo root is never an editable target',
    );
  }

  const owner = REPO_REGISTRY.find(
    (entry) => entry.editable && isWithinRoot(canonicalTarget, entry.path),
  );
  if (owner === undefined) {
    if (hasTraversalSegment(targetPath)) {
      return err(
        'PATH_TRAVERSAL_REJECTED',
        `Target path escapes the registered editable repo via "..": "${targetPath}"`,
      );
    }
    return err(
      'TARGET_NOT_EDITABLE',
      `Target path is not within a registered editable repo: "${targetPath}"`,
    );
  }

  return ok(canonicalTarget);
}

export { REPO_REGISTRY } from './registryConfig.js';
export type { RepoRegistryEntry } from './registryConfig.js';
