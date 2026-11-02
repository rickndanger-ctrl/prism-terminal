import {
  err,
  ok,
  type ApprovalContract,
  type DomainError,
  type ExecutionPlan,
  type Result,
} from '@codex-lens/shared';

import { assertExecutionApproved } from './approval-binding.js';
import { applyEdit } from './codex/apply-edit.js';
import {
  createThread,
  initialize,
  resumeThread,
  type CodexClientOptions,
} from './codex/client.js';
import type { AppServerHandle } from './codex/transport.js';
import {
  generateExecutionPlan,
  type ExecutionPlanRequest,
} from './plan-generation.js';
import {
  captureDiff,
  disposeSandbox,
  prepareSandbox,
  rollback,
  type SandboxHandle,
} from './sandbox.js';
import { runTests, type TestRun } from './test-runner.js';

/**
 * Issues the approval for the execution plan this run generated.
 *
 * An execution plan is minted here, with a fresh id and digest, so no approval
 * that predates the run can name it. An issuer is what lets a caller approve
 * the plan it is actually shown: it receives the generated plan and answers
 * with a contract bound to it, or `undefined` for "not approved". Whatever it
 * returns still faces the same binding check as a caller-supplied contract, so
 * an issuer is a way to be asked, not a way to self-authorize.
 *
 * The plan an issuer is handed is a frozen deep copy, not the plan that runs.
 * The threat is an issuer that approves the plan it is shown and then edits
 * that object into another one — widening `expectedCommands` or the file lists
 * after the digest it signed was read. The binding check recomputes the digest,
 * and `createExecutionPlan` already
 * returns a frozen plan, so today the attempt throws either way; handing over a
 * copy and freezing it here is what stops that from being a property this
 * module merely inherits from a schema in another package and would lose
 * silently if that schema ever dropped `.readonly()`.
 */
export type ExecutionApprovalIssuer = (
  plan: ExecutionPlan,
) => ApprovalContract | undefined | Promise<ApprovalContract | undefined>;

export type ExecutionApproval = ApprovalContract | ExecutionApprovalIssuer;

interface SliceExecutionOptions {
  /** Registry id of the editable repo the change targets. */
  repoId: string;
  /** The approval authorizing this execution. */
  approval?: ExecutionApproval;
  client: AppServerHandle;
  /** Existing Codex thread to continue. Omitted starts a fresh thread. */
  threadId?: string;
  /** Per-request budget for the Codex handshake, thread start and edit turn. */
  codexOptions?: CodexClientOptions;
  /** Wall-clock budget for the verification run. */
  testTimeoutMs?: number;
  /** Exact user follow-up for a resumed, already-approved plan. */
  followUpInstruction?: string;
  /** Called once the real Codex thread id is known. */
  onThreadReady?: (threadId: string) => void | Promise<void>;
}

export interface VerticalSliceOptions extends SliceExecutionOptions {
  /** The requested change, as the requester wrote it. */
  request: ExecutionPlanRequest;
}

export interface PreparedVerticalSliceOptions extends SliceExecutionOptions {
  /** An already-generated execution plan loaded from trusted gateway storage. */
  plan: ExecutionPlan;
}

export interface VerticalSliceReport {
  /**
   * `Complete` only when the edit landed and the plan's own command verified
   * it. `Failed` means the tests rejected the edit and it has been rolled back.
   */
  status: 'Complete' | 'Failed';
  /** Codex thread used for the edit, suitable for a later resumed slice. */
  threadId: string;
  /** The generated plan the approval was checked against. */
  plan: ExecutionPlan;
  /** `plan.contentDigest` — the exact content the approval authorized. */
  planDigest: string;
  /** Sandbox-relative paths Codex changed, in the order they were written. */
  appliedFiles: string[];
  /** Unified diff of the edit, captured before any rollback. */
  diff: string;
  finalTests: TestRun;
  /**
   * The working copy the edit was made in. The caller owns it and must dispose
   * it; a failure that produces a Failed Result disposes it instead, so a
   * caller only ever holds a sandbox it was actually handed.
   */
  sandbox: SandboxHandle;
  /** True when the tree was returned to its baseline because tests failed. */
  rolledBack: boolean;
}

/**
 * Code of the error `runVerticalSlice` fails with when a run failed *and* the
 * working copy it made could not be removed afterwards. Distinct from the
 * failure that triggered cleanup, because it means something different to the
 * caller: not "the change was not made" but "the change was not made and there
 * is a sandbox still on disk that only you can now get rid of".
 */
