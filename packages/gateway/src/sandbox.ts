import { spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { err, ok, type Result } from '@codex-lens/shared';

import { canonicalizePath, isWithinRoot } from './registry/pathSafety.js';
import { assertEditableTarget, resolveRepo } from './registry.js';

const GIT_TIMEOUT_MS = 60_000;

/** Never copied into a sandbox: the source VCS state and installed packages. */
const EXCLUDED_FROM_COPY = new Set(['.git', 'node_modules']);

const GIT_DIR = '.git';
const SANDBOX_PREFIX = 'codex-lens-sandbox-';
const SANDBOX_BRANCH = 'sandbox';
const BASELINE_MESSAGE = 'sandbox baseline';

export interface SandboxHandle {
  /**
   * Absolute path to the isolated working copy. Named `root` so a handle is
   * structurally usable as the `Sandbox` that `runTests` takes.
   */
  root: string;
  /** Registry id the sandbox was prepared from. */
  repoId: string;
  /**
   * The repo this copy came from, for reference only. Never trusted for
   * authorization — `writeFileInSandbox` re-resolves the source from `repoId`
   * so tampering with this field cannot widen what a write may touch.
   */
  sourceRoot: string;
  /** Commit holding the pristine copy; `rollback` returns the tree to it. */
  baselineCommit: string;
}

interface SandboxRecord {
  repoId: string;
  sourceRoot: string;
  baselineCommit: string;
  /**
   * Every path `writeFileInSandbox` has permitted, sandbox-relative and
   * slash-separated for use as a git pathspec.
   *
   * `assertTrackable` asks whether a write is visible to git *at the moment it
   * is made*, but that answer can be revoked afterwards: a later, entirely
   * legitimate write to `.gitignore` can ignore a file this module already
   * wrote. From then on `git add -A -N` skips it, so it vanishes from
   * `captureDiff`, and `git clean -fd` spares it, so it outlives `rollback` —
   * a permitted change that is neither reviewable nor undoable, which is the
   * one thing a sandbox may not produce. Naming these paths explicitly is what
   * keeps them accounted for no matter what the ignore rules later say.
   */
  writes: Set<string>;
}

/**
 * The sandboxes this module created, keyed by canonical root.
 *
 * A handle is a plain object, so a caller can hand back one with any `root` it
 * likes. That root is what every later operation acts on: it is the cwd of
 * `git reset --hard` and `git clean -fd`, and the argument to `rm -rf`. Nothing
 * about the string itself distinguishes a real sandbox from a source checkout
 * or a home directory, so a handle is not evidence — it is a lookup key, and
 * only a root this module minted and has not yet disposed is honoured.
 */
const LIVE_SANDBOXES = new Map<string, SandboxRecord>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The baseline is the only caller-reachable value that reaches a git argv.
 * Requiring a bare object name keeps it from being read as an option, so no
 * git invocation here can be steered by the contents of a handle.
 */
const OBJECT_NAME = /^[0-9a-f]{7,64}$/u;

interface AuthenticSandbox {
  /** Canonical root, resolved from disk rather than taken from the handle. */
  root: string;
  record: SandboxRecord;
}

/**
 * Resolves a handle to a sandbox this module actually created, or refuses.
 *
 * Every operation that touches the filesystem or a git argv goes through here
 * first, so an unrecognized root is rejected before anything is read, reset,
 * cleaned, or removed.
 */
function authenticate(sandbox: SandboxHandle): Result<AuthenticSandbox> {
  if (typeof sandbox.root !== 'string' || sandbox.root.trim().length === 0) {
    return err(
      'INVALID_SANDBOX_ROOT',
      'Sandbox root must be a non-empty string',
    );
  }

  let root: string;
  try {
    root = canonicalizePath(sandbox.root);
  } catch {
    return err(
      'INVALID_SANDBOX_ROOT',
      `Sandbox root does not exist or cannot be resolved: "${sandbox.root}"`,
    );
  }

  const record = LIVE_SANDBOXES.get(root);
  if (record === undefined) {
    return err(
      'UNKNOWN_SANDBOX',
      `Not a live sandbox created by prepareSandbox: "${sandbox.root}"`,
    );
  }

  return ok({ root, record });
}

/**
 * The baseline a git command may name. Shape is checked first so a handle
 * carrying an option-shaped string is refused as such; the value is then held
 * to the one this module recorded, so a well-formed but foreign commit cannot
 * steer a reset either.
 */
function assertBaseline(
  sandbox: SandboxHandle,
  record: SandboxRecord,
): Result<string> {
  if (
    typeof sandbox.baselineCommit !== 'string' ||
    !OBJECT_NAME.test(sandbox.baselineCommit)
  ) {
    return err(
      'INVALID_SANDBOX_BASELINE',
      `Sandbox baseline is not a git object name: "${String(sandbox.baselineCommit)}"`,
    );
  }
  if (sandbox.baselineCommit !== record.baselineCommit) {
    return err(
      'SANDBOX_HANDLE_MISMATCH',
      `Sandbox baseline does not match the recorded baseline for this sandbox: "${sandbox.baselineCommit}"`,
    );
  }

  return ok(record.baselineCommit);
}

interface GitOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs git with the caller's config neutralized, so a sandbox behaves the same
 * regardless of the developer's global git settings (identity, hooks, gpg,
 * default branch) and never blocks on a credential prompt. The exit code is
 * returned rather than judged: some callers here ask git a question whose
 * answer is a non-zero exit.
 */
