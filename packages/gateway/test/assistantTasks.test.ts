import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { err, ok } from '@codex-lens/shared';

import {
  createMemoryAssistantTaskStore,
  createSqliteAssistantTaskStore,
  type AssistantTaskProjectPolicy,
  type AssistantTaskRecord,
  type AssistantTaskStore,
} from '../src/assistant/assistantTaskStore.js';
import {
  ASSISTANT_TASK_MODEL,
  ASSISTANT_TASK_REASONING_EFFORT,
  type AssistantTaskWorker,
  type AssistantTaskWorkerResult,
} from '../src/assistant/codexTaskWorker.js';
import {
  assistantTaskProjectPolicyFromRegistry,
  createAssistantTaskService,
} from '../src/assistant/assistantTasks.js';
import { openDb } from '../src/db/schema.js';
import type { RegistryRecord } from '../src/registry/projectRegistry.js';

const BASE_TIME = '2026-09-02T17:00:00.000Z';
const PROJECT_POLICY: AssistantTaskProjectPolicy = Object.freeze({
  root: '/tmp/codex-lens',
  allowedCommands: Object.freeze(['npm test']),
  allowDependencyInstall: false,
  allowCommit: false,
  allowPush: false,
  allowDeploy: false,
});

function createActiveAssistantTaskService(
  options: Parameters<typeof createAssistantTaskService>[0] = {},
) {
  const service = createAssistantTaskService(options);
  service.activate();
  return service;
}

function authorizationFor(prepared: { requiresExplicitConfirmation: boolean }) {
  return prepared.requiresExplicitConfirmation
    ? 'explicit_confirmation' as const
    : 'single_utterance' as const;
}

function registryProject(overrides: Partial<RegistryRecord> = {}): RegistryRecord {
  return Object.freeze({
    id: 'codex-lens',
    displayName: 'Codex Lens',
    path: PROJECT_POLICY.root,
    allowedCommands: PROJECT_POLICY.allowedCommands,
    allowWorkspaceWrite: true,
    allowDependencyInstall: PROJECT_POLICY.allowDependencyInstall,
    allowCommit: PROJECT_POLICY.allowCommit,
    allowPush: PROJECT_POLICY.allowPush,
    allowDeploy: PROJECT_POLICY.allowDeploy,
    ...overrides,
  });
}