export const SANDBOX_CLEANUP_FAILED = 'SANDBOX_CLEANUP_FAILED';

/**
 * What `SANDBOX_CLEANUP_FAILED` carries in `error.details`: everything needed
 * to either retry the cleanup or report the leak.
 */
export interface SandboxCleanupFailure {
  /**
   * The undisposed working copy. Still live as far as `sandbox.ts` is
   * concerned, so it remains a valid argument to `disposeSandbox` and
   * `rollback` — this is the handle a caller retries with.
   */
  sandbox: SandboxHandle;
  /** The failure that ended the run and started cleanup in the first place. */
  cause: DomainError;
  /** Why disposal could not remove the copy. */
  disposeError: DomainError;
  /**
   * Why the copy could not be returned to its baseline, when that also failed.
   * Absent means the surviving copy is at its baseline: it holds no edit from
   * this run, only the pristine source.
   */
  rollbackError?: DomainError;
  /** False when `rollbackError` is set: the copy may still hold the edit. */
  atBaseline: boolean;
}

/**
 * Reads the recovery context off a `runVerticalSlice` failure, or `undefined`
 * if the error is not a cleanup failure. Callers use this rather than reaching
 * into `details` themselves, which is typed `unknown` by design.
 */
export function readSandboxCleanupFailure(
  error: DomainError,
): SandboxCleanupFailure | undefined {
  return error.code === SANDBOX_CLEANUP_FAILED
    ? (error.details as SandboxCleanupFailure)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Freezes `value` and everything reachable from it. `Object.freeze` alone is
 * shallow, which on a plan would freeze the record while leaving
 * `expectedCommands` and the file lists writable — the arrays being exactly
 * what an approval binds.
 *
 * An already-frozen object is still descended into rather than skipped: frozen
 * says nothing about what it holds, so treating it as done is how a shallow
 * freeze upstream would pass for a deep one here. `seen` is what ends the walk.
 */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return value;
}

/**
 * The plan as an issuer sees it: a deep copy, frozen. Copying is what keeps the
 * executed plan out of the issuer's reach; freezing is what makes an attempt to
 * rewrite it fail loudly rather than pass silently. Modules are strict, so
 * writing to it throws, and `resolveApproval` turns that into an unavailable
 * approval — a plan an issuer tried to rewrite is not one this run will carry
 * out on the strength of the digest it signed first.
 */
function issuerSnapshot(plan: ExecutionPlan): ExecutionPlan {
  return deepFreeze(structuredClone(plan)) as ExecutionPlan;
}

/**
 * Reduces the two approval shapes to one contract, without judging it: every
 * answer here still goes through `assertExecutionApproved`.
 */
async function resolveApproval(
  approval: ExecutionApproval | undefined,
  plan: ExecutionPlan,
): Promise<Result<ApprovalContract>> {
  if (approval === undefined) {
    return err(
      'EXECUTION_APPROVAL_MISSING',
      'No approval was supplied for the execution plan',
    );
  }

  if (typeof approval === 'function') {
    let issued: ApprovalContract | undefined;
    try {
      issued = await approval(issuerSnapshot(plan));
    } catch (error) {
      // A throwing issuer is an approval that could not be obtained, not an
      // approval that was granted. It stops the run like any other refusal.
      // An issuer that throws by trying to rewrite the plan it was shown ends
      // up here too, which is the answer that suits it: no approval, no edit.
      return err(
        'EXECUTION_APPROVAL_UNAVAILABLE',
        `The approval issuer failed: ${errorMessage(error)}`,
      );
    }
    if (issued === undefined) {
      return err(
        'EXECUTION_APPROVAL_MISSING',
        'The approval issuer did not approve the execution plan',
      );
    }
    return resolveApproval(issued, plan);
  }

  // `assertExecutionApproved` reads through `approval.target`, so a value that
  // is not contract-shaped would throw there rather than be refused. Checked
  // here so an unapproved run always ends in a Failed Result.
  if (!isRecord(approval) || !isRecord(approval.target)) {
    return err(
      'EXECUTION_APPROVAL_MISSING',
      'Approval is not an approval contract',
    );
  }

  return ok(approval);
}

/**
 * Code for a plan this orchestrator will not carry out because it names files
 * to delete. Deleting is a change `applyEdit` has no way to make — it
 * materializes full file contents — so a deletion plan would otherwise be
 * "executed" by writing the files it names and silently skipping the removals,
 * reporting Complete for a change nobody made. Refusing is the honest answer
 * until a sandbox delete exists to make it atomically alongside the writes.
 */
