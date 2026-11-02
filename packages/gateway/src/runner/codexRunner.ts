import { randomUUID } from 'node:crypto';

import {
  ApprovalStatus,
  ApprovalTargetType,
  createApprovalContract,
  err,
  ok,
  type Result,
} from '@codex-lens/shared';

import { startAppServer, type AppServerHandle } from '../codex/transport.js';
import type { Db } from '../db/schema.js';
import { withAtomicResult } from '../db/transaction.js';
import type { PreparedExecutionPlan } from '../execution-plan-store.js';
import type { CodexLensEvent } from '../events/event.js';
import { appendEvent } from '../events/eventStore.js';
import { readSandboxCleanupFailure, runPreparedVerticalSlice } from '../orchestrator.js';
import type { RegistryRecord } from '../registry/projectRegistry.js';
import { disposeSandbox } from '../sandbox.js';
import type { Task } from '../tasks/task.js';
import { setTaskThread } from '../tasks/taskRunStore.js';
import { claimQueuedTask, transitionTask } from '../tasks/taskStore.js';
import { TaskRunRegistry } from './taskRunRegistry.js';

export interface CodexRunOptions {
  startClient?: () => AppServerHandle;
  clock?: () => string;
  registry?: TaskRunRegistry;
  threadId?: string;
  followUpInstruction?: string;
}

export interface CodexRunResult {
  task: Task;
  events: readonly CodexLensEvent[];
}

export async function runCodexTask(
  db: Db,
  task: Task,
  project: RegistryRecord,
  prepared: PreparedExecutionPlan,
  options: CodexRunOptions = {},
): Promise<Result<CodexRunResult>> {
  if (task.projectId !== project.id || prepared.projectId !== project.id) {
    return err('TASK_PROJECT_MISMATCH', 'Task, execution plan, and project must have the same project id');
  }
  const clock = options.clock ?? (() => new Date().toISOString());
  const registry = options.registry;
  const events: CodexLensEvent[] = [];
  const emit = (type: CodexLensEvent['type'], payload: Record<string, unknown>): Result<CodexLensEvent> => {
    const event = appendEvent(db, {
      id: randomUUID(),
      taskId: task.id,
      type,
      payload,
      createdAt: clock(),
    });
    if (event.ok) events.push(event.value);
    return event;
  };

  const claimed = withAtomicResult(db, () => {
    const running = claimQueuedTask(db, task.id, project.id);
    if (!running.ok) return running;
    const queued = emit('queued', {
      projectId: project.id,
      executionPlanId: prepared.plan.executionPlanId,
      planDigest: prepared.plan.contentDigest,
    });
    if (!queued.ok) return queued;
    return emit('running', { message: 'Codex is starting the approved execution plan.' });
  });
  if (!claimed.ok) return claimed;

  const approval = createApprovalContract({
    approvalId: `task-${task.id}`,
    approvedBy: 'codex-lens-user',
    approvalTimestamp: clock(),
    approvalType: 'ExecutionPlanApproval',
    notes: 'User approved this exact execution plan through the authenticated Codex Lens task API.',
    approvalStatus: ApprovalStatus.Approved,
    target: {
      targetType: ApprovalTargetType.ExecutionPlan,
      targetId: prepared.plan.executionPlanId,
      targetVersion: prepared.plan.version,
      targetContentDigest: prepared.plan.contentDigest,
    },
  });
  if (!approval.ok) return approval;

  let client: AppServerHandle;
  registry?.begin(task.id);
  try {
    client = (options.startClient ?? (() => startAppServer()))();
    registry?.attach(task.id, client);
  } catch (error) {
    registry?.finish(task.id);
    return finishFailure(error instanceof Error ? error.message : String(error), 'CODEX_START_FAILED');
  }

  try {
    const report = await runPreparedVerticalSlice({
      plan: prepared.plan,
      repoId: project.id,
      approval: approval.value,
      client,
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
      ...(options.followUpInstruction === undefined ? {} : { followUpInstruction: options.followUpInstruction }),
      onThreadReady: (threadId) => {
        const saved = setTaskThread(db, task.id, threadId);
        if (!saved.ok) throw new Error(saved.error.message);
      },
    });
    if (!report.ok) {
      const intent = registry?.intent(task.id);
      if (intent !== undefined) return finishStopped(intent);
      const cleanup = readSandboxCleanupFailure(report.error);
      if (cleanup !== undefined) {
        const retried = await disposeSandbox(cleanup.sandbox);
        if (retried.ok) {
          return finishFailure(cleanup.cause.message, cleanup.cause.code);
        }
      }
      return finishFailure(report.error.message, report.error.code);
    }

    const disposed = await disposeSandbox(report.value.sandbox);
    if (!disposed.ok) {
      return finishFailure(disposed.error.message, disposed.error.code);
    }

    const evidence = emit('log', {
      message: `Codex changed ${String(report.value.appliedFiles.length)} approved file(s).`,
      appliedFiles: report.value.appliedFiles,
      diff: report.value.diff,
      command: report.value.finalTests.command,
      exitCode: report.value.finalTests.exitCode,
      stdout: report.value.finalTests.stdout,
      stderr: report.value.finalTests.stderr,
      durationMs: report.value.finalTests.durationMs,
      counts: report.value.finalTests.counts,
    });
    if (!evidence.ok) return evidence;

    const terminalType = report.value.status === 'Complete' ? 'complete' : 'failed';
    const terminalState = report.value.status === 'Complete' ? 'complete' : 'failed';
    const terminal = withAtomicResult(db, () => {
      const event = emit(terminalType, {
        message: report.value.status === 'Complete'
          ? 'The approved change passed verification.'
          : 'Verification failed and the sandbox was rolled back.',
        command: report.value.finalTests.command,
        exitCode: report.value.finalTests.exitCode,
        rolledBack: report.value.rolledBack,
      });
      if (!event.ok) return event;
      return transitionTask(db, task.id, terminalState);
    });
    return terminal.ok ? ok({ task: terminal.value, events }) : terminal;
  } finally {
    await client.close().catch(() => undefined);
    registry?.finish(task.id);
  }

  function finishFailure(message: string, code: string): Result<CodexRunResult> {
    const terminal = withAtomicResult(db, () => {
      const event = emit('failed', { code, message });
      if (!event.ok) return event;
      return transitionTask(db, task.id, 'failed');
    });
    return terminal.ok ? ok({ task: terminal.value, events }) : terminal;
  }

  function finishStopped(state: 'paused' | 'cancelled'): Result<CodexRunResult> {
    const terminal = withAtomicResult(db, () => {
      const event = emit(state, {
        message: state === 'paused' ? 'Codex stopped safely and the task can be resumed.' : 'Codex stopped and the task was cancelled.',
      });
      if (!event.ok) return event;
      return transitionTask(db, task.id, state);
    });
    return terminal.ok ? ok({ task: terminal.value, events }) : terminal;
  }
}