function spawnGit(
  args: readonly string[],
  cwd: string,
): Promise<Result<GitOutcome>> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/u.test(key)) {
      delete env[key];
    }
  }

  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';

  return new Promise((resolve) => {
    // `spawn` reports most failures through the `error` event, but rejects an
    // argument it cannot pass to the OS at all — an embedded NUL being the one
    // that reaches here — by throwing on the spot. Inside this executor that
    // becomes a rejected promise, which every caller `await`s expecting a
    // Result. Caught so a bad argument is an error value like any other.
    let child;
    try {
      child = spawn('git', [...args], {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve(err('GIT_COMMAND_FAILED', errorMessage(error)));
      return;
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, GIT_TIMEOUT_MS);
    timer.unref();

    const settle = (result: Result<GitOutcome>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout.push(chunk));
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));

    child.on('error', (error) => {
      settle(err('GIT_COMMAND_FAILED', errorMessage(error)));
    });

    // `close` rather than `exit`: stdout must be drained before it is read.
    child.on('close', (code, signal) => {
      if (signal === 'SIGKILL') {
        settle(
          err(
            'GIT_COMMAND_TIMED_OUT',
            `git ${args[0] ?? ''} exceeded its ${GIT_TIMEOUT_MS}ms budget`,
          ),
        );
        return;
      }
      settle(ok({ code, stdout: stdout.join(''), stderr: stderr.join('') }));
    });
  });
}

/** Runs git and treats any non-zero exit as a failure. */
async function runGit(
  args: readonly string[],
  cwd: string,
): Promise<Result<string>> {
  const outcome = await spawnGit(args, cwd);
  if (!outcome.ok) {
    return outcome;
  }
  if (outcome.value.code !== 0) {
    return err(
      'GIT_COMMAND_FAILED',
      `git ${args.join(' ')} exited ${String(outcome.value.code)}: ${outcome.value.stderr.trim()}`,
    );
  }

  return ok(outcome.value.stdout);
}

/**
 * Runs a git command whose answer *is* its exit code (`check-ignore`,
 * `ls-files --error-unmatch`): 0 means yes, 1 means no, anything else is a real
 * failure and must not be read as a no.
 */