export const PLAN_DELETIONS_UNSUPPORTED = 'PLAN_DELETIONS_UNSUPPORTED';

/**
 * Whether this orchestrator can carry out the plan at all, asked before a
 * sandbox exists. Both answers here are properties of the plan alone, so
 * finding them out after copying a repo would only mean a working copy to clean
 * up for a run that was never going to happen.
 */
function assertPlanExecutable(plan: ExecutionPlan): Result<string> {
  if (plan.filesToDelete.length > 0) {
    return err(
      PLAN_DELETIONS_UNSUPPORTED,
      `The execution plan names ${String(plan.filesToDelete.length)} file(s) to delete, which this orchestrator cannot carry out: ${plan.filesToDelete.join(', ')}. Re-plan the change without deletions.`,
    );
  }

  const command = plan.expectedCommands[0];
  if (command === undefined) {
    return err(
      'PLAN_NO_TEST_COMMAND',
      'Execution plan names no command to verify the change with',
    );
  }

  return ok(command);
}

/**
 * The steps that can leave changes behind. Split out so every exit from here
 * passes through one cleanup path in `runVerticalSlice`.
 */
async function editAndVerify(
  plan: ExecutionPlan,
  command: string,
  sandbox: SandboxHandle,
  options: SliceExecutionOptions,
): Promise<Result<VerticalSliceReport>> {
  const thread =
    options.threadId === undefined
      ? await createThread(options.client, {
          ...options.codexOptions,
          cwd: sandbox.root,
        })
      : await resumeThread(
          options.client,
          options.threadId,
          options.codexOptions,
        );
  if (!thread.ok) {
    return thread;
  }
  try {
    await options.onThreadReady?.(thread.value.threadId);
  } catch (error) {
    return err('THREAD_BINDING_FAILED', errorMessage(error));
  }

  const applied = await applyEdit(
    options.client,
    thread.value.threadId,
    plan,
    sandbox,
    {
      ...options.codexOptions,
      ...(options.followUpInstruction === undefined
        ? {}
        : { followUpInstruction: options.followUpInstruction }),
    },
  );
  if (!applied.ok) {
    return applied;
  }

  // Captured before the tests run, so the diff is reported whatever they say.
  const diff = await captureDiff(sandbox);
  if (!diff.ok) {
    return diff;
  }

  // The plan's own command, held to the plan's own allowlist: the command that
  // verifies an approved edit is the one the approval covers, not one chosen
  // after the fact.
  const tests = await runTests(
    {
      root: sandbox.root,
      allowedCommands: plan.expectedCommands,
      ...(options.testTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.testTimeoutMs }),
    },
    command,
  );
  if (!tests.ok) {
    return tests;
  }

  const passed = tests.value.success;
  if (!passed) {
    const restored = await rollback(sandbox);
    if (!restored.ok) {
      return restored;
    }
  }

  return ok({
    status: passed ? 'Complete' : 'Failed',
    threadId: thread.value.threadId,
    plan,
    planDigest: plan.contentDigest,
    appliedFiles: applied.value.changedFiles,
    diff: diff.value,
    finalTests: tests.value,
    sandbox,
    rolledBack: !passed,
  });
}

/**
 * Runs one approved request end to end: plan, approval check, sandbox, Codex
 * edit, verification.
 *
 * The order is the point. The plan is generated first because it is what the
 * approval must name; the approval is checked before anything is copied,
 * started or written, so an unapproved request costs nothing and changes
 * nothing. A plan this orchestrator cannot carry out — one naming deletions,
 * see `PLAN_DELETIONS_UNSUPPORTED` — is refused next, while refusing is still
 * free. Auth is proven after that, before the sandbox exists: Codex with no
 * credentials cannot make the edit, and finding that out after the copy would
 * leave a working copy behind for no reason.
 *
 * Every write happens inside a disposable sandbox — the requested repo itself
 * is never touched — and an edit the tests reject is rolled back to its
 * baseline rather than handed back half-applied.
 *
 * The approval binds the plan's file lists, so `applyEdit` holds Codex's answer
 * to them: an edit to a file the plan does not name, or names for a different
 * purpose, fails the run rather than landing. Approving a plan is what
 * authorizes the edit, and the plan a reviewer read names the files it touches.
 *
 * A Failed Result means the change was not made. It normally also means nothing
 * was left behind — with one exception it names rather than hides: if the
 * sandbox could not be removed, the failure is `SANDBOX_CLEANUP_FAILED` and
 * carries the surviving sandbox's handle. Read it with
 * `readSandboxCleanupFailure` and dispose the copy; nobody else holds it.
 *
 * A successful Result means the run completed and reported on itself: read
 * `status` to learn whether the edit survived verification, and dispose the
 * sandbox it returns.
 */