function taskRecord(overrides: Partial<AssistantTaskRecord> = {}): AssistantTaskRecord {
  return {
    taskId: 'task-1',
    confirmationId: 'confirmation-1',
    digest: 'a'.repeat(64),
    instruction: 'Open Xcode and run the existing test target.',
    scope: 'project',
    projectId: 'codex-lens',
    workingDirectory: '/tmp/codex-lens',
    projectPolicy: PROJECT_POLICY,
    state: 'prepared',
    model: ASSISTANT_TASK_MODEL,
    reasoningEffort: ASSISTANT_TASK_REASONING_EFFORT,
    requiresExplicitConfirmation: true,
    preparedAt: BASE_TIME,
    expiresAt: '2026-09-02T17:05:00.000Z',
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

interface StoreHarness {
  store: AssistantTaskStore;
  close(): void;
}

const storeFactories: ReadonlyArray<[string, () => StoreHarness]> = [
  ['memory', () => ({ store: createMemoryAssistantTaskStore(), close() {} })],
  ['SQLite', () => {
    const db = openDb(':memory:');
    return { store: createSqliteAssistantTaskStore(db), close: () => db.close() };
  }],
];

describe.each(storeFactories)('%s assistant task store', (_name, makeHarness) => {
  it('persists records and applies only expected-state transitions', () => {
    const harness = makeHarness();
    try {
      harness.store.insert(taskRecord());
      expect(harness.store.hasRunningTask()).toBe(false);
      expect(harness.store.transition('task-1', ['running'], {
        state: 'completed',
        updatedAt: '2026-09-02T17:01:00.000Z',
      })).toBe(false);
      expect(harness.store.transition('task-1', ['prepared'], {
        state: 'running',
        updatedAt: '2026-09-02T17:01:00.000Z',
        startedAt: '2026-09-02T17:01:00.000Z',
        threadId: 'thread-1',
        turnId: 'turn-1',
      })).toBe(true);
      expect(harness.store.hasRunningTask()).toBe(true);
      expect(harness.store.getByConfirmationId('confirmation-1')).toMatchObject({
        taskId: 'task-1',
        state: 'running',
        threadId: 'thread-1',
        turnId: 'turn-1',
        projectPolicy: PROJECT_POLICY,
      });
      const stored = harness.store.getByTaskId('task-1');
      expect(Object.isFrozen(stored?.projectPolicy)).toBe(true);
      expect(Object.isFrozen(stored?.projectPolicy?.allowedCommands)).toBe(true);
    } finally {
      harness.close();
    }
  });

  it('rejects duplicate task and confirmation identities', () => {
    const harness = makeHarness();
    try {
      harness.store.insert(taskRecord());
      expect(() => harness.store.insert(taskRecord({ confirmationId: 'confirmation-2' }))).toThrow();
      expect(() => harness.store.insert(taskRecord({ taskId: 'task-2' }))).toThrow();
    } finally {
      harness.close();
    }
  });

  it('marks only interrupted running work as outcome-uncertain after a gateway restart', () => {
    const harness = makeHarness();
    try {
      harness.store.insert(taskRecord({ state: 'running', startedAt: BASE_TIME }));
      harness.store.insert(taskRecord({
        taskId: 'task-2',
        confirmationId: 'confirmation-2',
        state: 'prepared',
      }));

      expect(harness.store.failInterrupted('2026-09-02T17:02:00.000Z')).toBe(1);
      expect(harness.store.getByTaskId('task-1')).toMatchObject({
        state: 'failed',
        failureCode: 'GATEWAY_RESTART_OUTCOME_UNCERTAIN',
        summary: expect.stringContaining('outcome is unknown'),
        finishedAt: '2026-09-02T17:02:00.000Z',
      });
      expect(harness.store.getUnreconciledTask()).toMatchObject({
        taskId: 'task-1',
        failureCode: 'GATEWAY_RESTART_OUTCOME_UNCERTAIN',
      });
      const original = harness.store.getByTaskId('task-1');
      expect(harness.store.reconcileUnknownOutcome(
        'task-1',
        '2026-09-02T17:03:00.000Z',
      )).toBe(true);
      expect(harness.store.getByTaskId('task-1')).toMatchObject({
        failureCode: original?.failureCode,
        summary: original?.summary,
        reconciledAt: '2026-09-02T17:03:00.000Z',
      });
      expect(harness.store.getUnreconciledTask()).toBeUndefined();
      expect(harness.store.reconcileUnknownOutcome(
        'task-1',
        '2026-09-02T17:04:00.000Z',
      )).toBe(false);
      expect(harness.store.getByTaskId('task-2')?.state).toBe('prepared');
    } finally {
      harness.close();
    }
  });

  it('treats an unconfirmed dispatched start as unreconciled', () => {
    const harness = makeHarness();
    try {
      harness.store.insert(taskRecord({
        state: 'failed',
        startedAt: BASE_TIME,
        finishedAt: BASE_TIME,
        failureCode: 'ASSISTANT_TASK_START_OUTCOME_UNCONFIRMED',
      }));
      expect(harness.store.getUnreconciledTask()).toMatchObject({
        taskId: 'task-1',
        failureCode: 'ASSISTANT_TASK_START_OUTCOME_UNCONFIRMED',
      });
    } finally {
      harness.close();
    }
  });
});

it('migrates an existing assistant_tasks table to durable project policy storage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-lens-assistant-policy-'));
  const path = join(directory, 'gateway.sqlite');
  const legacy = new Database(path);
  try {
    legacy.exec(`
      CREATE TABLE assistant_tasks (
        task_id TEXT PRIMARY KEY,
        confirmation_id TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        instruction TEXT NOT NULL,
        scope TEXT NOT NULL,
        project_id TEXT,
        working_directory TEXT NOT NULL,
        state TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        prepared_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        thread_id TEXT,
        turn_id TEXT,
        summary TEXT,
        failure_code TEXT
      )
    `);
  } finally {
    legacy.close();
  }

  const migrated = openDb(path);
  try {
    const columns = migrated.prepare('PRAGMA table_info(assistant_tasks)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('project_policy_json');
    expect(columns.map((column) => column.name)).toContain('reconciled_at');
    const store = createSqliteAssistantTaskStore(migrated);
    store.insert(taskRecord());
    expect(store.getByTaskId('task-1')?.projectPolicy).toEqual(PROJECT_POLICY);
  } finally {
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function idFactory(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `id-${next}`;
  };
}

function controlledWorker() {
  const runs = new Map<string, {
    result: Deferred<AssistantTaskWorkerResult>;
    cancel: ReturnType<typeof vi.fn>;
  }>();
  const worker: AssistantTaskWorker = vi.fn(async (input) => {
    const result = deferred<AssistantTaskWorkerResult>();
    const cancel = vi.fn(async () => undefined);
    runs.set(input.taskId, { result, cancel });
    return ok({
      threadId: `thread-${input.taskId}`,
      turnId: `turn-${input.taskId}`,
      completion: result.promise,
      cancel,
    });
  });
  return { worker, runs };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('assistant task service', () => {
  it('does not recover persisted running work until the service is explicitly activated', async () => {
    const store = createMemoryAssistantTaskStore();
    store.insert(taskRecord({ state: 'running', startedAt: BASE_TIME }));
    const service = createAssistantTaskService({
      store,
      now: () => new Date('2026-09-02T17:03:00.000Z'),
    });

    expect(store.getByTaskId('task-1')).toMatchObject({ state: 'running' });
    await expect(service.status('task-1')).resolves.toEqual(err(
      'ASSISTANT_TASK_SERVICE_NOT_ACTIVE',
      'The assistant task service is not active on the gateway listener.',
    ));
    expect(store.getByTaskId('task-1')).toMatchObject({ state: 'running' });

    service.activate();
    expect(store.getByTaskId('task-1')).toMatchObject({
      state: 'failed',
      failureCode: 'GATEWAY_RESTART_OUTCOME_UNCERTAIN',
      finishedAt: '2026-09-02T17:03:00.000Z',
    });
  });

  it('stays inactive when interrupted-task recovery throws', async () => {
    const baseStore = createMemoryAssistantTaskStore();
    const store: AssistantTaskStore = {
      ...baseStore,
      failInterrupted() { throw new Error('database unavailable'); },
    };
    const service = createAssistantTaskService({ store });

    expect(() => service.activate()).toThrow('database unavailable');
    await expect(service.status('task-1')).resolves.toMatchObject({
      ok: false,
      error: { code: 'ASSISTANT_TASK_SERVICE_NOT_ACTIVE' },
    });
  });

  it('prepares a trimmed, task-bound confirmation without starting work', async () => {
    const controlled = controlledWorker();
    const service = createActiveAssistantTaskService({
      worker: controlled.worker,
      now: () => new Date(BASE_TIME),
      id: idFactory(),
      projectResolver: () => ok(registryProject()),
    });

    const prepared = await service.prepare({
      instruction: '  Run the existing tests.  ',
      scope: 'project',
      projectId: 'codex-lens',
      workingDirectory: '/tmp/codex-lens',
      projectPolicy: PROJECT_POLICY,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value).toMatchObject({
      taskId: 'id-1',
      confirmationId: 'id-2',
      instruction: 'Run the existing tests.',
      scope: 'project',
      projectId: 'codex-lens',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      requiresExplicitConfirmation: false,
    });
    expect(prepared.value.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(controlled.worker).not.toHaveBeenCalled();
    await expect(service.status(prepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: 'prepared' },
    });
  });

  it('fails closed when project policy cannot be independently verified', async () => {
    const controlled = controlledWorker();
    const service = createActiveAssistantTaskService({ worker: controlled.worker, id: idFactory() });
    await expect(service.prepare({
      instruction: 'Run the existing tests.',
      scope: 'project',
      projectId: 'codex-lens',
      workingDirectory: PROJECT_POLICY.root,
      projectPolicy: PROJECT_POLICY,
    })).resolves.toEqual(err(
      'ASSISTANT_TASK_PROJECT_POLICY_UNAVAILABLE',
      'The selected project policy could not be verified. Nothing was prepared.',
    ));
    expect(controlled.worker).not.toHaveBeenCalled();
  });

  it('binds the complete project policy snapshot into the confirmation digest', async () => {
    const expanded = registryProject({ allowedCommands: Object.freeze(['npm test', 'npm run lint']) });
    const common = {
      worker: controlledWorker().worker,
      now: () => new Date(BASE_TIME),
      id: idFactory(),
    };
    const first = createActiveAssistantTaskService({
      ...common,
      projectResolver: () => ok(registryProject()),
    });
    const second = createActiveAssistantTaskService({
      ...common,
      id: idFactory(),
      projectResolver: () => ok(expanded),
    });
    const firstPrepared = await first.prepare({
      instruction: 'Run the tests.',
      scope: 'project',
      projectId: 'codex-lens',
      workingDirectory: PROJECT_POLICY.root,
      projectPolicy: PROJECT_POLICY,
    });
    const secondPrepared = await second.prepare({
      instruction: 'Run the tests.',
      scope: 'project',
      projectId: 'codex-lens',
      workingDirectory: PROJECT_POLICY.root,
      projectPolicy: assistantTaskProjectPolicyFromRegistry(expanded),
    });
    if (!firstPrepared.ok || !secondPrepared.ok) throw new Error('prepare failed');
    expect(firstPrepared.value.taskId).toBe(secondPrepared.value.taskId);
    expect(firstPrepared.value.confirmationId).toBe(secondPrepared.value.confirmationId);
    expect(firstPrepared.value.digest).not.toBe(secondPrepared.value.digest);
  });

  it.each([
    ['blank instruction', { instruction: '  ', scope: 'mac' as const, workingDirectory: '/tmp' }],
    ['oversized instruction', { instruction: 'x'.repeat(8_001), scope: 'mac' as const, workingDirectory: '/tmp' }],
    ['blank working directory', { instruction: 'Do it', scope: 'mac' as const, workingDirectory: ' ' }],
    ['missing project id', { instruction: 'Do it', scope: 'project' as const, workingDirectory: '/tmp' }],
    ['project id on Mac scope', {
      instruction: 'Do it', scope: 'mac' as const, projectId: 'unexpected', workingDirectory: '/tmp',
    }],
  ])('rejects %s before persisting or running', async (_label, request) => {
    const controlled = controlledWorker();
    const service = createActiveAssistantTaskService({ worker: controlled.worker });
    const result = await service.prepare(request);
    expect(result.ok).toBe(false);
    expect(controlled.worker).not.toHaveBeenCalled();
  });

  it('rejects a digest mismatch without consuming the valid preparation', async () => {
    const controlled = controlledWorker();
    const service = createActiveAssistantTaskService({
      worker: controlled.worker,
      now: () => new Date(BASE_TIME),
      id: idFactory(),
    });
    const prepared = await service.prepare({
      instruction: 'Open Xcode.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!prepared.ok) throw new Error(prepared.error.message);

    await expect(service.start({
      confirmationId: prepared.value.confirmationId,
      digest: '0'.repeat(64),
      authorization: authorizationFor(prepared.value),
    })).resolves.toEqual(err(
      'ASSISTANT_TASK_CONFIRMATION_MISMATCH',
      'The task confirmation did not match. Nothing ran.',
    ));
    expect(controlled.worker).not.toHaveBeenCalled();

    const started = await service.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: authorizationFor(prepared.value),
    });
    expect(started).toMatchObject({
      ok: true,
      value: {
        taskId: prepared.value.taskId,
        state: 'running',
        threadId: `thread-${prepared.value.taskId}`,
        model: 'gpt-5.6-sol',
        reasoningEffort: 'medium',
        expiresAt: expect.any(String),
      },
    });
    expect(controlled.worker).toHaveBeenCalledWith(expect.objectContaining({
      taskId: prepared.value.taskId,
      instruction: 'Open Xcode.',
      scope: 'mac',
      authorization: 'single_utterance',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      workingDirectory: '/tmp',
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    }));
  });

  it('requires the start authorization to match the gateway classification', async () => {
    const controlled = controlledWorker();
    const service = createActiveAssistantTaskService({ worker: controlled.worker, id: idFactory() });
    const safe = await service.prepare({
      instruction: 'Open Xcode.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!safe.ok) throw new Error(safe.error.message);
    await expect(service.start({
      confirmationId: safe.value.confirmationId,
      digest: safe.value.digest,
      authorization: 'explicit_confirmation',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ASSISTANT_TASK_SINGLE_UTTERANCE_AUTHORIZATION_REQUIRED' },
    });

    const consequential = await service.prepare({
      instruction: 'Send $20 to Jamie.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!consequential.ok) throw new Error(consequential.error.message);
    await expect(service.start({
      confirmationId: consequential.value.confirmationId,
      digest: consequential.value.digest,
      authorization: 'single_utterance',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ASSISTANT_TASK_EXPLICIT_CONFIRMATION_REQUIRED' },
    });
    expect(controlled.worker).not.toHaveBeenCalled();
  });

  it('persists redacted worker progress for status reads', async () => {
    let capturedInput: Parameters<AssistantTaskWorker>[0] | undefined;
    const completion = deferred<AssistantTaskWorkerResult>();
    const worker: AssistantTaskWorker = vi.fn(async (input) => {
      capturedInput = input;
      return ok({
        threadId: 'thread-progress',
        turnId: 'turn-progress',
        completion: completion.promise,
        cancel: vi.fn(async () => undefined),
      });
    });
    const service = createActiveAssistantTaskService({ worker, id: idFactory() });
    const prepared = await service.prepare({
      instruction: 'Inspect the project.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    await service.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: authorizationFor(prepared.value),
    });

    capturedInput?.onProgress?.('Codex completed a command step for the confirmed task.');
    await expect(service.status(prepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'running',
        summary: 'Codex completed a command step for the confirmed task.',
      },
    });

    completion.resolve({ state: 'completed', summary: 'Inspection complete.' });
    await flushPromises();
  });

  it('expires at the deadline and cannot be replayed', async () => {
    let time = new Date(BASE_TIME);
    const controlled = controlledWorker();
    const service = createActiveAssistantTaskService({
      worker: controlled.worker,
      now: () => time,
      id: idFactory(),
      ttlMs: 1_000,
    });
    const prepared = await service.prepare({
      instruction: 'Open Xcode.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    time = new Date('2026-09-02T17:00:01.000Z');

    const expired = await service.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: authorizationFor(prepared.value),
    });
    expect(expired).toEqual(err(
      'ASSISTANT_TASK_CONFIRMATION_EXPIRED',
      'That task confirmation expired. Prepare it again.',
    ));
    expect(controlled.worker).not.toHaveBeenCalled();
    await expect(service.status(prepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: 'expired', finishedAt: time.toISOString() },
    });
    await expect(service.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: authorizationFor(prepared.value),
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ASSISTANT_TASK_ALREADY_CONSUMED' },
    });
  });

  it('materializes an expired prepared confirmation during a status read', async () => {
    let time = new Date(BASE_TIME);
    const service = createActiveAssistantTaskService({
      worker: controlledWorker().worker,
      now: () => time,
      id: idFactory(),
      ttlMs: 1_000,
    });
    const prepared = await service.prepare({
      instruction: 'Open Xcode.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    time = new Date('2026-09-02T17:00:01.000Z');

    await expect(service.status(prepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'expired',
        expiresAt: time.toISOString(),
        finishedAt: time.toISOString(),
      },
    });
  });

  it('allows only one running task and leaves the second confirmation usable', async () => {
    const controlled = controlledWorker();
    const service = createActiveAssistantTaskService({
      worker: controlled.worker,
      now: () => new Date(BASE_TIME),
      id: idFactory(),
    });
    const first = await service.prepare({ instruction: 'First', scope: 'mac', workingDirectory: '/tmp' });
    const second = await service.prepare({ instruction: 'Second', scope: 'mac', workingDirectory: '/tmp' });
    if (!first.ok || !second.ok) throw new Error('prepare failed');
    await service.start({
      confirmationId: first.value.confirmationId,
      digest: first.value.digest,
      authorization: authorizationFor(first.value),
    });

    await expect(service.start({
      confirmationId: second.value.confirmationId,
      digest: second.value.digest,
      authorization: authorizationFor(second.value),
    })).resolves.toEqual(err('ASSISTANT_TASK_BUSY', 'Another full Codex task is already running.'));
    expect(controlled.worker).toHaveBeenCalledTimes(1);

    controlled.runs.get(first.value.taskId)?.result.resolve({
      state: 'completed', summary: 'First finished and was verified.',
    });
    await flushPromises();
    const secondStarted = await service.start({
      confirmationId: second.value.confirmationId,
      digest: second.value.digest,
      authorization: authorizationFor(second.value),
    });
    expect(secondStarted).toMatchObject({ ok: true, value: { state: 'running' } });
    expect(controlled.worker).toHaveBeenCalledTimes(2);
  });

  it('persists terminal worker results and ignores a replay', async () => {
    const controlled = controlledWorker();
    const service = createActiveAssistantTaskService({ worker: controlled.worker, id: idFactory() });
    const prepared = await service.prepare({
      instruction: 'Run tests.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    await service.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: authorizationFor(prepared.value),
    });
    controlled.runs.get(prepared.value.taskId)?.result.resolve({
      state: 'blocked',
      summary: 'Xcode needs the operator to sign in.',
      failureCode: 'USER_SIGN_IN_REQUIRED',
    });
    await flushPromises();

    await expect(service.status(prepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'blocked',
        summary: 'Xcode needs the operator to sign in.',
        failureCode: 'USER_SIGN_IN_REQUIRED',
      },
    });
    await expect(service.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: authorizationFor(prepared.value),
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ASSISTANT_TASK_ALREADY_CONSUMED' },
    });
    expect(controlled.worker).toHaveBeenCalledOnce();
  });

  it('records a rejected or crashing worker start as a non-replayable failure', async () => {
    const rejectedWorker: AssistantTaskWorker = vi.fn(async () => err(
      'ASSISTANT_TASK_CODEX_UNAVAILABLE', 'Codex is not available.',
    ));
    const service = createActiveAssistantTaskService({ worker: rejectedWorker, id: idFactory() });
    const prepared = await service.prepare({
      instruction: 'Run tests.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    await expect(service.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: authorizationFor(prepared.value),
    })).resolves.toEqual(err('ASSISTANT_TASK_CODEX_UNAVAILABLE', 'Codex is not available.'));
    await expect(service.status(prepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: 'failed', failureCode: 'ASSISTANT_TASK_CODEX_UNAVAILABLE' },
    });

    const crashingWorker: AssistantTaskWorker = vi.fn(async () => {
      throw new Error('process launch failed');
    });
    const crashingService = createActiveAssistantTaskService({ worker: crashingWorker, id: idFactory() });
    const crashingPrepared = await crashingService.prepare({
      instruction: 'Run tests.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!crashingPrepared.ok) throw new Error(crashingPrepared.error.message);
    await expect(crashingService.start({
      confirmationId: crashingPrepared.value.confirmationId,
      digest: crashingPrepared.value.digest,
      authorization: authorizationFor(crashingPrepared.value),
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ASSISTANT_TASK_PROCESS_CLEANUP_UNCONFIRMED' },
    });
    await expect(crashingService.status(crashingPrepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: 'failed', failureCode: 'ASSISTANT_TASK_PROCESS_CLEANUP_UNCONFIRMED' },
    });
  });

  it('records a rejected completion promise as a worker crash', async () => {
    const controlled = controlledWorker();
    const service = createActiveAssistantTaskService({ worker: controlled.worker, id: idFactory() });
    const prepared = await service.prepare({
      instruction: 'Run tests.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    await service.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: authorizationFor(prepared.value),
    });
    controlled.runs.get(prepared.value.taskId)?.result.reject(new Error('worker exited'));
    await flushPromises();
    await expect(service.status(prepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: 'failed', failureCode: 'ASSISTANT_TASK_WORKER_CRASHED' },
    });
  });

  it('cancels prepared and running work without allowing late completion to overwrite it', async () => {
    const controlled = controlledWorker();
    const service = createActiveAssistantTaskService({ worker: controlled.worker, id: idFactory() });
    const preparedOnly = await service.prepare({
      instruction: 'Prepared only.', scope: 'mac', workingDirectory: '/tmp',
    });
    const running = await service.prepare({
      instruction: 'Running.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!preparedOnly.ok || !running.ok) throw new Error('prepare failed');

    await expect(service.cancel(preparedOnly.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: 'cancelled', summary: 'The prepared task was cancelled before it started.' },
    });
    expect(controlled.worker).not.toHaveBeenCalled();

    await service.start({
      confirmationId: running.value.confirmationId,
      digest: running.value.digest,
      authorization: authorizationFor(running.value),
    });
    const run = controlled.runs.get(running.value.taskId);
    if (run === undefined) throw new Error('worker did not start');
    await expect(service.cancel(running.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: 'cancelled', summary: 'The task was cancelled.' },
    });
    expect(run.cancel).toHaveBeenCalledOnce();
    run.result.resolve({ state: 'completed', summary: 'Late completion.' });
    await flushPromises();
    await expect(service.status(running.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: 'cancelled', summary: 'The task was cancelled.' },
    });
  });

  it('locks an unconfirmed cancellation without leaving a permanently running task', async () => {
    const completion = deferred<AssistantTaskWorkerResult>();
    const worker: AssistantTaskWorker = vi.fn(async () => ok({
      threadId: 'thread-1',
      turnId: 'turn-1',
      completion: completion.promise,
      cancel: vi.fn(async () => { throw new Error('interrupt failed'); }),
    }));
    const service = createActiveAssistantTaskService({ worker, id: idFactory() });
    const prepared = await service.prepare({
      instruction: 'Run tests.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    await service.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: authorizationFor(prepared.value),
    });

    await expect(service.cancel(prepared.value.taskId)).resolves.toEqual(err(
      'ASSISTANT_TASK_CANCEL_FAILED',
      'Codex did not prove that cancellation completed. The task outcome is uncertain.',
    ));
    await expect(service.status(prepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'failed',
        failureCode: 'ASSISTANT_TASK_CANCEL_UNCONFIRMED',
        summary: expect.stringContaining('uncertain'),
      },
    });
  });

  it('bounds a cancellation that never settles and records an uncertain outcome', async () => {
    const completion = deferred<AssistantTaskWorkerResult>();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const worker: AssistantTaskWorker = vi.fn(async () => ok({
      threadId: 'thread-1',
      turnId: 'turn-1',
      completion: completion.promise,
      cancel,
    }));
    const service = createActiveAssistantTaskService({
      worker,
      id: idFactory(),
      shutdownTimeoutMs: 10,
    });
    const prepared = await service.prepare({
      instruction: 'Run tests.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    await service.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: authorizationFor(prepared.value),
    });

    await expect(service.cancel(prepared.value.taskId)).resolves.toMatchObject({
      ok: false,
      error: { code: 'ASSISTANT_TASK_CANCEL_FAILED' },
    });
    await expect(service.status(prepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'failed',
        failureCode: 'ASSISTANT_TASK_CANCEL_UNCONFIRMED',
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('closes a running worker only after cancellation, completion, and process close settle', async () => {
    const completion = deferred<AssistantTaskWorkerResult>();
    const close = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => {
      completion.resolve({ state: 'cancelled', summary: 'The task was cancelled.' });
    });
    const worker: AssistantTaskWorker = vi.fn(async () => ok({
      threadId: 'thread-1', turnId: 'turn-1', completion: completion.promise, cancel, close,
    }));
    const service = createActiveAssistantTaskService({ worker, id: idFactory(), shutdownTimeoutMs: 50 });
    const prepared = await service.prepare({
      instruction: 'Run tests.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    await service.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: authorizationFor(prepared.value),
    });

    await service.close();

    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await expect(service.status(prepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: 'cancelled' },
    });
    await expect(service.prepare({
      instruction: 'Another task.', scope: 'mac', workingDirectory: '/tmp',
    })).resolves.toMatchObject({ ok: false, error: { code: 'ASSISTANT_TASK_SERVICE_CLOSING' } });
  });

  it('persists an unknown-outcome lock when shutdown cannot prove process cleanup', async () => {
    const store = createMemoryAssistantTaskStore();
    const completion = deferred<AssistantTaskWorkerResult>();
    const worker: AssistantTaskWorker = vi.fn(async () => ok({
      threadId: 'thread-1',
      turnId: 'turn-1',
      completion: completion.promise,
      cancel: vi.fn(async () => { throw new Error('no stop acknowledgement'); }),
      close: vi.fn(async () => { throw new Error('process group survived'); }),
    }));
    const service = createActiveAssistantTaskService({
      store, worker, id: idFactory(), shutdownTimeoutMs: 20,
    });
    const prepared = await service.prepare({
      instruction: 'Run tests.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    await service.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: authorizationFor(prepared.value),
    });

    await service.close();

    await expect(service.status(prepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'failed',
        failureCode: 'ASSISTANT_TASK_PROCESS_CLEANUP_UNCONFIRMED',
      },
    });
    expect(store.getUnreconciledTask()?.taskId).toBe(prepared.value.taskId);
  });

  it('aborts and owns a worker that is still starting during shutdown', async () => {
    const workerResult = deferred<Awaited<ReturnType<AssistantTaskWorker>>>();
    let workerInput: Parameters<AssistantTaskWorker>[0] | undefined;
    const completion = deferred<AssistantTaskWorkerResult>();
    const close = vi.fn(async () => undefined);
    const worker: AssistantTaskWorker = vi.fn(async (input) => {
      workerInput = input;
      return workerResult.promise;
    });
    const service = createActiveAssistantTaskService({
      worker, id: idFactory(), shutdownTimeoutMs: 100,
    });
    const prepared = await service.prepare({
      instruction: 'Run tests.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const start = service.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: authorizationFor(prepared.value),
    });
    await vi.waitFor(() => expect(workerInput).toBeDefined());
    const closing = service.close();
    expect(workerInput?.signal?.aborted).toBe(true);
    workerResult.resolve(ok({
      threadId: 'thread-1',
      turnId: 'turn-1',
      completion: completion.promise,
      cancel: vi.fn(async () => {
        completion.resolve({ state: 'cancelled', summary: 'The task was cancelled.' });
      }),
      close,
    }));

    await closing;
    await expect(start).resolves.toMatchObject({ ok: false });
    expect(close).toHaveBeenCalledOnce();
    await expect(service.status(prepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: 'cancelled' },
    });
  });

  it('locks new execution after restart uncertainty until explicit reconciliation', async () => {
    const store = createMemoryAssistantTaskStore();
    store.insert(taskRecord({ state: 'running', startedAt: BASE_TIME }));
    const controlled = controlledWorker();
    const service = createActiveAssistantTaskService({
      store,
      worker: controlled.worker,
      now: () => new Date('2026-09-02T17:03:00.000Z'),
      id: idFactory(),
    });

    await expect(service.status('task-1')).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'failed',
        failureCode: 'GATEWAY_RESTART_OUTCOME_UNCERTAIN',
        summary: expect.stringContaining('outcome is unknown'),
        finishedAt: '2026-09-02T17:03:00.000Z',
      },
    });

    const next = await service.prepare({
      instruction: 'Run a separate task.',
      scope: 'mac',
      workingDirectory: '/tmp',
    });
    if (!next.ok) throw new Error(next.error.message);
    await expect(service.start({
      confirmationId: next.value.confirmationId,
      digest: next.value.digest,
      authorization: authorizationFor(next.value),
    })).resolves.toEqual(err(
      'ASSISTANT_TASK_RECONCILIATION_REQUIRED',
      'Task task-1 ended without a verified outcome. Inspect its target, then explicitly reconcile it before starting another task.',
    ));
    expect(controlled.worker).not.toHaveBeenCalled();

    await expect(service.reconcile('task-1')).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'failed',
        failureCode: 'GATEWAY_RESTART_OUTCOME_UNCERTAIN',
        summary: expect.stringContaining('outcome is unknown'),
        reconciledAt: '2026-09-02T17:03:00.000Z',
      },
    });
    await expect(service.start({
      confirmationId: next.value.confirmationId,
      digest: next.value.digest,
      authorization: authorizationFor(next.value),
    })).resolves.toMatchObject({ ok: true, value: { state: 'running' } });
    expect(controlled.worker).toHaveBeenCalledOnce();
  });

  it('locks new execution after a dispatched start has no confirmed outcome', async () => {
    const completion = deferred<AssistantTaskWorkerResult>();
    const worker: AssistantTaskWorker = vi.fn()
      .mockResolvedValueOnce(err(
        'ASSISTANT_TASK_START_OUTCOME_UNCONFIRMED',
        'Codex did not confirm whether the dispatched task started.',
      ))
      .mockResolvedValueOnce(ok({
        threadId: 'thread-after-reconciliation',
        turnId: 'turn-after-reconciliation',
        completion: completion.promise,
        cancel: vi.fn(async () => undefined),
      }));
    const service = createActiveAssistantTaskService({
      worker,
      now: () => new Date(BASE_TIME),
      id: idFactory(),
    });
    const first = await service.prepare({
      instruction: 'Perform the first exact task.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!first.ok) throw new Error(first.error.message);
    await expect(service.start({
      confirmationId: first.value.confirmationId,
      digest: first.value.digest,
      authorization: authorizationFor(first.value),
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ASSISTANT_TASK_START_OUTCOME_UNCONFIRMED' },
    });
    await expect(service.status(first.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'failed',
        failureCode: 'ASSISTANT_TASK_START_OUTCOME_UNCONFIRMED',
        summary: expect.stringContaining('unknown outcome'),
      },
    });

    const second = await service.prepare({
      instruction: 'Perform the second exact task.', scope: 'mac', workingDirectory: '/tmp',
    });
    if (!second.ok) throw new Error(second.error.message);
    await expect(service.start({
      confirmationId: second.value.confirmationId,
      digest: second.value.digest,
      authorization: authorizationFor(second.value),
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ASSISTANT_TASK_RECONCILIATION_REQUIRED' },
    });
    expect(worker).toHaveBeenCalledOnce();

    await expect(service.reconcile(first.value.taskId)).resolves.toMatchObject({ ok: true });
    await expect(service.start({
      confirmationId: second.value.confirmationId,
      digest: second.value.digest,
      authorization: authorizationFor(second.value),
    })).resolves.toMatchObject({ ok: true, value: { state: 'running' } });
    expect(worker).toHaveBeenCalledTimes(2);
    completion.resolve({ state: 'completed', summary: 'Done.' });
  });
});