async function runGitPredicate(
  args: readonly string[],
  cwd: string,
): Promise<Result<boolean>> {
  const outcome = await spawnGit(args, cwd);
  if (!outcome.ok) {
    return outcome;
  }
  const { code, stderr } = outcome.value;
  if (code !== 0 && code !== 1) {
    return err(
      'GIT_COMMAND_FAILED',
      `git ${args.join(' ')} exited ${String(code)}: ${stderr.trim()}`,
    );
  }

  return ok(code === 0);
}

/**
 * Containment decided on the resolved strings alone. `isWithinRoot` canonicalizes
 * and so answers `false` for a path that does not exist yet, which a write
 * creating a new directory legitimately does; the symlink question it exists to
 * answer is asked separately, against the nearest path that is real.
 */
function isLexicallyWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);

  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

/**
 * Deepest ancestor of `target` that exists on disk, `target` itself included.
 * A path that does not exist yet cannot be canonicalized, so containment and
 * editability are decided against the closest real directory above it.
 */
function nearestExistingPath(target: string): string | undefined {
  let current = path.resolve(target);
  for (;;) {
    try {
      realpathSync.native(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}

/**
 * Refuses a write git would not show as a change.
 *
 * An ignored path is invisible to `captureDiff` and survives the `clean` that
 * rollback runs, so a write to one would be a change no reviewer sees and no
 * rollback undoes. Ignored files that were already in the copy are exempt:
 * `prepareSandbox` force-adds them, so they are tracked, and a change to one
 * both shows up in the diff and is restored by `reset --hard`.
 */
async function assertTrackable(
  root: string,
  relative: string,
): Promise<Result<void>> {
  const ignored = await runGitPredicate(
    ['check-ignore', '-q', '--', relative],
    root,
  );
  if (!ignored.ok) {
    return ignored;
  }
  if (!ignored.value) {
    return ok(undefined);
  }

  const tracked = await runGitPredicate(
    ['ls-files', '--error-unmatch', '--', relative],
    root,
  );
  if (!tracked.ok) {
    return tracked;
  }
  if (tracked.value) {
    return ok(undefined);
  }

  return err(
    'SANDBOX_WRITE_NOT_TRACKABLE',
    `Write target is git-ignored, so the change would not appear in a diff or survive a rollback: "${relative}"`,
  );
}

/**
 * The permitted writes still present on disk. A path this module wrote and a
 * later change removed needs no accounting: `git add -A` already reports the
 * deletion of a tracked one, and an untracked one that is gone has nothing to
 * hide. Filtering also keeps git from failing the whole command on a pathspec
 * that matches nothing.
 */
function existingWrites(root: string, writes: ReadonlySet<string>): string[] {
  return [...writes].filter((relative) =>
    existsSync(path.resolve(root, relative)),
  );
}

export async function prepareSandbox(
  repoId: string,
): Promise<Result<SandboxHandle>> {
  const repo = resolveRepo(repoId);
  if (!repo.ok) {
    return repo;
  }

  // The source must itself be an editable target: preparing a sandbox of the
  // codex-lens repo is refused here rather than at write time.
  const editable = assertEditableTarget(repo.value.path);
  if (!editable.ok) {
    return editable;
  }
  const sourceRoot = editable.value;

  let root: string;
  try {
    // realpath first: on macOS os.tmpdir() is a symlink, and an uncanonical
    // root would fail every later containment check.
    root = await mkdtemp(
      path.join(realpathSync.native(os.tmpdir()), SANDBOX_PREFIX),
    );
    root = realpathSync.native(root);
  } catch (error) {
    return err('SANDBOX_CREATE_FAILED', errorMessage(error));
  }

  try {
    await cp(sourceRoot, root, {
      recursive: true,
      dereference: false,
      filter: (src) => !EXCLUDED_FROM_COPY.has(path.basename(src)),
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    return err('SANDBOX_COPY_FAILED', errorMessage(error));
  }

  const steps: readonly (readonly string[])[] = [
    ['init', '-b', SANDBOX_BRANCH],
    // `-f` so ignored files in the copy are part of the baseline too. Without
    // it they would sit outside git's view entirely: absent from every diff,
    // and untouched by both `reset --hard` and a `clean` that spares ignored
    // files. Tracking them is what lets rollback restore the copy as taken.
    ['add', '-A', '-f'],
    [
      '-c',
      'user.name=codex-lens',
      '-c',
      'user.email=codex-lens@invalid',
      'commit',
      '--no-gpg-sign',
      '--allow-empty',
      '-m',
      BASELINE_MESSAGE,
    ],
  ];
  for (const step of steps) {
    const result = await runGit(step, root);
    if (!result.ok) {
      await rm(root, { recursive: true, force: true });
      return result;
    }
  }

  const head = await runGit(['rev-parse', 'HEAD'], root);
  if (!head.ok) {
    await rm(root, { recursive: true, force: true });
    return head;
  }

  const record: SandboxRecord = {
    repoId: repo.value.id,
    sourceRoot,
    baselineCommit: head.value.trim(),
    writes: new Set(),
  };
  LIVE_SANDBOXES.set(root, record);

  // Built field by field rather than spread from the record: the write ledger
  // is this module's own bookkeeping and stays out of the caller's handle.
  return ok({
    root,
    repoId: record.repoId,
    sourceRoot: record.sourceRoot,
    baselineCommit: record.baselineCommit,
  });
}

interface PreparedSandboxWrite {
  root: string;
  record: SandboxRecord;
  target: string;
  gitPath: string;
}

/**
 * Runs every guard required before a sandbox write may touch disk.
 *
 * Three independent guards must all pass. The physical one keeps the write
 * inside the sandbox root — checked lexically, then again against the resolved
 * ancestor so a symlink cannot redirect it out. The policy one runs
 * `assertEditableTarget` on the path this write *stands for* in the real repo:
 * a sandbox lives under a tmp dir, which is not a registered repo, so asking
 * that question about the physical path would reject every write. Asking it
 * about the source path is what actually enforces the ticket-1 rule that only
 * an editable repo may be modified. The third keeps the write reviewable: a
 * change git cannot see is a change nobody can review or undo, so it is refused
 * rather than made invisibly.
 */
async function prepareSandboxWrite(
  sandbox: SandboxHandle,
  relPath: string,
): Promise<Result<PreparedSandboxWrite>> {
  if (typeof relPath !== 'string' || relPath.trim().length === 0) {
    return err(
      'INVALID_SANDBOX_PATH',
      'Sandbox-relative path must be a non-empty string',
    );
  }
  if (path.isAbsolute(relPath)) {
    return err(
      'SANDBOX_ESCAPE_REJECTED',
      `Sandbox-relative path must not be absolute: "${relPath}"`,
    );
  }
  if (relPath.split(/[\\/]+/u).includes('..')) {
    return err(
      'SANDBOX_ESCAPE_REJECTED',
      `Sandbox-relative path must not contain "..": "${relPath}"`,
    );
  }
  // A NUL survives every check below it — it is not a separator, not "..", and
  // resolves like any other character — but no syscall or git argv can carry
  // one. Left alone it reaches `spawn`, which throws where a caller is entitled
  // to a Result. Refused here so the answer is an error, not an exception.
  if (relPath.includes('\0')) {
    return err(
      'INVALID_SANDBOX_PATH',
      'Sandbox-relative path must not contain a NUL character',
    );
  }

  const authentic = authenticate(sandbox);
  if (!authentic.ok) {
    return authentic;
  }
  const { root, record } = authentic.value;

  const target = path.resolve(root, relPath);
  if (target === root || !isLexicallyWithin(target, root)) {
    return err(
      'SANDBOX_ESCAPE_REJECTED',
      `Write target escapes the sandbox root: "${relPath}"`,
    );
  }

  // Decided on the resolved path, not the caller's spelling of it: `.git/x` and
  // `./.git/x` are the same file, and only the resolved form collapses the two.
  // The sandbox's own git dir is the record of what changed, so a write into it
  // would rewrite the very thing captureDiff and rollback read. Matched
  // case-insensitively because a case-insensitive filesystem — the default on
  // macOS and Windows — opens `.GIT/config` as `.git/config` regardless of how
  // this module spells it.
  const targetSegments = path.relative(root, target).split(path.sep);
  if (targetSegments.some((segment) => segment.toLowerCase() === GIT_DIR)) {
    return err(
      'SANDBOX_WRITE_NOT_TRACKABLE',
      `Sandbox-relative path must not be inside a git directory: "${relPath}"`,
    );
  }

  // Re-resolve the source from the id: the handle's own sourceRoot is untrusted.
  // The id itself is taken as the caller gives it rather than from the record,
  // so this asks the editability question about the repo the caller claims the
  // write is for. A false claim cannot widen anything — the write has already
  // been confined to the sandbox root above, and `resolveRepo` only ever
  // answers with a registered repo — it can only get the write refused.
  const repo = resolveRepo(sandbox.repoId);
  if (!repo.ok) {
    return repo;
  }
  const logicalTarget = path.resolve(repo.value.path, relPath);
  const logicalExisting = nearestExistingPath(logicalTarget);
  if (logicalExisting === undefined) {
    return err(
      'INVALID_TARGET_PATH',
      `Target path cannot be resolved in repo "${sandbox.repoId}": "${relPath}"`,
    );
  }
  const editable = assertEditableTarget(logicalExisting);
  if (!editable.ok) {
    return editable;
  }

  // A symlink already at the target would write through to its destination.
  try {
    if (lstatSync(target).isSymbolicLink()) {
      return err(
        'SANDBOX_ESCAPE_REJECTED',
        `Write target is a symlink: "${relPath}"`,
      );
    }
  } catch {
    // Target does not exist yet; nothing to write through.
  }

  // Resolve the deepest real directory above the target before creating
  // anything, so mkdir cannot follow a symlink out of the sandbox.
  const physicalExisting = nearestExistingPath(target);
  if (physicalExisting === undefined || !isWithinRoot(physicalExisting, root)) {
    return err(
      'SANDBOX_ESCAPE_REJECTED',
      `Write target escapes the sandbox root: "${relPath}"`,
    );
  }

  const gitPath = targetSegments.join('/');
  const trackable = await assertTrackable(root, gitPath);
  if (!trackable.ok) {
    return trackable;
  }

  return ok({ root, record, target, gitPath });
}

/**
 * Validates that `relPath` could be written through `writeFileInSandbox`
 * without materializing it. Callers that apply a batch can preflight every
 * path before allowing the first write.
 */
export async function validateSandboxWrite(
  sandbox: SandboxHandle,
  relPath: string,
): Promise<Result<void>> {
  const prepared = await prepareSandboxWrite(sandbox, relPath);
  return prepared.ok ? ok(undefined) : prepared;
}

/** Writes `content` to `relPath` inside the sandbox after full validation. */
export async function writeFileInSandbox(
  sandbox: SandboxHandle,
  relPath: string,
  content: string,
): Promise<Result<string>> {
  const prepared = await prepareSandboxWrite(sandbox, relPath);
  if (!prepared.ok) {
    return prepared;
  }
  const { root, record, target, gitPath } = prepared.value;

  try {
    await mkdir(path.dirname(target), { recursive: true });
  } catch (error) {
    return err('SANDBOX_WRITE_FAILED', errorMessage(error));
  }

  if (!isWithinRoot(path.dirname(target), root)) {
    return err(
      'SANDBOX_ESCAPE_REJECTED',
      `Write target escapes the sandbox root: "${relPath}"`,
    );
  }

  try {
    await writeFile(target, content, { encoding: 'utf8', flag: 'w' });
  } catch (error) {
    return err('SANDBOX_WRITE_FAILED', errorMessage(error));
  }

  // Recorded only once the write is on disk, so the ledger names files that
  // exist rather than ones an error left uncreated.
  record.writes.add(gitPath);

  return ok(target);
}

/**
 * Unified diff of every change made since `prepareSandbox`. Untracked files are
 * staged as intent-to-add first so new files appear in the diff; that only
 * touches the index, and `rollback` discards it either way.
 *
 * The plain `add -A -N` obeys the sandbox's current ignore rules, which is
 * wrong for a file this module already wrote and a later `.gitignore` change
 * has since ignored: that change was permitted, so it must be reviewable. The
 * ledger is force-added afterwards to put those paths back in the diff.
 */
export async function captureDiff(
  sandbox: SandboxHandle,
): Promise<Result<string>> {
  const authentic = authenticate(sandbox);
  if (!authentic.ok) {
    return authentic;
  }
  const { root, record } = authentic.value;

  const baseline = assertBaseline(sandbox, record);
  if (!baseline.ok) {
    return baseline;
  }

  const intentToAdd = await runGit(['add', '-A', '-N'], root);
  if (!intentToAdd.ok) {
    return intentToAdd;
  }

  const permitted = existingWrites(root, record.writes);
  if (permitted.length > 0) {
    const forced = await runGit(['add', '-N', '-f', '--', ...permitted], root);
    if (!forced.ok) {
      return forced;
    }
  }

  return runGit(['diff', baseline.value], root);
}

/**
 * Restores the sandbox to its baseline: tracked files are reset and untracked
 * files removed. `git clean` deliberately omits `-x`, so ignored artifacts such
 * as an installed node_modules survive a rollback.
 *
 * That exemption must not extend to anything this module wrote.
 * `writeFileInSandbox` refuses a target the sandbox ignores at write time, but
 * a later `.gitignore` change can ignore a file it already permitted, and the
 * `-x`-less clean would then spare it. So the ledger is cleaned a second time
 * by name, with `-x`, which reaches those paths and only those paths.
 */
export async function rollback(sandbox: SandboxHandle): Promise<Result<void>> {
  const authentic = authenticate(sandbox);
  if (!authentic.ok) {
    return authentic;
  }
  const { root, record } = authentic.value;

  const baseline = assertBaseline(sandbox, record);
  if (!baseline.ok) {
    return baseline;
  }

  const reset = await runGit(['reset', '--hard', baseline.value], root);
  if (!reset.ok) {
    return reset;
  }

  const clean = await runGit(['clean', '-fd'], root);
  if (!clean.ok) {
    return clean;
  }

  // Whatever the reset restored is tracked again and `clean` leaves it alone,
  // so this only reaches permitted writes the baseline does not contain.
  const permitted = existingWrites(root, record.writes);
  if (permitted.length > 0) {
    const cleanPermitted = await runGit(
      ['clean', '-fdx', '--', ...permitted],
      root,
    );
    if (!cleanPermitted.ok) {
      return cleanPermitted;
    }
  }

  // The tree is back at the baseline, so there is nothing left to account for.
  record.writes.clear();

  return ok(undefined);
}

/**
 * Removes the working copy. A sandbox is disposable; this is not a rollback.
 * This is the recursive delete, so the handle is authenticated first: only a
 * root this module minted is ever passed to `rm`.
 */
export async function disposeSandbox(
  sandbox: SandboxHandle,
): Promise<Result<void>> {
  const authentic = authenticate(sandbox);
  if (!authentic.ok) {
    return authentic;
  }
  const { root } = authentic.value;

  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    return err('SANDBOX_DISPOSE_FAILED', errorMessage(error));
  }
  LIVE_SANDBOXES.delete(root);

  return ok(undefined);
}
