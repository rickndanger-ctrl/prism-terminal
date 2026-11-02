import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { immutableVisualReferences, VisualReferencesSchema, type VisualReference } from './visualReferences.js';

import { err, ok, type Result } from '@codex-lens/shared';

import {
  ASSISTANT_TASK_MODEL,
  ASSISTANT_TASK_REASONING_EFFORT,
  startCodexAssistantTask,
  type AssistantTaskWorker,
  type AssistantTaskWorkerHandle,
} from './codexTaskWorker.js';
import {
  createMemoryAssistantTaskStore,
  createSqliteAssistantTaskStore,
  immutableAssistantTaskProjectPolicy,
  isAssistantTaskOutcomeUnreconciled,
  type AssistantTaskProjectPolicy,
  type AssistantTaskRecord,
  type AssistantTaskScope,
  type AssistantTaskState,
  type AssistantTaskStore,
} from './assistantTaskStore.js';
import type { Db } from '../db/schema.js';
import { getProjectById } from '../registry/registry.js';
import type { RegistryRecord } from '../registry/projectRegistry.js';
import { actionConfirmationPolicy } from '../policy/actionConfirmationPolicy.js';

export interface PrepareAssistantTaskRequest {
  instruction: string;
  visualReferences?: readonly VisualReference[];
  scope: AssistantTaskScope;
  workingDirectory: string;
  projectId?: string;
  projectPolicy?: AssistantTaskProjectPolicy;
  /** Tightens the policy: the task needs a spoken confirmation even if ordinary. */
  requireExplicitConfirmation?: boolean;
}

export interface PreparedAssistantTask {
  taskId: string;
  confirmationId: string;
  digest: string;
  instruction: string;
  scope: AssistantTaskScope;
  projectId?: string;
  model: string;
  reasoningEffort: string;
  expiresAt: string;
  requiresExplicitConfirmation: boolean;
  confirmationReason?: string;
}

export interface StartPreparedAssistantTaskRequest {
  confirmationId: string;
  digest: string;
  authorization: 'single_utterance' | 'explicit_confirmation';
}

export interface AssistantTaskStatus {
  taskId: string;
  instruction: string;
  scope: AssistantTaskScope;
  projectId?: string;
  state: AssistantTaskState;
  model: string;
  reasoningEffort: string;
  preparedAt: string;
  expiresAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  threadId?: string;
  summary?: string;
  failureCode?: string;
  reconciledAt?: string;
}

export interface AssistantTaskService {
  /** Recover interrupted rows only after this gateway instance owns its listener. */
  activate(): void;
  prepare(request: PrepareAssistantTaskRequest): Promise<Result<PreparedAssistantTask>>;
  start(request: StartPreparedAssistantTaskRequest): Promise<Result<AssistantTaskStatus>>;
  status(taskId: string): Promise<Result<AssistantTaskStatus>>;
  cancel(taskId: string): Promise<Result<AssistantTaskStatus>>;
  reconcile(taskId: string): Promise<Result<AssistantTaskStatus>>;
  close(): Promise<void>;
}

interface CreateAssistantTaskServiceOptions {
  externalBusy?: () => boolean;
  db?: Db;
  store?: AssistantTaskStore;
  worker?: AssistantTaskWorker;
  now?: () => Date;
  id?: () => string;
  ttlMs?: number;
  shutdownTimeoutMs?: number;
  projectResolver?: (projectId: string) => Result<RegistryRecord>;
}

export const ASSISTANT_TASK_SHUTDOWN_TIMEOUT_MS = 8_000;

export function assistantTaskProjectPolicyFromRegistry(
  project: RegistryRecord,
): AssistantTaskProjectPolicy {
  return immutableAssistantTaskProjectPolicy({
    root: project.path,
    allowedCommands: project.allowedCommands,
    allowDependencyInstall: project.allowDependencyInstall,
    allowCommit: project.allowCommit,
    allowPush: project.allowPush,
    allowDeploy: project.allowDeploy,
  });
}

function sameProjectPolicy(
  left: AssistantTaskProjectPolicy,
  right: AssistantTaskProjectPolicy,
): boolean {
  return left.root === right.root
    && left.allowDependencyInstall === right.allowDependencyInstall
    && left.allowCommit === right.allowCommit
    && left.allowPush === right.allowPush
    && left.allowDeploy === right.allowDeploy
    && left.allowedCommands.length === right.allowedCommands.length
    && left.allowedCommands.every((command, index) => command === right.allowedCommands[index]);
}

