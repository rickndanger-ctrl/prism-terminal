import { describe, expect, it, vi } from 'vitest';

import { err, ok } from '@codex-lens/shared';

import {
  createCodexAssistantTaskWorker,
  deterministicAppFocusTarget,
  deterministicWindowAction,
  type AssistantTaskWorkerHandle,
} from '../src/assistant/codexTaskWorker.js';
import type {
  AppServerHandle,
  AppServerMessage,
  AppServerTermination,
  StartAppServerOptions,
} from '../src/codex/transport.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

interface FakeAppServer extends AppServerHandle {
  sent: AppServerMessage[];
  finish(termination: AppServerTermination): void;
}

function fakeAppServer(options: {
  acknowledgeInterrupt?: boolean;
  acknowledgeTurnStart?: boolean;
  completeInterrupted?: boolean;
  closeError?: Error;
  mcpToolsAvailable?: boolean;
  /** Ends the started turn the way Codex does when it cannot run it at all. */
  failTurnWith?: { message: string; codexErrorInfo?: string };
  onSend?: (message: AppServerMessage) => void;
} = {}): FakeAppServer {
  const listeners = new Set<(message: AppServerMessage) => void>();
  const termination = deferred<AppServerTermination>();
  const sent: AppServerMessage[] = [];
  let closed = false;

  const emit = (message: AppServerMessage): void => {
    for (const listener of [...listeners]) listener(message);
  };

  return {
    sent,
    terminated: termination.promise,
    finish: termination.resolve,
    async send(message) {
      if (closed) throw new Error('fake app-server is closed');
      sent.push(message);
      options.onSend?.(message);
      const method = String(message.method);
      let result: Record<string, unknown> | undefined;
      if (method === 'initialize') {
        result = { userAgent: 'fake-codex' };
      } else if (method === 'getAuthStatus') {
        result = {
          authMethod: 'chatgpt',
          authToken: null,
          requiresOpenaiAuth: true,
        };
      } else if (method === 'thread/start') {
        result = { thread: { id: 'thread-1' } };
      } else if (method === 'mcpServerStatus/list') {
        result = { data: [{ name: 'computer_use', tools: options.mcpToolsAvailable === false
          ? {} : { get_app_state: {}, type_text: {} } }], nextCursor: null };
      } else if (method === 'turn/start' && options.acknowledgeTurnStart !== false) {
        result = { turn: { id: 'turn-1' } };
      } else if (method === 'turn/interrupt' && options.acknowledgeInterrupt) {
        result = {};
      }
      if (result !== undefined) {
        queueMicrotask(() => emit({ jsonrpc: '2.0', id: message.id, result }));
      }
      if (method === 'turn/start' && options.failTurnWith !== undefined) {
        const failure = options.failTurnWith;
        queueMicrotask(() => emit({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: 'turn-1', status: 'failed', items: [], error: failure },
          },
        }));
      }
      if (method === 'turn/interrupt' && options.completeInterrupted) {
        queueMicrotask(() => emit({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: 'turn-1', status: 'interrupted' },
          },
        }));
      }
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    [Symbol.asyncIterator]() {
      return { next: () => Promise.resolve({ value: undefined, done: true }) };
    },
    async close() {
      closed = true;
      listeners.clear();
      if (options.closeError !== undefined) throw options.closeError;
    },
  };
}

