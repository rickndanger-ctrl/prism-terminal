import { homedir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { err, ok } from '@codex-lens/shared';

import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import {
  type AssistantTaskWorker,
  type AssistantTaskWorkerResult,
} from '../src/assistant/codexTaskWorker.js';
import {
  createMemoryAssistantTaskStore,
  type AssistantTaskStore,
} from '../src/assistant/assistantTaskStore.js';
import { createAssistantTaskService } from '../src/assistant/assistantTasks.js';
import { openDb, type Db } from '../src/db/schema.js';
import { waitForOwnedListenerActivations } from '../src/lifecycle/listenerActivation.js';
import { buildServer } from '../src/server.js';

const TOKEN = 'assistant-task-route-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const PROJECT_PATH = '/tmp/codex-lens-approved-project';
const NOW = '2026-09-02T18:00:00.000Z';

function createActiveAssistantTaskService(
  options: Parameters<typeof createAssistantTaskService>[0] = {},
) {
  const service = createAssistantTaskService(options);
  service.activate();
  return service;
}

let originalToken: string | undefined;
const servers = new Set<ReturnType<typeof buildServer>>();
const dbs = new Set<Db>();

beforeEach(() => {
  originalToken = process.env[GATEWAY_TOKEN_ENV];
  process.env[GATEWAY_TOKEN_ENV] = TOKEN;
});

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => server.close()));
  servers.clear();
  for (const db of dbs) db.close();
  dbs.clear();
  if (originalToken === undefined) delete process.env[GATEWAY_TOKEN_ENV];
  else process.env[GATEWAY_TOKEN_ENV] = originalToken;
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

function idFactory(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `route-id-${next}`;
  };
}

function controlledWorker() {
  const completions = new Map<string, Deferred<AssistantTaskWorkerResult>>();
  const cancels = new Map<string, ReturnType<typeof vi.fn>>();
  const worker: AssistantTaskWorker = vi.fn(async (input) => {
    const completion = deferred<AssistantTaskWorkerResult>();
    const cancel = vi.fn(async () => {
      completion.resolve({ state: 'cancelled', summary: 'The task was cancelled.' });
    });
    completions.set(input.taskId, completion);
    cancels.set(input.taskId, cancel);
    return ok({
      threadId: `thread-${input.taskId}`,
      turnId: `turn-${input.taskId}`,
      completion: completion.promise,
      cancel,
    });
  });
  return { worker, completions, cancels };
}

interface ProjectFlags {
  path?: string;
  allowedCommands?: readonly string[];
  allowDependencyInstall?: boolean;
  allowCommit?: boolean;
  allowPush?: boolean;
  allowDeploy?: boolean;
}