type GuardedProjectAction = 'dependency installation' | 'commit' | 'push' | 'deployment';

const GUARDED_ACTIONS: ReadonlyArray<{
  action: GuardedProjectAction;
  patterns: readonly RegExp[];
}> = [
  {
    action: 'dependency installation',
    patterns: [
      /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|update|upgrade)\b/giu,
      /\b(?:brew|pip3?|gem|pod)\s+install\b/giu,
      /\b(?:install|reinstall)\b(?!\s+(?:bug|failure|issue|docs?|documentation|script|flow|test)\b)/giu,
      /\b(?:add|update|upgrade)\s+(?:the\s+)?(?:dependencies|dependency|packages?|libraries|library|modules?|sdk|framework)\b/giu,
    ],
  },
  {
    action: 'commit',
    patterns: [
      /\bgit\s+commit\b/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|please)\s+)commit\b/giu,
      /\b(?:can|could|would|will)\s+you\s+commit\b/giu,
      /\bcommit\s+(?:the\s+|these\s+|my\s+|your\s+)?(?:changes?|work|code|files?|repository|repo)\b/giu,
      /\b(?:create|make)\s+(?:a\s+)?commit\b/giu,
    ],
  },
  {
    action: 'push',
    patterns: [
      /\bgit\s+push\b/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|please)\s+)push\b/giu,
      /\b(?:can|could|would|will)\s+you\s+push\b/giu,
      /\bpush\s+(?:the\s+|these\s+|my\s+|your\s+)?(?:changes?|commits?|branch|code|repository|repo)\b/giu,
      /\bpush\s+(?:it\s+)?to\s+(?:origin|github|gitlab|bitbucket|the\s+remote)\b/giu,
    ],
  },
  {
    action: 'deployment',
    patterns: [
      /\bdeploy\b/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|please)\s+)(?:publish|release|ship)\b/giu,
      /\b(?:can|could|would|will)\s+you\s+(?:publish|release|ship)\b/giu,
      /\b(?:publish|release|ship)\s+(?:the\s+|this\s+)?(?:app|application|build|site|website|service|project|release)\b/giu,
      /\b(?:publish|release|ship)\s+(?:it\s+)?to\s+(?:production|testflight|the\s+app\s+store|a\s+server)\b/giu,
    ],
  },
];

function isNegatedAction(text: string, actionIndex: number): boolean {
  const prefix = text.slice(Math.max(0, actionIndex - 48), actionIndex);
  return /\b(?:do\s+not|don't|dont|never|without|avoid|must\s+not|should\s+not)\s+(?:\w+\s+){0,2}$/iu.test(prefix);
}

function disallowedRequestedAction(
  instruction: string,
): GuardedProjectAction | undefined {
  for (const guarded of GUARDED_ACTIONS) {
    for (const pattern of guarded.patterns) {
      pattern.lastIndex = 0;
      let match = pattern.exec(instruction);
      while (match !== null) {
        if (!isNegatedAction(instruction, match.index)) return guarded.action;
        match = pattern.exec(instruction);
      }
    }
  }
  return undefined;
}

function digestFor(record: Pick<AssistantTaskRecord,
  | 'taskId'
  | 'confirmationId'
  | 'instruction'
  | 'visualReferences'
  | 'scope'
  | 'projectId'
  | 'workingDirectory'
  | 'projectPolicy'
  | 'model'
  | 'reasoningEffort'
  | 'requiresExplicitConfirmation'
  | 'expiresAt'
>): string {
  return createHash('sha256')
    .update(record.taskId)
    .update('\0')
    .update(record.confirmationId)
    .update('\0')
    .update(record.instruction)
    .update('\0')
    .update(record.scope)
    .update('\0')
    .update(record.projectId ?? '')
    .update('\0')
    .update(record.workingDirectory)
    .update('\0')
    .update(record.projectPolicy === undefined ? '' : JSON.stringify(record.projectPolicy))
    .update('\0')
    .update(record.model)
    .update('\0')
    .update(record.reasoningEffort)
    .update('\0')
    .update(record.requiresExplicitConfirmation ? 'confirm' : 'single-utterance')
    .update('\0')
    .update(record.expiresAt)
    .update(record.visualReferences === undefined ? '' : '\0visual:' + JSON.stringify(record.visualReferences))
    .digest('hex');
}

function digestMatches(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

function publicStatus(record: AssistantTaskRecord): AssistantTaskStatus {
  return {
    taskId: record.taskId,
    instruction: record.instruction,
    scope: record.scope,
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    state: record.state,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    preparedAt: record.preparedAt,
    expiresAt: record.expiresAt,
    updatedAt: record.updatedAt,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
    ...(record.summary === undefined ? {} : { summary: record.summary }),
    ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode }),
    ...(record.reconciledAt === undefined ? {} : { reconciledAt: record.reconciledAt }),
  };
}

