import { err, ok, type Result } from '@codex-lens/shared';

import type { AppServerHandle, AppServerMessage } from './transport.js';

/**
 * Distinct code for "Codex has no usable authentication". Callers surface this
 * to the operator (who must run `codex login`) rather than retrying it.
 */
export const CODEX_AUTH_UNAVAILABLE = 'CODEX_AUTH_UNAVAILABLE';

const DEFAULT_TIMEOUT_MS = 30_000;
const CLIENT_NAME = '@codex-lens/gateway';
const CLIENT_VERSION = '0.0.0';

/** Readiness is established before model dispatch, not inferred from config. */
export async function verifyMcpServers(
  transport: AppServerHandle,
  required: readonly string[],
  options: CodexClientOptions = {},
): Promise<Result<void>> {
  if (required.length === 0) return ok(undefined);
  const response = await request(transport, 'mcpServerStatus/list', { limit: 100 },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!response.ok) return response;
  const servers = response.value.data;
  if (!Array.isArray(servers)) {
    return err('CODEX_PROTOCOL_ERROR', 'Codex returned an invalid MCP readiness response.');
  }
  const ready = new Set(servers.filter((server) => isRecord(server)
    && typeof server.name === 'string' && isRecord(server.tools)
    && Object.keys(server.tools).length > 0).map((server) => server.name as string));
  if (required.some((name) => !ready.has(name))) {
    return err('ASSISTANT_TASK_TOOLS_UNAVAILABLE',
      'The configured computer-control service did not expose its tools. No task was dispatched.');
  }
  return ok(undefined);
}

export interface CodexClientOptions {
  /** Wall-clock budget for a single request. Defaults to 30 seconds. */
  timeoutMs?: number;
}

export interface CodexInitializeOptions extends CodexClientOptions {
  clientInfo?: { name: string; version: string };
}

export interface CodexCreateThreadOptions extends CodexClientOptions {
  /** Working directory the thread's turns run in. */
  cwd?: string;
  model?: string;
  /** Invariant host-owned safety lease, separate from the task user prompt. */
  developerInstructions?: string;
}

export interface CodexInitializeResult {
  /** Agent string the app-server reports, when it sends one. */
  userAgent?: string;
  /** Auth method Codex reports as active, e.g. `chatgpt` or `apikey`. */
  authMethod?: string;
}

export interface CodexThread {
  threadId: string;
}

/**
 * Error codes Codex uses for "there are no credentials". Matched
 * case-insensitively; numeric codes are compared as-is.
 */
const AUTH_ERROR_CODES = new Set<string | number>([
  'auth_required',
  'auth_unavailable',
  'not_logged_in',
  'unauthenticated',
  401,
]);

/**
 * Codex reports missing auth as free text on some paths, so the code check is
 * backed by a message probe. Deliberately narrow: a false positive here would
 * mislabel an unrelated failure as an auth problem.
 */
const AUTH_MESSAGE_PATTERN =
  /\bnot (?:logged in|authenticated|signed in)\b|\bauth(?:entication)? (?:is )?(?:required|unavailable|missing|expired)\b|\blogin required\b|\bmissing credentials\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let lastRequestId = 0;

function allocateRequestId(): number {
  lastRequestId += 1;
  return lastRequestId;
}

export function isAuthUnavailable(code: unknown, message: string): boolean {
  const normalized = typeof code === 'string' ? code.toLowerCase() : code;
  if (
    (typeof normalized === 'string' || typeof normalized === 'number') &&
    AUTH_ERROR_CODES.has(normalized)
  ) {
    return true;
  }
  return AUTH_MESSAGE_PATTERN.test(message);
}

function toResult(
  method: string,
  message: AppServerMessage,
): Result<Record<string, unknown>> {
  const failure = message.error;
  if (isRecord(failure)) {
    const detail =
      typeof failure.message === 'string' && failure.message.length > 0
        ? failure.message
        : `Codex app-server rejected "${method}"`;
    if (isAuthUnavailable(failure.code, detail)) {
      return err(
        CODEX_AUTH_UNAVAILABLE,
        `Codex authentication is unavailable: ${detail}`,
      );
    }
    return err(
      'CODEX_REQUEST_FAILED',
      `Codex app-server rejected "${method}": ${detail}`,
    );
  }

  const result = message.result;
  if (!isRecord(result)) {
    return err(
      'CODEX_PROTOCOL_ERROR',
      `Codex app-server answered "${method}" without a result object`,
    );
  }
  return ok(result);
}

/**
 * Sends one JSON-RPC request and resolves with its answer. Unrelated traffic
 * (notifications, other requests' responses) is ignored by matching on the
 * request id, and every failure mode — rejection, malformed answer, dead
 * transport, silence — comes back as a Failed Result rather than a throw.
 */
