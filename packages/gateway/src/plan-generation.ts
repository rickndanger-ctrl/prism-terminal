import { lstatSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  createExecutionPlan,
  err,
  ok,
  type EstimateLevel,
  type ExecutionPlan,
  type Result,
} from '@codex-lens/shared';

import { assertEditableTarget, resolveRepo } from './registry.js';
import { canonicalizePath, isInsideRootLexically } from './registry/index.js';

/**
 * The sample repo declares `"test": "node --test test/calculator.js"`, so
 * `npm test` is the command an execution against it is expected to run.
 */
export const SAMPLE_REPO_TEST_COMMAND = 'npm test';

export interface ExecutionPlanRequest {
  /** The requested change, as the requester wrote it. */
  text: string;
  /** The engineering plan this execution plan is derived from. */
  engineeringPlanId: string;
  filesToModify?: readonly string[];
  filesToCreate?: readonly string[];
  filesToDelete?: readonly string[];
}

interface ResolvedFiles {
  modify: string[];
  create: string[];
  delete: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * POSIX single-quoting. Everything inside single quotes is literal except a
 * single quote itself, which is spliced in as `'\''`. Filenames may legally
 * contain quotes, spaces and `$`, so a path is never interpolated into a
 * rollback command raw.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function exists(candidatePath: string): boolean {
  try {
    // `lstat`, not `stat`: a dangling symlink is still something we refuse to
    // overwrite, and a live one is not a path we may create through.
    lstatSync(candidatePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The deepest ancestor of `candidatePath` that exists on disk. Every create
 * target has one, because the repo root itself is known to exist.
 */
function nearestExistingAncestor(candidatePath: string): string {
  let current = path.dirname(candidatePath);
  while (!exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

/**
 * Resolves one requested file to a canonical path inside `canonicalRepoRoot`,
 * or explains why it is not a legal target.
 *
 * `mustExist` files are canonicalized outright, which resolves any symlink
 * before the containment check. Create targets cannot be canonicalized — they
 * are not there yet — so instead the nearest existing ancestor is canonicalized
 * and checked, which catches a create path routed through an in-repo symlink
 * that points outside the repo. Lexical containment alone would miss that.
 */
function resolvePlanFile(
  requestedPath: string,
  canonicalRepoRoot: string,
  mustExist: boolean,
): Result<string> {
  if (!isNonEmptyString(requestedPath)) {
    return err('INVALID_PLAN_REQUEST', 'Every plan file must be a non-empty string');
  }

  const candidatePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(canonicalRepoRoot, requestedPath);

  if (mustExist) {
    const editable = assertEditableTarget(candidatePath);
    if (!editable.ok) {
      return editable;
    }
    if (!isInsideRootLexically(editable.value, canonicalRepoRoot)) {
      return err(
        'PLAN_FILE_OUTSIDE_REPO',
        `Plan file is outside the requested repo: "${requestedPath}"`,
      );
    }
    if (!statSync(editable.value).isFile()) {
      return err(
        'PLAN_FILE_NOT_A_FILE',
        `Plan file is not a regular file: "${requestedPath}"`,
      );
    }
    return ok(editable.value);
  }

  // Containment is proven before existence is reported on, so a create target
  // outside the repo is refused as such rather than having its presence
  // disclosed by the "already exists" branch below.
  const ancestor = nearestExistingAncestor(candidatePath);
  const editableAncestor = assertEditableTarget(ancestor);
  if (!editableAncestor.ok) {
    return editableAncestor;
  }
  if (!statSync(editableAncestor.value).isDirectory()) {
    return err(
      'PLAN_FILE_OUTSIDE_REPO',
      `Plan file to create is not under a directory: "${requestedPath}"`,
    );
  }
  if (!isInsideRootLexically(editableAncestor.value, canonicalRepoRoot)) {
    return err(
      'PLAN_FILE_OUTSIDE_REPO',
      `Plan file to create is outside the requested repo: "${requestedPath}"`,
    );
  }

  if (exists(candidatePath)) {
    return err(
      'PLAN_CREATE_TARGET_EXISTS',
      `Plan file to create already exists: "${requestedPath}"`,
    );
  }

  // Re-anchor the not-yet-existing segments onto the canonical ancestor, so
  // the plan records where the file will really land rather than the spelling
  // the caller happened to use.
  const resolvedPath = path.join(
    editableAncestor.value,
    path.relative(ancestor, candidatePath),
  );
  if (!isInsideRootLexically(resolvedPath, canonicalRepoRoot)) {
    return err(
      'PLAN_FILE_OUTSIDE_REPO',
      `Plan file to create is outside the requested repo: "${requestedPath}"`,
    );
  }

  return ok(resolvedPath);
}

function resolvePlanFiles(
  request: ExecutionPlanRequest,
  canonicalRepoRoot: string,
): Result<ResolvedFiles> {
  const resolved: ResolvedFiles = { modify: [], create: [], delete: [] };
  const groups = [
    { key: 'modify', requested: request.filesToModify ?? [], mustExist: true },
    { key: 'create', requested: request.filesToCreate ?? [], mustExist: false },
    { key: 'delete', requested: request.filesToDelete ?? [], mustExist: true },
  ] as const;

  // Claimed after canonicalization, so two spellings of one file collide the
  // same way two identical spellings do. Modifying and deleting the same file
  // is not a plan an executor can carry out, and neither is creating a file
  // twice; both are refused rather than silently resolved to one of them.
  const claimedBy = new Map<string, string>();

  for (const group of groups) {
    for (const requestedPath of group.requested) {
      const file = resolvePlanFile(requestedPath, canonicalRepoRoot, group.mustExist);
      if (!file.ok) {
        return file;
      }
      const claimant = claimedBy.get(file.value);
      if (claimant !== undefined) {
        return err(
          'PLAN_CONFLICTING_FILE',
          claimant === group.key
            ? `Plan lists the same file to ${group.key} twice: "${requestedPath}"`
            : `Plan cannot both ${claimant} and ${group.key} the same file: "${requestedPath}"`,
        );
      }
      claimedBy.set(file.value, group.key);
      resolved[group.key].push(file.value);
    }
  }

  if (
    resolved.modify.length + resolved.create.length + resolved.delete.length ===
    0
  ) {
    return err(
      'PLAN_NO_FILES',
      'An execution plan must touch at least one file',
    );
  }

  return ok(resolved);
}

function relative(canonicalRepoRoot: string, file: string): string {
  return path.relative(canonicalRepoRoot, file);
}

function implementationSteps(
  request: ExecutionPlanRequest,
  files: ResolvedFiles,
  canonicalRepoRoot: string,
): string[] {
  const rel = (file: string): string => relative(canonicalRepoRoot, file);

  return [
    `Restate the requested change and confirm its scope: ${request.text.trim()}`,
    `Run \`${SAMPLE_REPO_TEST_COMMAND}\` to record the baseline before editing.`,
    ...files.modify.map(
      (file) => `Edit ${rel(file)} so it satisfies the requested change.`,
    ),
    ...files.create.map(
      (file) => `Create ${rel(file)} with the code the requested change needs.`,
    ),
    ...files.delete.map(
      (file) => `Delete ${rel(file)} and update every reference to it.`,
    ),
    `Run \`${SAMPLE_REPO_TEST_COMMAND}\` again and confirm it exits 0.`,
  ];
}

/**
 * Coarse, deliberately boring heuristics: deletions are the least reversible
 * change and dominate risk, and every touched file adds complexity.
 */
function estimatedRisk(files: ResolvedFiles): EstimateLevel {
  if (files.delete.length > 0) {
    return 'High';
  }
  if (files.create.length > 0 || files.modify.length > 2) {
    return 'Medium';
  }
  return 'Low';
}

function estimatedComplexity(files: ResolvedFiles): EstimateLevel {
  const touched = files.modify.length + files.create.length + files.delete.length;
  if (touched > 3) {
    return 'High';
  }
  if (touched > 1) {
    return 'Medium';
  }
  return 'Low';
}

/** Minutes, including the two test runs the steps call for. */
function estimatedDuration(files: ResolvedFiles): number {
  return (
    5 + files.modify.length * 5 + files.create.length * 8 + files.delete.length * 5
  );
}

/**
 * File-scoped rollback. A blanket `git restore .` would also discard
 * uncommitted work this plan never touched, so each file is named: tracked
 * edits and deletions are restored from HEAD, and created files are removed
 * because HEAD has nothing to restore them to.
 */
function rollbackStrategy(files: ResolvedFiles): string {
  const commands = [
    ...files.modify.map((file) => `git restore -- ${shellQuote(file)}`),
    ...files.delete.map((file) => `git restore -- ${shellQuote(file)}`),
    ...files.create.map((file) => `rm -f ${shellQuote(file)}`),
  ];

  return [
    'Roll back only the files this plan names, leaving unrelated uncommitted work in place.',
    `From inside the repo, run: ${commands.join('; ')}.`,
    `Then re-run \`${SAMPLE_REPO_TEST_COMMAND}\` to confirm the baseline is restored.`,
  ].join(' ');
}

/**
 * Builds a validated execution plan for a text request against a registered
 * editable repo. Every file the plan names is resolved through the repo
 * registry, so a plan can never point at the codex-lens repo or anywhere else
 * outside the editable target.
 */
export function generateExecutionPlan(
  request: ExecutionPlanRequest,
  repoId: string,
): Result<ExecutionPlan> {
  if (request === null || typeof request !== 'object') {
    return err('INVALID_PLAN_REQUEST', 'Request must be an object');
  }
  if (!isNonEmptyString(request.text)) {
    return err('INVALID_PLAN_REQUEST', 'Request text must be a non-empty string');
  }
  if (!isNonEmptyString(request.engineeringPlanId)) {
    return err(
      'INVALID_PLAN_REQUEST',
      'Request must link a non-empty engineeringPlanId',
    );
  }

  const repo = resolveRepo(repoId);
  if (!repo.ok) {
    return repo;
  }
  if (!repo.value.editable) {
    return err(
      'PLAN_REPO_NOT_EDITABLE',
      `Repo is registered but not editable: "${repoId}"`,
    );
  }

  let canonicalRepoRoot: string;
  try {
    canonicalRepoRoot = canonicalizePath(repo.value.path);
  } catch {
    return err(
      'INVALID_REPO_PATH',
      `Repo path does not exist or cannot be resolved: "${repo.value.path}"`,
    );
  }

  const files = resolvePlanFiles(request, canonicalRepoRoot);
  if (!files.ok) {
    return files;
  }

  return createExecutionPlan({
    engineeringPlanId: request.engineeringPlanId,
    filesToModify: files.value.modify,
    filesToCreate: files.value.create,
    filesToDelete: files.value.delete,
    implementationSteps: implementationSteps(
      request,
      files.value,
      canonicalRepoRoot,
    ),
    expectedCommands: [SAMPLE_REPO_TEST_COMMAND],
    estimatedRisk: estimatedRisk(files.value),
    estimatedComplexity: estimatedComplexity(files.value),
    estimatedDuration: estimatedDuration(files.value),
    rollbackStrategy: rollbackStrategy(files.value),
    executionStatus: 'Pending',
  });
}