type PromiseSettlement = 'resolved' | 'rejected' | 'timed-out';

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<PromiseSettlement> {
  if (timeoutMs <= 0) return 'timed-out';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), timeoutMs);
    timer.unref();
  });
  const observed = promise.then(
    () => 'resolved' as const,
    () => 'rejected' as const,
  );
  const result = await Promise.race([observed, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

export function createAssistantTaskService(
  options: CreateAssistantTaskServiceOptions = {},
): AssistantTaskService {
  const store = options.store
    ?? (options.db === undefined
      ? createMemoryAssistantTaskStore()
      : createSqliteAssistantTaskStore(options.db));
  const worker = options.worker ?? startCodexAssistantTask;
  const now = options.now ?? (() => new Date());
  const makeId = options.id ?? randomUUID;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs
    ?? ASSISTANT_TASK_SHUTDOWN_TIMEOUT_MS;
  const projectDb = options.db;
  const resolveProject = options.projectResolver
    ?? (projectDb === undefined
      ? undefined
      : (projectId: string) => getProjectById(projectDb, projectId));
  const active = new Map<string, AssistantTaskWorkerHandle>();
  const starting = new Map<string, {
    abort: AbortController;
    settled: Promise<void>;
  }>();
  let closing = false;
  let activated = false;
  let closePromise: Promise<void> | undefined;

  const activate = (): void => {
    if (activated || closing) return;
    store.failInterrupted(now().toISOString());
    activated = true;
  };

  const requireActivation = (): Result<never> | undefined => activated
    ? undefined
    : err(
        'ASSISTANT_TASK_SERVICE_NOT_ACTIVE',
        'The assistant task service is not active on the gateway listener.',
      );

  const revokePreparedPolicy = (
    record: AssistantTaskRecord,
    failureCode: string,
    message: string,
  ): Result<never> => {
    const finishedAt = now().toISOString();
    store.transition(record.taskId, ['prepared'], {
      state: 'cancelled',
      updatedAt: finishedAt,
      finishedAt,
      summary: message,
      failureCode,
    });
    return err(failureCode, message);
  };

  const finish = (taskId: string, handle: AssistantTaskWorkerHandle): void => {
    void handle.completion.then((result) => {
      active.delete(taskId);
      const finishedAt = now().toISOString();
      store.transition(taskId, ['running'], {
        state: result.state,
        updatedAt: finishedAt,
        finishedAt,
        summary: result.summary,
        ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }),
      });
    }).catch(() => {
      active.delete(taskId);
      const finishedAt = now().toISOString();
      store.transition(taskId, ['running'], {
        state: 'failed',
        updatedAt: finishedAt,
        finishedAt,
        summary: 'The Codex task worker stopped unexpectedly.',
        failureCode: 'ASSISTANT_TASK_WORKER_CRASHED',
      });
    });
  };

  const stopForShutdown = async (
    taskId: string,
    handle: AssistantTaskWorkerHandle,
  ): Promise<void> => {
    const deadline = Date.now() + shutdownTimeoutMs;
    const cancelBudget = Math.max(1, Math.floor(shutdownTimeoutMs / 2));
    const cancelResult = await settleWithin(
      Promise.resolve().then(() => handle.cancel()),
      cancelBudget,
    );

    const closeRemaining = deadline - Date.now();
    const closeResult = handle.close === undefined
      ? 'resolved'
      : await settleWithin(
          Promise.resolve().then(() => handle.close?.()),
          closeRemaining,
        );

    const completionRemaining = deadline - Date.now();
    let completionResult: PromiseSettlement = 'timed-out';
    if (completionRemaining > 0) {
      completionResult = await settleWithin(handle.completion, completionRemaining);
      // Let the completion observer persist a result before the final state
      // check below.
      await Promise.resolve();
    }

    const current = store.getByTaskId(taskId);
    if (current?.state === 'running') {
      const finishedAt = now().toISOString();
      if (
        cancelResult === 'resolved'
        && closeResult === 'resolved'
        && completionResult === 'resolved'
      ) {
        store.transition(taskId, ['running'], {
          state: 'cancelled',
          updatedAt: finishedAt,
          finishedAt,
          summary: 'The task was cancelled while the gateway shut down.',
        });
      } else {
        const cleanupUnconfirmed = closeResult !== 'resolved';
        store.transition(taskId, ['running'], {
          state: 'failed',
          updatedAt: finishedAt,
          finishedAt,
          summary: cleanupUnconfirmed
            ? 'The gateway could not prove the Codex worker process stopped. Inspect the task target before reconciling this unknown outcome.'
            : 'The gateway shut down before Codex proved the task stopped. Inspect the task target before reconciling this unknown outcome.',
          failureCode: cleanupUnconfirmed
            ? 'ASSISTANT_TASK_PROCESS_CLEANUP_UNCONFIRMED'
            : 'GATEWAY_RESTART_OUTCOME_UNCERTAIN',
        });
      }
    }
    active.delete(taskId);
  };

  return {
    activate,

    async prepare(request) {
      if (closing) {
        return err(
          'ASSISTANT_TASK_SERVICE_CLOSING',
          'The gateway is shutting down and cannot prepare another task.',
        );
      }
      const inactive = requireActivation();
      if (inactive !== undefined) return inactive;
      const instruction = request.instruction.trim();
      if (instruction === '') {
        return err('INVALID_ASSISTANT_TASK', 'A concrete task instruction is required.');
      }
      if (instruction.length > 8_000) {
        return err('INVALID_ASSISTANT_TASK', 'The task instruction must be 8,000 characters or fewer.');
      }
      if (request.workingDirectory.trim() === '') {
        return err('INVALID_ASSISTANT_TASK', 'A working directory is required.');
      }
      if (request.scope === 'project' && request.projectId?.trim() === '') {
        return err('INVALID_ASSISTANT_TASK', 'A project task requires an approved project id.');
      }
      if (request.scope === 'project' && request.projectId === undefined) {
        return err('INVALID_ASSISTANT_TASK', 'A project task requires an approved project id.');
      }
      if (request.scope === 'mac' && (request.projectId !== undefined || request.projectPolicy !== undefined)) {
        return err('INVALID_ASSISTANT_TASK', 'A Mac-wide task must not include project policy.');
      }

      let projectPolicy: AssistantTaskProjectPolicy | undefined;
      if (request.scope === 'project') {
        if (request.projectPolicy === undefined) {
          return err('INVALID_ASSISTANT_TASK', 'A project task requires its approved project policy.');
        }
        if (resolveProject === undefined) {
          return err(
            'ASSISTANT_TASK_PROJECT_POLICY_UNAVAILABLE',
            'The selected project policy could not be verified. Nothing was prepared.',
          );
        }
        const currentProject = resolveProject(request.projectId as string);
        if (!currentProject.ok) {
          return err(
            'ASSISTANT_TASK_PROJECT_POLICY_UNAVAILABLE',
            'The selected project policy could not be verified. Nothing was prepared.',
          );
        }
        if (!currentProject.value.allowWorkspaceWrite) {
          return err(
            'ASSISTANT_TASK_PROJECT_POLICY_REVOKED',
            'The selected project is not approved for workspace changes.',
          );
        }
        const currentPolicy = assistantTaskProjectPolicyFromRegistry(currentProject.value);
        if (
          request.workingDirectory !== currentPolicy.root
          || !sameProjectPolicy(request.projectPolicy, currentPolicy)
        ) {
          return err(
            'ASSISTANT_TASK_PROJECT_POLICY_CHANGED',
            'The selected project policy changed before preparation. Nothing was prepared.',
          );
        }
        const disallowedAction = disallowedRequestedAction(instruction);
        if (disallowedAction !== undefined) {
          return err(
            'ASSISTANT_TASK_PROJECT_ACTION_REQUIRES_MAC_SCOPE',
            `Project tasks cannot authorize ${disallowedAction}. Prepare and separately confirm an exact Mac-scope task.`,
          );
        }
        projectPolicy = currentPolicy;
      }
      const parsedReferences = request.visualReferences === undefined ? undefined : VisualReferencesSchema.safeParse(request.visualReferences);
      if (parsedReferences !== undefined && !parsedReferences.success) {
        return err('ASSISTANT_TASK_INVALID_VISUAL_REFERENCES', 'The attached visual references are invalid.');
      }
      const visualReferences = parsedReferences?.success ? immutableVisualReferences(parsedReferences.data) : undefined;
      const taskId = makeId();
      const confirmationId = makeId();
      const preparedAt = now();
      const expiresAt = new Date(preparedAt.getTime() + ttlMs);
      const confirmationPolicy = actionConfirmationPolicy(instruction, {
        scope: request.scope,
      });
      const forcedConfirmation =
        request.requireExplicitConfirmation === true && !confirmationPolicy.requiresExplicitConfirmation;
      const confirmationReason = forcedConfirmation
        ? 'Tasks written by the GPT Live voice always need a spoken confirmation.'
        : confirmationPolicy.confirmationReason;
      const base = {
        taskId,
        confirmationId,
        instruction,
        scope: request.scope,
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
        workingDirectory: request.workingDirectory,
        ...(visualReferences === undefined ? {} : { visualReferences }),
        ...(projectPolicy === undefined ? {} : { projectPolicy }),
        model: ASSISTANT_TASK_MODEL,
        reasoningEffort: ASSISTANT_TASK_REASONING_EFFORT,
        requiresExplicitConfirmation: forcedConfirmation || confirmationPolicy.requiresExplicitConfirmation,
        expiresAt: expiresAt.toISOString(),
      };
      const digest = digestFor(base);
      const record: AssistantTaskRecord = {
        ...base,
        digest,
        state: 'prepared',
        preparedAt: preparedAt.toISOString(),
        updatedAt: preparedAt.toISOString(),
      };
      store.insert(record);
      return ok({
        taskId,
        confirmationId,
        digest,
        instruction,
        scope: request.scope,
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
        model: record.model,
        reasoningEffort: record.reasoningEffort,
        expiresAt: record.expiresAt,
        requiresExplicitConfirmation: record.requiresExplicitConfirmation,
        ...(confirmationReason === undefined ? {} : { confirmationReason }),
      });
    },

    async start(request) {
      if (closing) {
        return err(
          'ASSISTANT_TASK_SERVICE_CLOSING',
          'The gateway is shutting down and cannot start another task.',
        );
      }
      const inactive = requireActivation();
      if (inactive !== undefined) return inactive;
      const record = store.getByConfirmationId(request.confirmationId);
      if (record === undefined) {
        return err('ASSISTANT_TASK_CONFIRMATION_NOT_FOUND', 'That prepared task no longer exists.');
      }
      if (record.state !== 'prepared') {
        return err('ASSISTANT_TASK_ALREADY_CONSUMED', 'That prepared task was already consumed.');
      }
      const currentTime = now();
      if (currentTime >= new Date(record.expiresAt)) {
        const updatedAt = currentTime.toISOString();
        store.transition(record.taskId, ['prepared'], { state: 'expired', updatedAt, finishedAt: updatedAt });
        return err('ASSISTANT_TASK_CONFIRMATION_EXPIRED', 'That task confirmation expired. Prepare it again.');
      }
      if (!digestMatches(request.digest, record.digest)) {
        return err('ASSISTANT_TASK_CONFIRMATION_MISMATCH', 'The task confirmation did not match. Nothing ran.');
      }
      if (record.requiresExplicitConfirmation && request.authorization !== 'explicit_confirmation') {
        return err(
          'ASSISTANT_TASK_EXPLICIT_CONFIRMATION_REQUIRED',
          'That task contains a consequential step and requires a separate explicit confirmation.',
        );
      }
      if (!record.requiresExplicitConfirmation && request.authorization !== 'single_utterance') {
        return err(
          'ASSISTANT_TASK_SINGLE_UTTERANCE_AUTHORIZATION_REQUIRED',
          'That ordinary task must use the gateway single-utterance path.',
        );
      }
      if (record.scope === 'project') {
        if (record.projectId === undefined || record.projectPolicy === undefined) {
          return revokePreparedPolicy(
            record,
            'ASSISTANT_TASK_PROJECT_POLICY_REVOKED',
            'This prepared task has no current approved project policy. Prepare it again.',
          );
        }
        if (resolveProject === undefined) {
          return err(
            'ASSISTANT_TASK_PROJECT_POLICY_UNAVAILABLE',
            'The selected project policy could not be revalidated. Nothing ran.',
          );
        }
        const currentProject = resolveProject(record.projectId);
        if (!currentProject.ok) {
          if (currentProject.error.code === 'PROJECT_NOT_FOUND') {
            return revokePreparedPolicy(
              record,
              'ASSISTANT_TASK_PROJECT_POLICY_REVOKED',
              'The selected project is no longer approved. Prepare the task again after approving it.',
            );
          }
          return err(
            'ASSISTANT_TASK_PROJECT_POLICY_UNAVAILABLE',
            'The selected project policy could not be revalidated. Nothing ran.',
          );
        }
        const currentPolicy = assistantTaskProjectPolicyFromRegistry(currentProject.value);
        if (
          !currentProject.value.allowWorkspaceWrite
          || record.workingDirectory !== currentPolicy.root
          || !sameProjectPolicy(record.projectPolicy, currentPolicy)
        ) {
          return revokePreparedPolicy(
            record,
            'ASSISTANT_TASK_PROJECT_POLICY_CHANGED',
            'The selected project policy changed after confirmation. Nothing ran; prepare the task again.',
          );
        }
        const disallowedAction = disallowedRequestedAction(record.instruction);
        if (disallowedAction !== undefined) {
          return revokePreparedPolicy(
            record,
            'ASSISTANT_TASK_PROJECT_ACTION_REQUIRES_MAC_SCOPE',
            `Project tasks cannot authorize ${disallowedAction}. Prepare and separately confirm an exact Mac-scope task.`,
          );
        }
      }
      const unreconciled = store.getUnreconciledTask();
      if (unreconciled !== undefined) {
        return err(
          'ASSISTANT_TASK_RECONCILIATION_REQUIRED',
          `Task ${unreconciled.taskId} ended without a verified outcome. Inspect its target, then explicitly reconcile it before starting another task.`,
        );
      }
      if (store.hasRunningTask() || options.externalBusy?.()) {
        return err('ASSISTANT_TASK_BUSY', 'Another full Codex task is already running.');
      }

      const startedAt = now().toISOString();
      const claimed = store.transition(record.taskId, ['prepared'], {
        state: 'running',
        updatedAt: startedAt,
        startedAt,
        summary: 'Codex accepted the task and is starting work.',
      });
      if (!claimed) {
        return err('ASSISTANT_TASK_ALREADY_CONSUMED', 'That prepared task was already consumed.');
      }

      let resolveStartup!: () => void;
      const startupSettled = new Promise<void>((resolve) => { resolveStartup = resolve; });
      const abort = new AbortController();
      starting.set(record.taskId, { abort, settled: startupSettled });
      let started: Awaited<ReturnType<AssistantTaskWorker>>;
      try {
        const workerInput = Object.freeze({
          taskId: record.taskId,
          instruction: record.instruction,
          ...(record.visualReferences === undefined ? {} : { visualReferences: immutableVisualReferences(record.visualReferences) }),
          workingDirectory: record.workingDirectory,
          scope: record.scope,
          authorization: request.authorization,
          model: record.model,
          reasoningEffort: record.reasoningEffort,
          signal: abort.signal,
          onProgress: (summary: string) => {
            store.transition(record.taskId, ['running'], {
              state: 'running',
              updatedAt: now().toISOString(),
              summary: summary.slice(0, 1_200),
            });
          },
          ...(record.projectPolicy === undefined
            ? {}
            : { projectPolicy: immutableAssistantTaskProjectPolicy(record.projectPolicy) }),
        });
        started = await worker(workerInput);
      } catch {
        const finishedAt = now().toISOString();
        store.transition(record.taskId, ['running'], {
          state: 'failed',
          updatedAt: finishedAt,
          finishedAt,
          summary: 'The Codex task worker failed during startup without proving its process stopped. Inspect the task target before reconciling this unknown outcome.',
          failureCode: 'ASSISTANT_TASK_PROCESS_CLEANUP_UNCONFIRMED',
        });
        starting.delete(record.taskId);
        resolveStartup();
        return err(
          'ASSISTANT_TASK_PROCESS_CLEANUP_UNCONFIRMED',
          'The Codex task worker failed during startup without proving its process stopped.',
        );
      }
      if (!started.ok) {
        const finishedAt = now().toISOString();
        const startOutcomeUnconfirmed =
          started.error.code === 'ASSISTANT_TASK_START_OUTCOME_UNCONFIRMED'
          || started.error.code === 'ASSISTANT_TASK_PROCESS_CLEANUP_UNCONFIRMED';
        const stoppedDuringStartup = abort.signal.aborted
          && !startOutcomeUnconfirmed;
        store.transition(record.taskId, ['running'], {
          state: stoppedDuringStartup ? 'cancelled' : 'failed',
          updatedAt: finishedAt,
          finishedAt,
          summary: stoppedDuringStartup
            ? 'The task was cancelled while Codex was starting.'
            : startOutcomeUnconfirmed
              ? 'Codex did not confirm whether the dispatched task started. Inspect the task target before reconciling this unknown outcome.'
              : 'Codex could not start this task.',
          ...(!stoppedDuringStartup ? { failureCode: started.error.code } : {}),
        });
        starting.delete(record.taskId);
        resolveStartup();
        return started;
      }

      if (closing || abort.signal.aborted) {
        await stopForShutdown(record.taskId, started.value);
        starting.delete(record.taskId);
        resolveStartup();
        return err(
          'ASSISTANT_TASK_SERVICE_CLOSING',
          closing
            ? 'The gateway shut down while Codex was starting. Inspect task status before retrying.'
            : 'The task was cancelled while Codex was starting. Inspect task status before retrying.',
        );
      }

      starting.delete(record.taskId);
      resolveStartup();
      active.set(record.taskId, started.value);
      store.transition(record.taskId, ['running'], {
        state: 'running',
        updatedAt: now().toISOString(),
        threadId: started.value.threadId,
        turnId: started.value.turnId,
      });
      finish(record.taskId, started.value);
      const current = store.getByTaskId(record.taskId);
      return current === undefined
        ? err('ASSISTANT_TASK_NOT_FOUND', 'The started task could not be read back.')
        : ok(publicStatus(current));
    },

    async status(taskId) {
      const inactive = requireActivation();
      if (inactive !== undefined) return inactive;
      let record = store.getByTaskId(taskId);
      if (
        record?.state === 'prepared'
        && now() >= new Date(record.expiresAt)
      ) {
        const finishedAt = now().toISOString();
        store.transition(taskId, ['prepared'], {
          state: 'expired',
          updatedAt: finishedAt,
          finishedAt,
          summary: 'The prepared task confirmation expired before it was used.',
        });
        record = store.getByTaskId(taskId);
      }
      return record === undefined
        ? err('ASSISTANT_TASK_NOT_FOUND', 'That Codex task was not found.')
        : ok(publicStatus(record));
    },

    async cancel(taskId) {
      const inactive = requireActivation();
      if (inactive !== undefined) return inactive;
      const record = store.getByTaskId(taskId);
      if (record === undefined) return err('ASSISTANT_TASK_NOT_FOUND', 'That Codex task was not found.');
      if (record.state === 'prepared') {
        const finishedAt = now().toISOString();
        store.transition(taskId, ['prepared'], {
          state: 'cancelled',
          updatedAt: finishedAt,
          finishedAt,
          summary: 'The prepared task was cancelled before it started.',
        });
        const cancelled = store.getByTaskId(taskId);
        return cancelled === undefined
          ? err('ASSISTANT_TASK_NOT_FOUND', 'The cancelled task could not be read back.')
          : ok(publicStatus(cancelled));
      }
      if (record.state !== 'running') return ok(publicStatus(record));
      const handle = active.get(taskId);
      if (handle === undefined) {
        const startup = starting.get(taskId);
        if (startup !== undefined) {
          startup.abort.abort('cancel');
          const stopped = await settleWithin(startup.settled, shutdownTimeoutMs);
          if (stopped !== 'resolved') {
            const finishedAt = now().toISOString();
            store.transition(taskId, ['running'], {
              state: 'failed',
              updatedAt: finishedAt,
              finishedAt,
              summary: 'Codex did not confirm cancellation while starting, so the final task state is uncertain.',
              failureCode: 'ASSISTANT_TASK_CANCEL_UNCONFIRMED',
            });
            return err(
              'ASSISTANT_TASK_CANCEL_FAILED',
              'Codex did not prove that cancellation completed. The task outcome is uncertain.',
            );
          }
          const stoppedRecord = store.getByTaskId(taskId);
          return stoppedRecord === undefined
            ? err('ASSISTANT_TASK_NOT_FOUND', 'The cancelled task could not be read back.')
            : ok(publicStatus(stoppedRecord));
        }
        return err('ASSISTANT_TASK_NOT_ACTIVE', 'That task is marked running but has no live worker.');
      }
      const cancelResult = await settleWithin(
        Promise.resolve().then(() => handle.cancel()),
        shutdownTimeoutMs,
      );
      if (cancelResult !== 'resolved') {
        const finishedAt = now().toISOString();
        store.transition(taskId, ['running'], {
          state: 'failed',
          updatedAt: finishedAt,
          finishedAt,
          summary: 'Codex did not confirm cancellation, so the final task state is uncertain.',
          failureCode: 'ASSISTANT_TASK_CANCEL_UNCONFIRMED',
        });
        return err(
          'ASSISTANT_TASK_CANCEL_FAILED',
          'Codex did not prove that cancellation completed. The task outcome is uncertain.',
        );
      }
      const finishedAt = now().toISOString();
      store.transition(taskId, ['running'], {
        state: 'cancelled',
        updatedAt: finishedAt,
        finishedAt,
        summary: 'The task was cancelled.',
      });
      active.delete(taskId);
      const cancelled = store.getByTaskId(taskId);
      return cancelled === undefined
        ? err('ASSISTANT_TASK_NOT_FOUND', 'The cancelled task could not be read back.')
        : ok(publicStatus(cancelled));
    },

    async reconcile(taskId) {
      const inactive = requireActivation();
      if (inactive !== undefined) return inactive;
      const record = store.getByTaskId(taskId);
      if (record === undefined) {
        return err('ASSISTANT_TASK_NOT_FOUND', 'That Codex task was not found.');
      }
      if (!isAssistantTaskOutcomeUnreconciled(record)) {
        return err(
          'ASSISTANT_TASK_NOT_UNCERTAIN',
          'That task does not have an unresolved unknown outcome.',
        );
      }
      const updated = store.reconcileUnknownOutcome(taskId, now().toISOString());
      if (!updated) {
        return err(
          'ASSISTANT_TASK_RECONCILIATION_CONFLICT',
          'The task changed before its unknown outcome could be reconciled.',
        );
      }
      const reconciled = store.getByTaskId(taskId);
      return reconciled === undefined
        ? err('ASSISTANT_TASK_NOT_FOUND', 'The reconciled task could not be read back.')
        : ok(publicStatus(reconciled));
    },

    async close() {
      if (closePromise === undefined) {
        closing = true;
        const startupEntries = [...starting.entries()];
        for (const [, entry] of startupEntries) entry.abort.abort();
        closePromise = Promise.all([
          ...[...active.entries()].map(async ([taskId, handle]) => {
            await stopForShutdown(taskId, handle);
          }),
          ...startupEntries.map(async ([taskId, entry]) => {
            const settled = await settleWithin(entry.settled, shutdownTimeoutMs);
            if (settled === 'resolved') return;
            const finishedAt = now().toISOString();
            store.transition(taskId, ['running'], {
              state: 'failed',
              updatedAt: finishedAt,
              finishedAt,
              summary: 'The gateway shut down before Codex proved its starting worker stopped. Inspect the task target before reconciling this unknown outcome.',
              failureCode: 'GATEWAY_RESTART_OUTCOME_UNCERTAIN',
            });
          }),
        ]).then(() => undefined);
      }
      await closePromise;
    },
  };
}