export function request(
  transport: AppServerHandle,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<Result<Record<string, unknown>>> {
  const id = allocateRequestId();

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    let unsubscribe = (): void => {};
    const settle = (result: Result<Record<string, unknown>>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };

    // Subscribe before allocating a timeout. A failed registration must not
    // leave a timer behind referencing an uninitialized cleanup function.
    unsubscribe = transport.onMessage((message) => {
      if (message.id !== id) return;
      settle(toResult(method, message));
    });
    if (settled) { unsubscribe(); return; }

    timer = setTimeout(() => {
      settle(
        err(
          'CODEX_REQUEST_TIMED_OUT',
          `Codex app-server did not answer "${method}" within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    timer.unref();

    transport
      .send({ jsonrpc: '2.0', id, method, params })
      .catch((error: unknown) => {
        settle(
          err(
            'CODEX_TRANSPORT_FAILED',
            `Could not send "${method}" to Codex app-server: ${errorMessage(error)}`,
          ),
        );
      });
  });
}

/**
 * Reads the auth report from a `getAuthStatus` result, which answers with
 * `{ authMethod, authToken, requiresOpenaiAuth }`.
 *
 * A missing `authMethod` means nobody has logged in. That is only a failure
 * when the configured provider actually wants OpenAI credentials — a provider
 * that sets `requiresOpenaiAuth: false` (a local or self-hosted model) is
 * usable with no login at all.
 */
function readAuthMethod(
  result: Record<string, unknown>,
): Result<string | undefined> {
  const authMethod = result.authMethod;
  if (typeof authMethod === 'string' && authMethod.length > 0) {
    return ok(authMethod);
  }

  if (result.requiresOpenaiAuth === false) {
    return ok(undefined);
  }

  return err(
    CODEX_AUTH_UNAVAILABLE,
    'Codex authentication is unavailable: no auth method is active. Run `codex login`.',
  );
}

/**
 * Performs the app-server handshake and confirms Codex is authenticated.
 *
 * The handshake itself says nothing about auth: a Codex home with no
 * credentials still answers `initialize` with a normal result, and only
 * `getAuthStatus` reports `authMethod: null`. So auth is queried explicitly
 * rather than inferred from the handshake, which would read as success.
 *
 * Returns the `CODEX_AUTH_UNAVAILABLE` Failed Result when Codex has no usable
 * credentials. Callers must not treat that as a transient error: the operator
 * has to run `codex login`.
 */
export async function initialize(
  transport: AppServerHandle,
  options: CodexInitializeOptions = {},
): Promise<Result<CodexInitializeResult>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const response = await request(
    transport,
    'initialize',
    {
      clientInfo: options.clientInfo ?? {
        name: CLIENT_NAME,
        version: CLIENT_VERSION,
      },
    },
    timeoutMs,
  );
  if (!response.ok) {
    return response;
  }

  // The app-server only accepts further calls once the handshake is
  // acknowledged. Nothing answers this notification, so the send itself is the
  // only place a failure can be observed.
  try {
    await transport.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  } catch (error) {
    return err(
      'CODEX_TRANSPORT_FAILED',
      `Could not acknowledge the Codex handshake: ${errorMessage(error)}`,
    );
  }

  const status = await request(transport, 'getAuthStatus', {}, timeoutMs);
  if (!status.ok) {
    return status;
  }

  const authMethod = readAuthMethod(status.value);
  if (!authMethod.ok) {
    return authMethod;
  }

  const userAgent = response.value.userAgent;
  return ok({
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
    ...(authMethod.value === undefined ? {} : { authMethod: authMethod.value }),
  });
}

/**
 * Both `thread/start` and `thread/resume` answer with the thread object nested
 * under `result.thread`, carrying its id as `thread.id` — there is no
 * top-level `threadId` on the response.
 */
function readThread(
  method: string,
  result: Record<string, unknown>,
): Result<CodexThread> {
  const thread = result.thread;
  const threadId = isRecord(thread) ? thread.id : undefined;
  if (typeof threadId !== 'string' || threadId.length === 0) {
    return err(
      'CODEX_PROTOCOL_ERROR',
      `Codex app-server answered "${method}" without a thread id`,
    );
  }
  return ok({ threadId });
}

/** Starts a new Codex thread and returns its id. */
export async function createThread(
  transport: AppServerHandle,
  options: CodexCreateThreadOptions = {},
): Promise<Result<CodexThread>> {
  const response = await request(
    transport,
    'thread/start',
    {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.developerInstructions === undefined
        ? {}
        : { developerInstructions: options.developerInstructions }),
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) {
    return response;
  }
  return readThread('thread/start', response.value);
}

/** Re-attaches to an existing Codex thread by id. */
export async function resumeThread(
  transport: AppServerHandle,
  threadId: string,
  options: CodexClientOptions = {},
): Promise<Result<CodexThread>> {
  if (threadId.length === 0) {
    return err('INVALID_THREAD_ID', 'Thread id must not be empty');
  }

  const response = await request(
    transport,
    'thread/resume',
    { threadId },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) {
    return response;
  }
  return readThread('thread/resume', response.value);
}