function addProject(
  db: Db,
  id: string,
  allowWorkspaceWrite: boolean,
  flags: ProjectFlags = {},
): void {
  db.prepare(`
    INSERT INTO projects (
      id, display_name, path, allowed_commands, allow_workspace_write,
      allow_dependency_install, allow_commit, allow_push, allow_deploy
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    id,
    flags.path ?? PROJECT_PATH,
    JSON.stringify(flags.allowedCommands ?? ['npm test']),
    allowWorkspaceWrite ? 1 : 0,
    flags.allowDependencyInstall === true ? 1 : 0,
    flags.allowCommit === true ? 1 : 0,
    flags.allowPush === true ? 1 : 0,
    flags.allowDeploy === true ? 1 : 0,
  );
}

function makeServer(worker: AssistantTaskWorker = controlledWorker().worker) {
  const db = openDb(':memory:');
  dbs.add(db);
  addProject(db, 'approved-project', true);
  addProject(db, 'read-only-project', false);
  const service = createActiveAssistantTaskService({
    db,
    worker,
    now: () => new Date(NOW),
    id: idFactory(),
    shutdownTimeoutMs: 50,
  });
  const server = buildServer({ db, assistantTaskService: service });
  servers.add(server);
  return { db, server, service };
}

async function prepare(
  server: ReturnType<typeof buildServer>,
  payload: Record<string, unknown>,
) {
  return server.inject({
    method: 'POST',
    url: '/v1/assistant-tasks/prepare',
    headers: AUTH,
    payload,
  });
}

describe('assistant task routes', () => {
  it('closes the listener when interrupted-task recovery fails', async () => {
    const baseStore = createMemoryAssistantTaskStore();
    const store: AssistantTaskStore = {
      ...baseStore,
      failInterrupted() { throw new Error('recovery failed'); },
    };
    const service = createAssistantTaskService({ store });
    const server = buildServer({ assistantTaskService: service });
    servers.add(server);

    await server.listen({ host: '127.0.0.1', port: 0 });
    await expect(waitForOwnedListenerActivations(server)).rejects.toThrow('recovery failed');
    await vi.waitFor(() => expect(server.server.listening).toBe(false));
    await expect(service.status('task-1')).resolves.toMatchObject({
      ok: false,
      error: { code: 'ASSISTANT_TASK_SERVICE_NOT_ACTIVE' },
    });
  });

  it('does not rewrite a live task when a duplicate gateway loses its listener bind', async () => {
    const db = openDb(':memory:');
    dbs.add(db);
    const firstWorker = controlledWorker();
    const firstService = createAssistantTaskService({
      db,
      worker: firstWorker.worker,
      id: idFactory(),
      shutdownTimeoutMs: 50,
    });
    const firstServer = buildServer({ db, assistantTaskService: firstService });
    servers.add(firstServer);
    await firstServer.listen({ host: '127.0.0.1', port: 0 });

    const prepared = await firstService.prepare({
      instruction: 'Keep this task running.', scope: 'mac', workingDirectory: homedir(),
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    await firstService.start({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: 'single_utterance',
    });

    const address = firstServer.server.address();
    if (address === null || typeof address === 'string') throw new Error('missing TCP listener');
    const duplicateService = createAssistantTaskService({ db, worker: controlledWorker().worker });
    const duplicateServer = buildServer({ db, assistantTaskService: duplicateService });
    servers.add(duplicateServer);

    await expect(duplicateServer.listen({
      host: '127.0.0.1',
      port: address.port,
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await expect(firstService.status(prepared.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: 'running' },
    });
  });

  it('requires gateway authentication before preparation or execution', async () => {
    const controlled = controlledWorker();
    const { server } = makeServer(controlled.worker);
    const unauthorizedPrepare = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/prepare',
      payload: { instruction: 'Run tests.', scope: 'mac' },
    });
    const unauthorizedStart = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      payload: { confirmationId: 'unknown', digest: 'a'.repeat(64) },
    });
    expect(unauthorizedPrepare.statusCode).toBe(401);
    expect(unauthorizedStart.statusCode).toBe(401);
    expect(controlled.worker).not.toHaveBeenCalled();
  });

  it('rejects a start request that omits mandatory authorization', async () => {
    const controlled = controlledWorker();
    const { server } = makeServer(controlled.worker);
    const prepared = (await prepare(server, {
      instruction: 'Open Xcode.',
      scope: 'mac',
    })).json<{ confirmationId: string; digest: string }>();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: {
        confirmationId: prepared.confirmationId,
        digest: prepared.digest,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(controlled.worker).not.toHaveBeenCalled();
  });

  it('prepares an approved project task without running it, then starts the exact digest', async () => {
    const controlled = controlledWorker();
    const { server } = makeServer(controlled.worker);
    const preparedResponse = await prepare(server, {
      instruction: 'Run the project tests.',
      scope: 'project',
      projectId: 'approved-project',
    });
    expect(preparedResponse.statusCode).toBe(200);
    const prepared = preparedResponse.json<{
      taskId: string;
      confirmationId: string;
      digest: string;
    }>();
    expect(preparedResponse.json()).toMatchObject({
      taskId: 'route-id-1',
      confirmationId: 'route-id-2',
      instruction: 'Run the project tests.',
      scope: 'project',
      projectId: 'approved-project',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      requiresExplicitConfirmation: false,
    });
    expect(controlled.worker).not.toHaveBeenCalled();

    const started = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: {
        confirmationId: prepared.confirmationId,
        digest: prepared.digest,
        authorization: 'single_utterance',
      },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      taskId: prepared.taskId,
      state: 'running',
      threadId: `thread-${prepared.taskId}`,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
    });
    expect(controlled.worker).toHaveBeenCalledWith(expect.objectContaining({
      taskId: prepared.taskId,
      instruction: 'Run the project tests.',
      scope: 'project',
      authorization: 'single_utterance',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      workingDirectory: PROJECT_PATH,
      onProgress: expect.any(Function),
      projectPolicy: {
        root: PROJECT_PATH,
        allowedCommands: ['npm test'],
        allowDependencyInstall: false,
        allowCommit: false,
        allowPush: false,
        allowDeploy: false,
      },
    }));

    const status = await server.inject({
      method: 'GET',
      url: `/v1/assistant-tasks/${prepared.taskId}`,
      headers: AUTH,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ state: 'running', projectId: 'approved-project' });

    const replay = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: {
        confirmationId: prepared.confirmationId,
        digest: prepared.digest,
        authorization: 'single_utterance',
      },
    });
    expect(replay.statusCode).toBe(409);
    expect(controlled.worker).toHaveBeenCalledOnce();
  });

  it.each([
    ['dependency installation', 'Install the project dependencies and run the tests.'],
    ['commit', 'Commit the changes after the tests pass.'],
    ['push', 'Push the changes to GitHub.'],
    ['deployment', 'Deploy the app to production.'],
  ])('requires separately confirmed Mac scope for project %s', async (action, instruction) => {
    const controlled = controlledWorker();
    const { server } = makeServer(controlled.worker);
    const response = await prepare(server, {
      instruction,
      scope: 'project',
      projectId: 'approved-project',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      message: `Project tasks cannot authorize ${action}. Prepare and separately confirm an exact Mac-scope task.`,
    });
    expect(controlled.worker).not.toHaveBeenCalled();
  });

  it('rejects guarded project actions even when every legacy registry flag is enabled', async () => {
    const controlled = controlledWorker();
    const { db, server } = makeServer(controlled.worker);
    addProject(db, 'permissive-project', true, {
      allowedCommands: ['npm test', 'npm install', 'git commit', 'git push'],
      allowDependencyInstall: true,
      allowCommit: true,
      allowPush: true,
      allowDeploy: true,
    });
    const response = await prepare(server, {
      instruction: 'Install dependencies, commit the changes, push the branch, and deploy the app.',
      scope: 'project',
      projectId: 'permissive-project',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      message: expect.stringContaining('separately confirm an exact Mac-scope task'),
    });
    expect(controlled.worker).not.toHaveBeenCalled();
  });

  it('invalidates a prepared task when project authority is revoked before start', async () => {
    const controlled = controlledWorker();
    const { db, server } = makeServer(controlled.worker);
    const prepared = (await prepare(server, {
      instruction: 'Run the project tests.',
      scope: 'project',
      projectId: 'approved-project',
    })).json<{ taskId: string; confirmationId: string; digest: string }>();

    db.prepare('UPDATE projects SET allow_workspace_write = 0 WHERE id = ?').run('approved-project');
    const start = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: {
        confirmationId: prepared.confirmationId,
        digest: prepared.digest,
        authorization: 'single_utterance',
      },
    });
    expect(start.statusCode).toBe(409);
    expect(start.json()).toMatchObject({
      message: 'The selected project policy changed after confirmation. Nothing ran; prepare the task again.',
    });
    expect(controlled.worker).not.toHaveBeenCalled();

    const status = await server.inject({
      method: 'GET',
      url: `/v1/assistant-tasks/${prepared.taskId}`,
      headers: AUTH,
    });
    expect(status.json()).toMatchObject({
      state: 'cancelled',
      failureCode: 'ASSISTANT_TASK_PROJECT_POLICY_CHANGED',
    });
    const replay = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: {
        confirmationId: prepared.confirmationId,
        digest: prepared.digest,
        authorization: 'single_utterance',
      },
    });
    expect(replay.statusCode).toBe(409);
    expect(controlled.worker).not.toHaveBeenCalled();
  });

  it('invalidates a prepared task when its root or command allowlist changes', async () => {
    const controlled = controlledWorker();
    const { db, server } = makeServer(controlled.worker);
    const prepared = (await prepare(server, {
      instruction: 'Run the project tests.',
      scope: 'project',
      projectId: 'approved-project',
    })).json<{ confirmationId: string; digest: string }>();
    db.prepare('UPDATE projects SET allowed_commands = ? WHERE id = ?')
      .run(JSON.stringify(['npm test', 'npm run lint']), 'approved-project');
    const start = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: {
        confirmationId: prepared.confirmationId,
        digest: prepared.digest,
        authorization: 'single_utterance',
      },
    });
    expect(start.statusCode).toBe(409);
    expect(controlled.worker).not.toHaveBeenCalled();
  });

  it('uses the Mac home directory only for explicitly Mac-scoped work', async () => {
    const controlled = controlledWorker();
    const { server } = makeServer(controlled.worker);
    const response = await prepare(server, {
      instruction: 'Open the Downloads folder.',
      scope: 'mac',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ taskId: string; confirmationId: string; digest: string }>();
    expect(body).not.toHaveProperty('projectId');
    const started = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: {
        confirmationId: body.confirmationId,
        digest: body.digest,
        authorization: 'single_utterance',
      },
    });
    expect(started.statusCode).toBe(200);
    expect(controlled.worker).toHaveBeenCalledWith(expect.objectContaining({
      taskId: body.taskId,
      scope: 'mac',
      authorization: 'single_utterance',
      workingDirectory: homedir(),
    }));

    const invalid = await prepare(server, {
      instruction: 'Open the Downloads folder.',
      scope: 'mac',
      projectId: 'approved-project',
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('lets a caller require spoken confirmation for an otherwise ordinary task, never waive it', async () => {
    const controlled = controlledWorker();
    const { server } = makeServer(controlled.worker);
    const response = await prepare(server, {
      instruction: 'Open the Downloads folder.',
      scope: 'mac',
      requireExplicitConfirmation: true,
    });
    expect(response.statusCode).toBe(200);
    const prepared = response.json<{
      confirmationId: string;
      digest: string;
      requiresExplicitConfirmation: boolean;
      confirmationReason?: string;
    }>();
    expect(prepared.requiresExplicitConfirmation).toBe(true);
    expect(prepared.confirmationReason).toContain('GPT Live');

    const singleUtterance = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: { confirmationId: prepared.confirmationId, digest: prepared.digest, authorization: 'single_utterance' },
    });
    expect(singleUtterance.statusCode).not.toBe(200);
    expect(controlled.worker).not.toHaveBeenCalled();

    const waived = await prepare(server, {
      instruction: 'Open the Downloads folder.',
      scope: 'mac',
      requireExplicitConfirmation: false,
    });
    expect(waived.statusCode).toBe(400);
  });

  it('keeps explicit install, commit, push, and deploy language unchanged for Mac scope', async () => {
    const controlled = controlledWorker();
    const { server } = makeServer(controlled.worker);
    const preparedResponse = await prepare(server, {
      instruction: 'Install the app, commit and push its source, then deploy it.',
      scope: 'mac',
    });
    expect(preparedResponse.statusCode).toBe(200);
    const prepared = preparedResponse.json<{ confirmationId: string; digest: string }>();
    const started = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: {
        confirmationId: prepared.confirmationId,
        digest: prepared.digest,
        authorization: 'explicit_confirmation',
      },
    });
    expect(started.statusCode).toBe(200);
    expect(controlled.worker).toHaveBeenCalledWith(expect.not.objectContaining({ projectPolicy: expect.anything() }));
  });

  it('fails closed for missing, unknown, read-only, or malformed project scopes', async () => {
    const { server } = makeServer();
    const missing = await prepare(server, { instruction: 'Run tests.', scope: 'project' });
    const unknown = await prepare(server, {
      instruction: 'Run tests.', scope: 'project', projectId: 'unknown-project',
    });
    const readOnly = await prepare(server, {
      instruction: 'Change a file.', scope: 'project', projectId: 'read-only-project',
    });
    const extra = await prepare(server, {
      instruction: 'Run tests.', scope: 'project', projectId: 'approved-project', runNow: true,
    });
    expect(missing.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(404);
    expect(readOnly.statusCode).toBe(409);
    expect(extra.statusCode).toBe(400);
  });

  it('does not consume a prepared task when the digest is wrong', async () => {
    const controlled = controlledWorker();
    const { server } = makeServer(controlled.worker);
    const preparedResponse = await prepare(server, { instruction: 'Run tests.', scope: 'mac' });
    const prepared = preparedResponse.json<{ confirmationId: string; digest: string }>();
    const mismatch = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: {
        confirmationId: prepared.confirmationId,
        digest: '0'.repeat(64),
        authorization: 'single_utterance',
      },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(controlled.worker).not.toHaveBeenCalled();
    const valid = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: {
        confirmationId: prepared.confirmationId,
        digest: prepared.digest,
        authorization: 'single_utterance',
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(controlled.worker).toHaveBeenCalledOnce();
  });

  it('enforces one running task through the HTTP boundary', async () => {
    const controlled = controlledWorker();
    const { server } = makeServer(controlled.worker);
    const first = (await prepare(server, { instruction: 'First.', scope: 'mac' }))
      .json<{ confirmationId: string; digest: string }>();
    const second = (await prepare(server, { instruction: 'Second.', scope: 'mac' }))
      .json<{ confirmationId: string; digest: string }>();
    const firstConfirmation = {
      confirmationId: first.confirmationId,
      digest: first.digest,
      authorization: 'single_utterance',
    };
    const secondConfirmation = {
      confirmationId: second.confirmationId,
      digest: second.digest,
      authorization: 'single_utterance',
    };
    expect((await server.inject({
      method: 'POST', url: '/v1/assistant-tasks/start', headers: AUTH, payload: firstConfirmation,
    })).statusCode).toBe(200);
    const busy = await server.inject({
      method: 'POST', url: '/v1/assistant-tasks/start', headers: AUTH, payload: secondConfirmation,
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ message: 'Another full Codex task is already running.' });
    expect(controlled.worker).toHaveBeenCalledOnce();
  });

  it('cancels through the task-specific endpoint and reports durable status', async () => {
    const controlled = controlledWorker();
    const { server } = makeServer(controlled.worker);
    const prepared = (await prepare(server, { instruction: 'Run tests.', scope: 'mac' }))
      .json<{ taskId: string; confirmationId: string; digest: string }>();
    await server.inject({
      method: 'POST', url: '/v1/assistant-tasks/start', headers: AUTH,
      payload: {
        confirmationId: prepared.confirmationId,
        digest: prepared.digest,
        authorization: 'single_utterance',
      },
    });
    const cancelled = await server.inject({
      method: 'POST',
      url: `/v1/assistant-tasks/${prepared.taskId}/cancel`,
      headers: AUTH,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ state: 'cancelled', summary: 'The task was cancelled.' });
    expect(controlled.cancels.get(prepared.taskId)).toHaveBeenCalledOnce();
    const status = await server.inject({
      method: 'GET', url: `/v1/assistant-tasks/${prepared.taskId}`, headers: AUTH,
    });
    expect(status.json()).toMatchObject({ state: 'cancelled' });
  });

  it('cancels a prepared task without ever launching a worker', async () => {
    const controlled = controlledWorker();
    const { server } = makeServer(controlled.worker);
    const prepared = (await prepare(server, { instruction: 'Run tests.', scope: 'mac' }))
      .json<{ taskId: string }>();
    const cancelled = await server.inject({
      method: 'POST', url: `/v1/assistant-tasks/${prepared.taskId}/cancel`, headers: AUTH,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      state: 'cancelled',
      summary: 'The prepared task was cancelled before it started.',
    });
    expect(controlled.worker).not.toHaveBeenCalled();
  });

  it('preClose aborts an in-flight worker startup before Fastify waits for the request', async () => {
    let capturedSignal: AbortSignal | undefined;
    const worker: AssistantTaskWorker = vi.fn(async (input) => {
      capturedSignal = input.signal;
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted === true) resolve();
        else input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return err('ASSISTANT_TASK_START_ABORTED', 'The gateway stopped while Codex was starting.');
    });
    const { server } = makeServer(worker);
    const prepared = (await prepare(server, { instruction: 'Run tests.', scope: 'mac' }))
      .json<{ confirmationId: string; digest: string }>();
    const starting = server.inject({
      method: 'POST', url: '/v1/assistant-tasks/start', headers: AUTH,
      payload: {
        confirmationId: prepared.confirmationId,
        digest: prepared.digest,
        authorization: 'single_utterance',
      },
    });
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());

    await server.close();
    const response = await starting;

    expect(capturedSignal?.aborted).toBe(true);
    expect(response.statusCode).toBe(503);
  });

  it('requires explicit reconciliation after a restart-uncertain task', async () => {
    const db = openDb(':memory:');
    dbs.add(db);
    const firstWorker = controlledWorker();
    let firstId = 0;
    const beforeRestart = createActiveAssistantTaskService({
      db,
      worker: firstWorker.worker,
      id: () => `before-restart-${String(++firstId)}`,
    });
    const first = await beforeRestart.prepare({
      instruction: 'Change one test file.',
      scope: 'mac',
      workingDirectory: homedir(),
    });
    if (!first.ok) throw new Error(first.error.message);
    await beforeRestart.start({
      confirmationId: first.value.confirmationId,
      digest: first.value.digest,
      authorization: 'single_utterance',
    });

    const afterWorker = controlledWorker();
    let afterId = 0;
    const afterRestart = createActiveAssistantTaskService({
      db,
      worker: afterWorker.worker,
      id: () => `after-restart-${String(++afterId)}`,
    });
    const server = buildServer({ db, assistantTaskService: afterRestart });
    servers.add(server);

    const next = (await prepare(server, {
      instruction: 'Run a separate task.',
      scope: 'mac',
    })).json<{ confirmationId: string; digest: string }>();
    const nextConfirmation = {
      confirmationId: next.confirmationId,
      digest: next.digest,
      authorization: 'single_utterance',
    };
    const blocked = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: nextConfirmation,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      message: expect.stringContaining(first.value.taskId),
    });
    expect(afterWorker.worker).not.toHaveBeenCalled();

    const unsafeReconcile = await server.inject({
      method: 'POST',
      url: `/v1/assistant-tasks/${first.value.taskId}/reconcile`,
      headers: AUTH,
      payload: { acknowledgeUnknownOutcome: false },
    });
    expect(unsafeReconcile.statusCode).toBe(400);

    const reconciled = await server.inject({
      method: 'POST',
      url: `/v1/assistant-tasks/${first.value.taskId}/reconcile`,
      headers: AUTH,
      payload: { acknowledgeUnknownOutcome: true },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({
      instruction: 'Change one test file.',
      scope: 'mac',
      state: 'failed',
      failureCode: 'GATEWAY_RESTART_OUTCOME_UNCERTAIN',
      reconciledAt: expect.any(String),
    });

    const started = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: nextConfirmation,
    });
    expect(started.statusCode).toBe(200);
    expect(afterWorker.worker).toHaveBeenCalledOnce();
  });

  it('maps unavailable worker starts and unknown task ids without leaking internals', async () => {
    const unavailable: AssistantTaskWorker = vi.fn(async () => err(
      'ASSISTANT_TASK_CODEX_UNAVAILABLE', 'Codex is unavailable.',
    ));
    const { server } = makeServer(unavailable);
    const prepared = (await prepare(server, { instruction: 'Run tests.', scope: 'mac' }))
      .json<{ taskId: string; confirmationId: string; digest: string }>();
    const started = await server.inject({
      method: 'POST', url: '/v1/assistant-tasks/start', headers: AUTH,
      payload: {
        confirmationId: prepared.confirmationId,
        digest: prepared.digest,
        authorization: 'single_utterance',
      },
    });
    expect(started.statusCode).toBe(503);
    expect(started.json()).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Codex is unavailable.',
    });
    const missing = await server.inject({
      method: 'GET', url: '/v1/assistant-tasks/no-such-task', headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects malformed start, status, and cancel boundaries', async () => {
    const { server } = makeServer();
    const malformedStart = await server.inject({
      method: 'POST',
      url: '/v1/assistant-tasks/start',
      headers: AUTH,
      payload: { confirmationId: 'id', digest: 'not-a-digest' },
    });
    const malformedStatus = await server.inject({
      method: 'GET', url: '/v1/assistant-tasks/%20', headers: AUTH,
    });
    const malformedCancel = await server.inject({
      method: 'POST', url: '/v1/assistant-tasks/%20/cancel', headers: AUTH,
    });
    expect(malformedStart.statusCode).toBe(400);
    expect(malformedStatus.statusCode).toBe(400);
    expect(malformedCancel.statusCode).toBe(400);
  });
});