export async function runVerticalSlice(
  options: VerticalSliceOptions,
): Promise<Result<VerticalSliceReport>> {
  const planned = generateExecutionPlan(options.request, options.repoId);
  if (!planned.ok) {
    return planned;
  }
  // Frozen before anyone outside this function can see it: what the approval is
  // checked against, what Codex is told to implement, and what the tests are
  // held to is one object nobody can rewrite between those steps.
  const plan = deepFreeze(planned.value);

  const contract = await resolveApproval(options.approval, plan);
  if (!contract.ok) {
    return contract;
  }
  const approved = assertExecutionApproved(plan, contract.value);
  if (!approved.ok) {
    return approved;
  }

  // After the approval check, not before: a plan this orchestrator cannot carry
  // out and that nobody approved is refused as unapproved, which is the answer
  // that matters. Before the sandbox, so an unexecutable plan copies nothing.
  const command = assertPlanExecutable(plan);
  if (!command.ok) {
    return command;
  }

  const session = await initialize(options.client, options.codexOptions);
  if (!session.ok) {
    return session;
  }

  const prepared = await prepareSandbox(options.repoId);
  if (!prepared.ok) {
    return prepared;
  }
  const sandbox = prepared.value;

  const report = await editAndVerify(plan, command.value, sandbox, options);
  if (report.ok) {
    return report;
  }

  return cleanUpAfterFailure(sandbox, report.error);
}

/**
 * Executes one exact plan previously generated and persisted by the gateway.
 * The plan is never regenerated, so the approval digest the user reviewed is
 * the same digest that controls file scope and verification here.
 */
export async function runPreparedVerticalSlice(
  options: PreparedVerticalSliceOptions,
): Promise<Result<VerticalSliceReport>> {
  const plan = deepFreeze(structuredClone(options.plan)) as ExecutionPlan;
  const contract = await resolveApproval(options.approval, plan);
  if (!contract.ok) return contract;
  const approved = assertExecutionApproved(plan, contract.value);
  if (!approved.ok) return approved;

  const command = assertPlanExecutable(plan);
  if (!command.ok) return command;
  const session = await initialize(options.client, options.codexOptions);
  if (!session.ok) return session;
  const prepared = await prepareSandbox(options.repoId);
  if (!prepared.ok) return prepared;

  const report = await editAndVerify(
    plan,
    command.value,
    prepared.value,
    options,
  );
  return report.ok
    ? report
    : cleanUpAfterFailure(prepared.value, report.error);
}

/**
 * Removes the working copy a failed run leaves behind, and answers for it.
 *
 * The caller gets no handle on this path, so the sandbox is this function's to
 * clean up: nobody else can. Rollback runs before disposal so that if the copy
 * does survive, it survives at its baseline rather than holding a half-applied
 * edit.
 *
 * Disposal is what decides the answer. If the copy is gone, the run's original
 * failure is the whole truth — nothing was left behind, and a rollback that
 * failed on a tree that no longer exists is moot, so it is not reported. If the
 * copy is still there, saying only "the edit failed" would be a promise this
 * function did not keep: there is a live sandbox, and this is the last moment
 * anyone holds the handle to it. So the failure is replaced by one that carries
 * that handle, with the original failure inside it, and the sandbox is left
 * registered so the handle still works.
 */
async function cleanUpAfterFailure(
  sandbox: SandboxHandle,
  cause: DomainError,
): Promise<Result<never>> {
  const restored = await rollback(sandbox);
  const disposed = await disposeSandbox(sandbox);

  if (disposed.ok) {
    return { ok: false, error: cause };
  }

  const details: SandboxCleanupFailure = {
    sandbox,
    cause,
    disposeError: disposed.error,
    ...(restored.ok ? {} : { rollbackError: restored.error }),
    atBaseline: restored.ok,
  };

  return err(
    SANDBOX_CLEANUP_FAILED,
    `The run failed (${cause.code}: ${cause.message}) and its sandbox at "${sandbox.root}" could not be removed (${disposed.error.code}: ${disposed.error.message}). ` +
      (restored.ok
        ? 'The copy is at its baseline and holds no edit from this run.'
        : `It also could not be rolled back (${restored.error.code}: ${restored.error.message}), so it may still hold the edit.`) +
      ' Dispose it with the handle in this error.',
    details,
  );
}
