import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export type AppServerMessage = Record<string, unknown>;
export type AppServerMessageListener = (message: AppServerMessage) => void;

export interface StartAppServerOptions {
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Listener-only clients need no unconsumed iterator backlog. */
  bufferMessages?: boolean;
}

export type AppServerTermination =
  | {
      kind: 'exit';
      code: number | null;
      signal: NodeJS.Signals | null;
      expected: boolean;
    }
  | {
      kind: 'error';
      error: Error;
      expected: false;
    };

export interface AppServerHandle extends AsyncIterable<AppServerMessage> {
  /**
   * Settles once the transport can no longer deliver messages. Optional so
   * existing injected transports remain source-compatible; the real stdio
   * transport always provides it.
   */
  readonly terminated?: Promise<AppServerTermination>;
  readonly processId?: number;
  send(message: AppServerMessage): Promise<void>;
  onMessage(listener: AppServerMessageListener): () => void;
  close(): Promise<void>;
}

type PendingMessage = {
  resolve: (result: IteratorResult<AppServerMessage>) => void;
  reject: (error: Error) => void;
};

const DEFAULT_COMMAND = 'codex';
const DEFAULT_ARGS = ['app-server'] as const;
const PROCESS_GROUP_GRACE_MS = 1_000;
const PROCESS_GROUP_POLL_MS = 20;

function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
}

type ProcessGroupSignalResult = 'sent' | 'missing' | 'denied';

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals | 0,
): ProcessGroupSignalResult {
  try {
    process.kill(-processGroupId, signal);
    return 'sent';
  } catch (error) {
    if (isMissingProcess(error)) return 'missing';
    // Darwin can briefly return EPERM for a process group whose leader has
    // become a zombie but has not emitted Node's `close` event yet. Treat it as
    // still present and let the bounded wait distinguish that harmless race
    // from a genuinely unkillable group.
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EPERM') return 'denied';
    throw error;
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (signalProcessGroup(processGroupId, 0) !== 'missing') {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(PROCESS_GROUP_POLL_MS, remaining));
    });
  }
  return true;
}

async function terminateProcessGroup(processGroupId: number): Promise<void> {
  const termResult = signalProcessGroup(processGroupId, 'SIGTERM');
  if (termResult === 'missing') return;

  const stopped = await waitForProcessGroupExit(
    processGroupId,
    PROCESS_GROUP_GRACE_MS,
  );
  if (stopped) return;

  const killResult = signalProcessGroup(processGroupId, 'SIGKILL');
  if (killResult === 'missing') return;
  const killed = await waitForProcessGroupExit(
    processGroupId,
    PROCESS_GROUP_GRACE_MS,
  );
  if (!killed) {
    throw new Error('Codex app-server process group did not terminate');
  }
}