async function startWorker(
  server: FakeAppServer,
  timing: { executionTimeoutMs?: number; stopConfirmTimeoutMs?: number } = {},
): Promise<AssistantTaskWorkerHandle> {
  const worker = createCodexAssistantTaskWorker({
    startClient: () => server,
    startTimeoutMs: 100,
    ...timing,
  });
  const result = await worker({
    taskId: 'task-1',
    instruction: 'Read the package name and report it without changing anything.',
    workingDirectory: '/tmp',
    scope: 'mac',
    authorization: 'explicit_confirmation',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('deterministic app focus fast path', () => {
  it('delivers the exact reference image to the Codex turn alongside the original task', async () => {
    const server = fakeAppServer({ completeInterrupted: true });
    const worker = createCodexAssistantTaskWorker({ startClient: () => server, startTimeoutMs: 100 });
    const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0xff, 0xd9]).toString('base64');
    const result = await worker({ taskId: 'visual-task', instruction: 'Build a Blender model of this vase.',
      workingDirectory: '/tmp', scope: 'mac', authorization: 'single_utterance',
      visualReferences: [{ label: 'Glasses photo', jpegBase64 }] });
    if (!result.ok) throw new Error(result.error.message);
    const turn = server.sent.find((message) => message.method === 'turn/start');
    const input = (turn?.params as { input: Array<{ type: string; text?: string; url?: string }> }).input;
    expect(input[0]?.text).toContain('Build a Blender model of this vase.');
    expect(input).toContainEqual({ type: 'image', url: `data:image/jpeg;base64,${jpegBase64}` });
    expect(input.some((item) => item.type === 'text' && item.text?.includes('Glasses photo'))).toBe(true);
    await result.value.cancel();
    await result.value.completion;
  });

  it('never dispatches a model task when configured native tools are missing', async () => {
    const server = fakeAppServer({ mcpToolsAvailable: false });
    const cleanup = vi.fn();
    const worker = createCodexAssistantTaskWorker({
      startClient: () => server,
      createRuntime: () => ({ codexHome: '/tmp/lens-test-runtime', env: {},
        requiredMcpServers: ['computer_use'], cleanup }),
    });
    const result = await worker({ taskId: 'missing-mcp', instruction: 'Type hello into TextEdit.',
      workingDirectory: '/tmp', scope: 'mac', authorization: 'single_utterance' });
    expect(result).toMatchObject({ ok: false, error: { code: 'ASSISTANT_TASK_TOOLS_UNAVAILABLE' } });
    expect(server.sent.some((message) => message.method === 'turn/start')).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    ['open calculator.', 'calculator'],
    ['Open my code editor', 'Visual Studio Code'],
    ['Open the code editor', 'Visual Studio Code'],
    ['Open my Codex', 'ChatGPT'],
    ['Open texts', 'Messages'],
    ['Open calls', 'FaceTime'],
    ['Open my notes', 'Notes'],
    ['Open Cursor', 'Cursor'],
    ['Open chtgpt', 'ChatGPT'],
    ['Launch the Calculator app', 'Calculator'],
    ['switch to Visual Studio Code', 'Visual Studio Code'],
    ['go to the ChatGPT application', 'ChatGPT'],
    ['Open the Calculator on your computer.', 'Calculator'],
    ['open calculator on my mac', 'calculator'],
    ['Launch Visual Studio Code on this machine', 'Visual Studio Code'],
  ])('extracts one exact app target from %s', (instruction, expected) => {
    expect(deterministicAppFocusTarget(instruction)).toBe(expected);
  });

  it.each([
    'Are you going to open Calculator?',
    'Open Calculator and then close Notes.',
    'Open Settings on both minis.',
    'Open this project in Visual Studio Code.',
    'Tell me how to open Calculator.',
    'Open my browser',
  ])('rejects non-command or compound instruction %s', (instruction) => {
    expect(deterministicAppFocusTarget(instruction)).toBeUndefined();
  });

  it('uses the verified native focuser without starting a model worker', async () => {
    const focusApp = vi.fn(async () => ok({
      app: 'Calculator',
      frontmost: true as const,
    }));
    const startClient = vi.fn();
    const createRuntime = vi.fn();
    const worker = createCodexAssistantTaskWorker({
      focusApp,
      startClient,
      createRuntime,
    });

    const result = await worker({
      taskId: 'task-open-calculator',
      instruction: 'open calculator.',
      workingDirectory: '/tmp',
      scope: 'mac',
      authorization: 'single_utterance',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(focusApp).toHaveBeenCalledWith({ app: 'calculator' });
    expect(startClient).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
    await expect(result.value.completion).resolves.toEqual({
      state: 'completed',
      summary: 'Calculator is open and frontmost.',
    });
  });

  it('fails closed when macOS cannot verify the requested app is frontmost', async () => {
    const worker = createCodexAssistantTaskWorker({
      focusApp: vi.fn(async () => err(
        'FOCUS_APP_NOT_VERIFIED',
        'Calculator opened, but did not become frontmost.',
      )),
      startClient: vi.fn(),
      createRuntime: vi.fn(),
    });

    const result = await worker({
      taskId: 'task-open-calculator',
      instruction: 'Open Calculator.',
      workingDirectory: '/tmp',
      scope: 'mac',
      authorization: 'single_utterance',
    });

    expect(result).toEqual(err(
      'FOCUS_APP_NOT_VERIFIED',
      'Calculator opened, but did not become frontmost.',
    ));
  });
});

describe('deterministic window fast path', () => {
  it.each([
    ['close the current window.', { action: 'close' }],
    ['Can you close the calculator on my Mac?', { action: 'close', app: 'Calculator' }],
    ['close Calculator', { action: 'close', app: 'Calculator' }],
    ['Please close my calculator.', { action: 'close', app: 'Calculator' }],
    ['Could you please close the Calculator app on my Mac?', { action: 'close', app: 'Calculator' }],
    ['close the settings window', { action: 'close', app: 'settings' }],
    ['minimize that Telegram window', { action: 'minimize', app: 'Telegram' }],
    ['restore it', { action: 'restore' }],
    ['maximize the active window', { action: 'restore' }],
  ])('parses %s', (instruction, expected) => {
    expect(deterministicWindowAction(instruction)).toEqual(expected);
  });

  it.each([
    'close the window behind Telegram',
    'do not close Calculator',
    'can you close Calculator and open Notes?',
    'close Calculator if it is not busy',
    'can you tell me how to close Calculator?',
    'minimize the second window',
    'close Settings and open Calculator',
  ])('rejects ambiguous or compound window request %s', (instruction) => {
    expect(deterministicWindowAction(instruction)).toBeUndefined();
  });

  it('focuses a named app and closes its verified front window without a model worker', async () => {
    const focusApp = vi.fn(async () => ok({ app: 'System Settings', frontmost: true as const }));
    const closeWindow = vi.fn(async () => ok({
      app: 'System Settings',
      closed: true,
      needsUserDecision: false,
    }));
    const startClient = vi.fn();
    const worker = createCodexAssistantTaskWorker({
      focusApp,
      closeWindow,
      setWindowState: vi.fn(),
      startClient,
      createRuntime: vi.fn(),
    });
    const result = await worker({
      taskId: 'task-close-settings',
      instruction: 'close the settings window.',
      workingDirectory: '/tmp',
      scope: 'mac',
      authorization: 'single_utterance',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(focusApp).toHaveBeenCalledWith({ app: 'settings' });
    expect(closeWindow).toHaveBeenCalledOnce();
    expect(startClient).not.toHaveBeenCalled();
    await expect(result.value.completion).resolves.toEqual({
      state: 'completed',
      summary: 'The requested window is closed.',
    });
  });

  it('does not claim a window closed when the native result did not confirm it', async () => {
    const closeWindow = vi.fn(async () => ok({ app: 'Calculator', closed: false, needsUserDecision: false }));
    const startClient = vi.fn();
    const worker = createCodexAssistantTaskWorker({ closeWindow, startClient, createRuntime: vi.fn() });
    const result = await worker({ taskId: 'unconfirmed-close', instruction: 'close the window',
      workingDirectory: '/tmp', scope: 'mac', authorization: 'single_utterance' });
    expect(result).toMatchObject({ ok: false, error: { code: 'WINDOW_CLOSE_UNCONFIRMED' } });
    expect(closeWindow).toHaveBeenCalledOnce();
    expect(startClient).not.toHaveBeenCalled();
  });

  it.each(['close', 'minimize', 'restore'])(
    'stops before %s when cancellation arrives during app focus', async (action) => {
      const controller = new AbortController();
      const focusApp = vi.fn(async () => {
        controller.abort();
        return ok({ app: 'Calculator', frontmost: true as const });
      });
      const closeWindow = vi.fn();
      const setWindowState = vi.fn();
      const startClient = vi.fn();
      const onProgress = vi.fn();
      const worker = createCodexAssistantTaskWorker({
        focusApp, closeWindow, setWindowState, startClient, createRuntime: vi.fn(),
      });
      const result = await worker({
        taskId: 'cancel-during-focus', instruction: `${action} the Calculator window`,
        workingDirectory: '/tmp', scope: 'mac', authorization: 'single_utterance',
        signal: controller.signal, onProgress,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'ASSISTANT_TASK_START_ABORTED' } });
      expect(focusApp).toHaveBeenCalledOnce();
      expect(closeWindow).not.toHaveBeenCalled();
      expect(setWindowState).not.toHaveBeenCalled();
      expect(startClient).not.toHaveBeenCalled();
      expect(onProgress).not.toHaveBeenCalled();
    },
  );

  it('minimizes the current window natively without starting Codex', async () => {
    const setWindowState = vi.fn(async () => ok({
      app: 'Telegram',
      action: 'minimize' as const,
      applied: true as const,
      minimized: true,
    }));
    const startClient = vi.fn();
    const worker = createCodexAssistantTaskWorker({
      focusApp: vi.fn(),
      closeWindow: vi.fn(),
      setWindowState,
      startClient,
      createRuntime: vi.fn(),
    });
    const result = await worker({
      taskId: 'task-minimize-current',
      instruction: 'minimize the current window.',
      workingDirectory: '/tmp',
      scope: 'mac',
      authorization: 'single_utterance',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(setWindowState).toHaveBeenCalledWith({ action: 'minimize' });
    expect(startClient).not.toHaveBeenCalled();
  });
});

describe('Codex assistant task worker lifecycle', () => {
  it('reports why Codex stopped instead of a generic parse failure', async () => {
    const message = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.";
    const server = fakeAppServer({ failTurnWith: { message, codexErrorInfo: 'usageLimitExceeded' } });
    const worker = createCodexAssistantTaskWorker({
      startClient: () => server,
      createRuntime: () => ({ codexHome: '/tmp/lens-test-runtime', env: {}, cleanup: vi.fn() }),
    });

    const result = await worker({
      taskId: 'usage-limit',
      instruction: 'Report the macOS version.',
      workingDirectory: '/tmp',
      scope: 'mac',
      authorization: 'single_utterance',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(result.value.completion).resolves.toEqual({
      state: 'failed',
      summary: message,
      failureCode: 'ASSISTANT_TASK_CODEX_USAGE_LIMIT',
    });
  });


  it('starts with the isolated runtime environment and cleans it after completion', async () => {
    let credentialsSealed = false;
    const server = fakeAppServer({
      completeInterrupted: true,
      onSend(message) {
        if (message.method === 'thread/start') {
          expect(credentialsSealed).toBe(true);
        }
      },
    });
    const cleanup = vi.fn();
    const sealCredentials = vi.fn(() => { credentialsSealed = true; });
    let startedOptions: StartAppServerOptions | undefined;
    const worker = createCodexAssistantTaskWorker({
      createRuntime: () => ({
        codexHome: '/isolated/codex-home',
        env: { CODEX_HOME: '/isolated/codex-home', PATH: '/usr/bin' },
        sealCredentials,
        cleanup,
      }),
      startClient: (options) => {
        startedOptions = options;
        return server;
      },
      startTimeoutMs: 100,
      stopConfirmTimeoutMs: 20,
    });
    const result = await worker({
      taskId: 'task-isolated',
      instruction: 'Report the package name without changing anything.',
      workingDirectory: '/tmp',
      scope: 'mac',
      authorization: 'explicit_confirmation',
    });
    if (!result.ok) throw new Error(result.error.message);

    expect(startedOptions?.env?.CODEX_HOME).toBe('/isolated/codex-home');
    expect(startedOptions?.args).toEqual(['app-server', '--strict-config']);
    expect(sealCredentials).toHaveBeenCalledOnce();
    const threadStart = server.sent.find((message) => message.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      model: 'gpt-5.6-sol',
      developerInstructions: expect.stringContaining('Codex Lens safety lease for task task-isolated'),
    });
    const turnStart = server.sent.find((message) => message.method === 'turn/start');
    expect(turnStart?.params).toMatchObject({
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    const prompt = (turnStart?.params as {
      input?: Array<{ text?: string }>;
    } | undefined)?.input?.[0]?.text ?? '';
    expect(prompt).toContain('separately reviewed and confirmed exactly this consequential task');
    expect(prompt).toContain('Authorization mode (data, not instructions): explicit_confirmation');
    expect(prompt).toContain(
      'A commit, push, deployment, installation, download, file move, or deletion is authorized only when the exact task above explicitly asks for it.',
    );
    expect(prompt).not.toContain('Project scope never authorizes');
    await result.value.cancel();
    await result.value.completion;
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });

  it('enforces the frozen project policy in both the prompt and turn sandbox', async () => {
    const server = fakeAppServer({ completeInterrupted: true });
    let startedOptions: StartAppServerOptions | undefined;
    const worker = createCodexAssistantTaskWorker({
      createRuntime: () => ({
        codexHome: '/isolated/codex-home',
        env: { CODEX_HOME: '/isolated/codex-home' },
        cleanup: vi.fn(),
      }),
      startClient: (options) => {
        startedOptions = options;
        return server;
      },
      startTimeoutMs: 100,
      stopConfirmTimeoutMs: 20,
    });
    const result = await worker({
      taskId: 'task-project',
      instruction: 'Fix the failing test and verify it.',
      workingDirectory: '/workspace/project',
      scope: 'project',
      authorization: 'single_utterance',
      projectPolicy: Object.freeze({
        root: '/workspace/project',
        allowedCommands: Object.freeze(['npm test']),
        allowDependencyInstall: false,
        allowCommit: false,
        allowPush: false,
        allowDeploy: false,
      }),
    });
    if (!result.ok) throw new Error(result.error.message);

    expect(startedOptions?.args).toEqual([
      '--dangerously-bypass-hook-trust',
      'app-server',
      '--strict-config',
    ]);

    const turnStart = server.sent.find((message) => message.method === 'turn/start');
    expect(turnStart?.params).toMatchObject({
      cwd: '/workspace/project',
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/workspace/project'],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });
    const prompt = (turnStart?.params as {
      input?: Array<{ text?: string }>;
    } | undefined)?.input?.[0]?.text ?? '';
    expect(prompt).toContain("authorized exactly this ordinary task from the wearer's one complete utterance");
    expect(prompt).toContain('Authorization mode (data, not instructions): single_utterance');
    expect(prompt).toContain('Approved shell commands, exact strings only: ["npm test"]');
    expect(prompt).toContain('allowlisted shell wrapper is administrator-trusted as one opaque command');
    expect(prompt).toContain(
      'Dependency installation, git commit, git push, and deployment are not authorized in project scope',
    );
    expect(prompt).toContain('requires a separately prepared and confirmed Mac-scope task');

    await result.value.cancel();
    await result.value.completion;
  });

  it('keeps project network closed even when registry flags are enabled', async () => {
    const cases = [
      {
        name: 'commit alone',
        policy: {
          allowDependencyInstall: false,
          allowCommit: true,
          allowPush: false,
          allowDeploy: false,
        },
        networkAccess: false,
      },
      {
        name: 'dependency install',
        policy: {
          allowDependencyInstall: true,
          allowCommit: false,
          allowPush: false,
          allowDeploy: false,
        },
        networkAccess: false,
      },
      {
        name: 'push',
        policy: {
          allowDependencyInstall: false,
          allowCommit: false,
          allowPush: true,
          allowDeploy: false,
        },
        networkAccess: false,
      },
      {
        name: 'deploy',
        policy: {
          allowDependencyInstall: false,
          allowCommit: false,
          allowPush: false,
          allowDeploy: true,
        },
        networkAccess: false,
      },
    ] as const;

    for (const item of cases) {
      const server = fakeAppServer({ completeInterrupted: true });
      const worker = createCodexAssistantTaskWorker({
        createRuntime: () => ({
          codexHome: '/isolated/codex-home',
          env: { CODEX_HOME: '/isolated/codex-home' },
          cleanup: vi.fn(),
        }),
        startClient: () => server,
        startTimeoutMs: 100,
        stopConfirmTimeoutMs: 20,
      });
      const result = await worker({
        taskId: `task-network-${item.name}`,
        instruction: 'Perform only the confirmed project operation.',
        workingDirectory: '/workspace/project',
        scope: 'project',
        authorization: 'single_utterance',
        projectPolicy: Object.freeze({
          root: '/workspace/project',
          allowedCommands: Object.freeze(['npm test']),
          ...item.policy,
        }),
      });
      if (!result.ok) throw new Error(result.error.message);

      const turnStart = server.sent.find((message) => message.method === 'turn/start');
      expect(turnStart?.params, item.name).toMatchObject({
        sandboxPolicy: { networkAccess: item.networkAccess },
      });
      const prompt = (turnStart?.params as {
        input?: Array<{ text?: string }>;
      } | undefined)?.input?.[0]?.text ?? '';
      expect(prompt, item.name).toContain(
        'Dependency installation, git commit, git push, and deployment are not authorized in project scope',
      );
      expect(prompt, item.name).not.toContain('allowed only when explicitly requested');
      await result.value.cancel();
      await result.value.completion;
    }
  });

  it('fails completion immediately when the App Server child dies', async () => {
    const server = fakeAppServer();
    const handle = await startWorker(server);

    server.finish({
      kind: 'exit',
      code: 17,
      signal: null,
      expected: false,
    });

    await expect(handle.completion).resolves.toEqual({
      state: 'failed',
      summary: 'The Codex worker process stopped unexpectedly.',
      failureCode: 'ASSISTANT_TASK_APP_SERVER_TERMINATED',
    });
  });

  it('marks a dispatched turn-start timeout as an unknown outcome', async () => {
    const server = fakeAppServer({ acknowledgeTurnStart: false });
    const cleanup = vi.fn();
    const worker = createCodexAssistantTaskWorker({
      startClient: () => server,
      createRuntime: () => ({
        codexHome: '/isolated/codex-home',
        env: { CODEX_HOME: '/isolated/codex-home' },
        cleanup,
      }),
      startTimeoutMs: 10,
    });

    await expect(worker({
      taskId: 'task-start-timeout',
      instruction: 'Perform the exact confirmed task.',
      workingDirectory: '/tmp',
      scope: 'mac',
      authorization: 'explicit_confirmation',
    })).resolves.toEqual(err(
      'ASSISTANT_TASK_START_OUTCOME_UNCONFIRMED',
      'Codex did not confirm whether the dispatched task started. Inspect the task target before reconciling this unknown outcome.',
    ));
    expect(server.sent.some((message) => message.method === 'turn/start')).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('locks the outcome when child death is followed by unconfirmed process cleanup', async () => {
    const server = fakeAppServer({ closeError: new Error('process group survived') });
    const handle = await startWorker(server);

    server.finish({ kind: 'exit', code: 17, signal: null, expected: false });

    await expect(handle.completion).resolves.toMatchObject({
      state: 'failed',
      failureCode: 'ASSISTANT_TASK_PROCESS_CLEANUP_UNCONFIRMED',
      summary: expect.stringContaining('could not be proven stopped'),
    });
  });

  it('reports cleanup uncertainty when an aborted startup cannot close its process', async () => {
    const server = fakeAppServer({ closeError: new Error('process group survived') });
    const signal = new AbortController();
    signal.abort();
    const worker = createCodexAssistantTaskWorker({
      startClient: () => server,
      createRuntime: () => ({
        codexHome: '/isolated/codex-home',
        env: { CODEX_HOME: '/isolated/codex-home' },
        cleanup: vi.fn(),
      }),
      startTimeoutMs: 100,
    });

    await expect(worker({
      taskId: 'task-aborted',
      instruction: 'Inspect the project.',
      workingDirectory: '/tmp',
      scope: 'mac',
      authorization: 'explicit_confirmation',
      signal: signal.signal,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ASSISTANT_TASK_PROCESS_CLEANUP_UNCONFIRMED' },
    });
  });

  it('closes the spawned process when credential sealing fails during startup', async () => {
    const server = fakeAppServer();
    const cleanup = vi.fn();
    const worker = createCodexAssistantTaskWorker({
      startClient: () => server,
      createRuntime: () => ({
        codexHome: '/isolated/codex-home',
        env: { CODEX_HOME: '/isolated/codex-home' },
        sealCredentials() { throw new Error('could not remove auth copy'); },
        cleanup,
      }),
      startTimeoutMs: 100,
    });

    await expect(worker({
      taskId: 'task-seal-failure',
      instruction: 'Inspect the project.',
      workingDirectory: '/tmp',
      scope: 'mac',
      authorization: 'explicit_confirmation',
    })).resolves.toEqual({
      ok: false,
      error: {
        code: 'ASSISTANT_TASK_RUNTIME_UNAVAILABLE',
        message: 'The isolated Codex task credentials could not be sealed.',
      },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(server.send({ jsonrpc: '2.0', id: 99, method: 'initialize' }))
      .rejects.toThrow('fake app-server is closed');
  });

  it.each([
    ['initialize', 1],
    ['thread creation', 3],
    ['turn start', 4],
  ] as const)('closes the spawned process when %s throws', async (_stage, throwOnSubscription) => {
    const server = fakeAppServer();
    const subscribe = server.onMessage.bind(server);
    let subscriptionCount = 0;
    server.onMessage = (listener) => {
      subscriptionCount += 1;
      if (subscriptionCount === throwOnSubscription) {
        throw new Error('transport subscription failed');
      }
      return subscribe(listener);
    };
    const cleanup = vi.fn();
    const worker = createCodexAssistantTaskWorker({
      startClient: () => server,
      createRuntime: () => ({
        codexHome: '/isolated/codex-home',
        env: { CODEX_HOME: '/isolated/codex-home' },
        cleanup,
      }),
      startTimeoutMs: 100,
    });

    await expect(worker({
      taskId: `task-throw-${String(throwOnSubscription)}`,
      instruction: 'Inspect the project.',
      workingDirectory: '/tmp',
      scope: 'mac',
      authorization: 'explicit_confirmation',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ASSISTANT_TASK_TRANSPORT_FAILED' },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(server.send({ jsonrpc: '2.0', id: 99, method: 'initialize' }))
      .rejects.toThrow('fake app-server is closed');
  });

  it('does not claim cancellation from a JSON-RPC acknowledgement alone', async () => {
    const server = fakeAppServer({ acknowledgeInterrupt: true });
    const handle = await startWorker(server, { stopConfirmTimeoutMs: 10 });

    await expect(handle.cancel()).rejects.toThrow(
      'Codex did not confirm that the task stopped.',
    );
    await expect(handle.completion).resolves.toMatchObject({
      state: 'failed',
      failureCode: 'ASSISTANT_TASK_CANCEL_UNCONFIRMED',
      summary: expect.stringContaining('uncertain'),
    });
    expect(server.sent).toContainEqual(expect.objectContaining({
      method: 'turn/interrupt',
    }));
  });

  it('reports an uncertain failure when timeout interruption is unconfirmed', async () => {
    const server = fakeAppServer({ acknowledgeInterrupt: true });
    const handle = await startWorker(server, {
      executionTimeoutMs: 5,
      stopConfirmTimeoutMs: 10,
    });

    await expect(handle.completion).resolves.toMatchObject({
      state: 'failed',
      failureCode: 'ASSISTANT_TASK_TIMEOUT_UNCONFIRMED',
      summary: expect.stringContaining('uncertain'),
    });
    expect(server.sent).toContainEqual(expect.objectContaining({
      method: 'turn/interrupt',
    }));
  });

  it('marks cancellation only after the turn reports interrupted', async () => {
    const server = fakeAppServer({
      acknowledgeInterrupt: true,
      completeInterrupted: true,
    });
    const handle = await startWorker(server, { stopConfirmTimeoutMs: 20 });

    await expect(handle.cancel()).resolves.toBeUndefined();
    await expect(handle.completion).resolves.toEqual({
      state: 'cancelled',
      summary: 'The task was cancelled.',
    });
  });

  it('accepts worker process termination as proof that cancellation stopped execution', async () => {
    const server = fakeAppServer({ acknowledgeInterrupt: true });
    const handle = await startWorker(server, { stopConfirmTimeoutMs: 20 });

    const stopping = handle.cancel();
    server.finish({
      kind: 'exit',
      code: 0,
      signal: null,
      expected: false,
    });

    await expect(stopping).resolves.toBeUndefined();
    await expect(handle.completion).resolves.toEqual({
      state: 'cancelled',
      summary: 'The task was cancelled.',
    });
  });

  it('does not treat a transport error as proof that cancellation stopped execution', async () => {
    const server = fakeAppServer({ acknowledgeInterrupt: true });
    const handle = await startWorker(server, { stopConfirmTimeoutMs: 20 });

    const stopping = handle.cancel();
    server.finish({
      kind: 'error',
      error: new Error('invalid JSONL'),
      expected: false,
    });

    await expect(stopping).rejects.toThrow(
      'Codex did not confirm that the task stopped.',
    );
    await expect(handle.completion).resolves.toMatchObject({
      state: 'failed',
      failureCode: 'ASSISTANT_TASK_CANCEL_UNCONFIRMED',
      summary: expect.stringContaining('uncertain'),
    });
  });
});
