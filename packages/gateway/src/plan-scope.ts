import { existsSync } from 'node:fs';
import path from 'node:path';

import { err, ok, type ExecutionPlan, type Result } from '@codex-lens/shared';

import { resolveRepo } from './registry.js';
import { canonicalizePath } from './registry/index.js';

/**
 * What the approved plan says may happen to a file. The three lists an approval
 * binds are not interchangeable: a reviewer who approved creating a file did not
 * approve overwriting an existing one, and a reviewer who approved deleting a
 * file did not approve rewriting it.
 */
export type PlanFileRole = 'modify' | 'create' | 'delete';

export interface PlanScope {
  /**
   * Repo-relative, slash-separated path → the role the plan gave it. A sandbox
   * is a copy of the repo root, so these keys are equally sandbox-relative.
   */
  roles: ReadonlyMap<string, PlanFileRole>;
}

/** The path spelling used as a scope key, matching `sandbox.ts`'s `gitPath`. */
function toRepoRelative(root: string, file: string): string {
  return path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
}

/**
 * Reduces the plan's three file lists to the scope a write is held to.
 *
 * Plan files are absolute paths under the canonical repo root — that is what
 * `generateExecutionPlan` resolved them to — while Codex answers in paths
 * relative to the sandbox it was given. Both are put in one spelling here so
 * the comparison is between paths, not between strings that happen to look
 * alike.
 *
 * The repo is named by id and re-resolved rather than taken as a root, so the
 * scope is anchored to a registered repo and nothing else.
 */
export function resolvePlanScope(
  plan: ExecutionPlan,
  repoId: string,
): Result<PlanScope> {
  const repo = resolveRepo(repoId);
  if (!repo.ok) {
    return repo;
  }

  let root: string;
  try {
    root = canonicalizePath(repo.value.path);
  } catch {
    return err(
      'INVALID_REPO_PATH',
      `Repo path does not exist or cannot be resolved: "${repo.value.path}"`,
    );
  }

  const roles = new Map<string, PlanFileRole>();
  const groups: readonly (readonly [PlanFileRole, readonly string[]])[] = [
    ['modify', plan.filesToModify],
    ['create', plan.filesToCreate],
    ['delete', plan.filesToDelete],
  ];

  for (const [role, files] of groups) {
    for (const file of files) {
      const relative = toRepoRelative(root, file);
      // A plan file that does not land inside the repo cannot be scoped, and a
      // scope that quietly dropped it would be a scope that permits nothing
      // while claiming to describe the plan. Refused rather than skipped.
      if (relative === '' || relative.startsWith('../') || path.isAbsolute(relative)) {
        return err(
          'PLAN_FILE_OUTSIDE_REPO',
          `Plan file is outside repo "${repoId}": "${file}"`,
        );
      }
      roles.set(relative, role);
    }
  }

  return ok({ roles });
}

/**
 * Decides whether writing `relPath` is something the approved plan authorizes.
 *
 * This is the check that makes an approval mean what a reviewer read. Codex is
 * asked to implement the plan, but nothing about a language model's answer is
 * bound by it: the edits that come back are a proposal, and this is where that
 * proposal is held to the file lists the digest covered. A path the plan never
 * named is refused, and so is a path the plan named for a different purpose.
 *
 * Role is checked against the sandbox as it stands, because the roles are
 * claims about the filesystem and only the filesystem can answer them. Writing
 * a `create` path that already exists is an overwrite of a file the reviewer
 * was told would be new; writing a `modify` path that is not there is a
 * creation the reviewer was told was an edit to something existing. Both are
 * changes the approval does not cover, however honest the intent behind them.
 */
export function assertEditInScope(
  scope: PlanScope,
  sandboxRoot: string,
  relPath: string,
): Result<void> {
  const relative = toRepoRelative(sandboxRoot, relPath);
  const role = scope.roles.get(relative);

  if (role === undefined) {
    return err(
      'PLAN_FILE_OUT_OF_SCOPE',
      `Codex returned an edit to a file the approved plan does not name: "${relPath}"`,
    );
  }

  if (role === 'delete') {
    return err(
      'PLAN_FILE_ROLE_MISMATCH',
      `The approved plan names "${relPath}" for deletion, so it may not be written`,
    );
  }

  const present = existsSync(path.resolve(sandboxRoot, relative));
  if (role === 'create' && present) {
    return err(
      'PLAN_FILE_ROLE_MISMATCH',
      `The approved plan names "${relPath}" as a file to create, but it already exists, so writing it would overwrite a file the approval does not cover`,
    );
  }
  if (role === 'modify' && !present) {
    return err(
      'PLAN_FILE_ROLE_MISMATCH',
      `The approved plan names "${relPath}" as a file to modify, but it does not exist, so writing it would create a file the approval does not cover`,
    );
  }

  return ok(undefined);
}