async function waitForChildClose(
  childClosed: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const closed = childClosed.then(() => true as const);
  const result = await Promise.race([closed, timedOut]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

/**
 * Starts Codex app-server over its default JSONL stdio transport.
 *
 * Set CODEX_APP_SERVER_CMD to override the `codex` binary path. The child
 * inherits the ambient local Codex environment; this module never reads,
 * prompts for, or logs credentials.
 */
export function startAppServer(
  options: StartAppServerOptions = {},
): AppServerHandle {
  const command =
    options.command ?? process.env.CODEX_APP_SERVER_CMD ?? DEFAULT_COMMAND;
  const args = options.args ?? DEFAULT_ARGS;
  const ownsProcessGroup = process.platform !== 'win32';
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    // On POSIX this makes the app-server the leader of a dedicated process
    // group, so cancellation can also stop commands it started. Windows does
    // not support negative-PID process-group signalling and keeps the existing
    // direct-child behavior.
    detached: ownsProcessGroup,
    shell: false,
    // App Server and MCP diagnostics can contain task or tool data. Never copy
    // raw stderr into the gateway/LaunchAgent log.
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  return createHandle(child, ownsProcessGroup ? child.pid : undefined, options.bufferMessages !== false);
}

function createHandle(
  child: ChildProcessByStdio<Writable, Readable, null>,
  processGroupId: number | undefined,
  bufferMessages: boolean,
): AppServerHandle {
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const listeners = new Set<AppServerMessageListener>();
  const queuedMessages: AppServerMessage[] = [];
  const pendingMessages: PendingMessage[] = [];

  let terminalError: Error | undefined;
  let finished = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let processGroupCleanup: Promise<void> | undefined;
  let resolveTermination!: (termination: AppServerTermination) => void;
  const terminated = new Promise<AppServerTermination>((resolve) => {
    resolveTermination = resolve;
  });
  let resolveChildClosed: () => void;
  const childClosed = new Promise<void>((resolve) => {
    resolveChildClosed = resolve;
  });

  // A write callback receives EPIPE, but streams also emit `error`. Keeping an
  // error listener installed prevents a send/close race with child death from
  // becoming an uncaught process-level exception.
  child.stdin.on('error', () => undefined);

  const ensureProcessGroupCleanup = (): Promise<void> => {
    if (processGroupId === undefined) return Promise.resolve();
    processGroupCleanup ??= terminateProcessGroup(processGroupId);
    return processGroupCleanup;
  };

  const finish = (
    termination: AppServerTermination,
    error?: Error,
  ): void => {
    if (finished) {
      return;
    }
    finished = true;
    terminalError = error;
    resolveTermination(termination);
    lines.close();

    for (const pending of pendingMessages.splice(0)) {
      if (error !== undefined) {
        pending.reject(error);
      } else {
        pending.resolve({ value: undefined, done: true });
      }
    }
  };

  lines.on('line', (line) => {
    if (line.length === 0) {
      return;
    }

    let message: AppServerMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new TypeError('message must be a JSON object');
      }
      message = parsed as AppServerMessage;
    } catch (cause) {
      const error = new Error('Codex app-server emitted invalid JSONL', { cause });
      finish({ kind: 'error', error, expected: false }, error);
      return;
    }

    for (const listener of listeners) {
      listener(message);
    }

    const pending = pendingMessages.shift();
    if (pending !== undefined) {
      pending.resolve({ value: message, done: false });
    } else if (bufferMessages) {
      queuedMessages.push(message);
    }
  });

  child.once('error', (error) => {
    finish({ kind: 'error', error, expected: false }, error);
  });
  child.once('close', (code, signal) => {
    const termination: AppServerTermination = {
      kind: 'exit',
      code,
      signal,
      expected: closing,
    };
    if (closing || code === 0) {
      finish(termination);
    } else {
      const detail =
        signal === null ? `code ${String(code)}` : `signal ${signal}`;
      finish(termination, new Error(`Codex app-server exited with ${detail}`));
    }

    resolveChildClosed();
    if (!closing && processGroupId !== undefined) {
      // A crashing app-server can leave commands running in its group. Begin
      // cleanup immediately, before the operating system can recycle the
      // process-group id; a later close() awaits the same promise.
      void ensureProcessGroupCleanup().catch(() => undefined);
    }
  });

  const nextMessage = (): Promise<IteratorResult<AppServerMessage>> => {
    const queued = queuedMessages.shift();
    if (queued !== undefined) {
      return Promise.resolve({ value: queued, done: false });
    }
    if (terminalError !== undefined) {
      return Promise.reject(terminalError);
    }
    if (finished) {
      return Promise.resolve({ value: undefined, done: true });
    }

    return new Promise((resolve, reject) => {
      pendingMessages.push({ resolve, reject });
    });
  };

  const terminateProcessTree = async (): Promise<void> => {
    if (!child.stdin.destroyed) {
      child.stdin.end();
    }

    if (processGroupId !== undefined) {
      await ensureProcessGroupCleanup();
      await childClosed;
      return;
    }

    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const stopped = await waitForChildClose(childClosed, PROCESS_GROUP_GRACE_MS);
      if (!stopped && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    await childClosed;
  };

  return {
    terminated,
    processId: child.pid,

    async send(message) {
      if (closing || finished) {
        throw new Error('Codex app-server transport is closed');
      }

      const frame = `${JSON.stringify(message)}\n`;
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(frame, (error) => {
          if (error !== null && error !== undefined) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },

    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    [Symbol.asyncIterator]() {
      return { next: nextMessage };
    },

    async close() {
      if (closePromise === undefined) {
        closing = true;
        closePromise = terminateProcessTree();
      }
      await closePromise;
    },
  };
}
