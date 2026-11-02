import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_AUTH_UNAVAILABLE,
  createThread,
  initialize,
  request,
  resumeThread,
  verifyMcpServers,
} from '../src/codex/client.js';
import type {
  AppServerHandle,
  AppServerMessage,
} from '../src/codex/transport.js';

type Script = Record<
  string,
  (request: AppServerMessage) => AppServerMessage | undefined
>;

describe('MCP readiness before dispatch', () => {
  it('does not leave a timeout behind when transport subscription throws', async () => {
    vi.useFakeTimers();
    try {
      const transport = createFakeTransport({});
      transport.onMessage = () => { throw new Error('subscription unavailable'); };
      await expect(request(transport, 'initialize', {}, 100)).rejects.toThrow('subscription unavailable');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(transport.sent).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
  it('does not probe when no service is required', async () => {
    const transport = createFakeTransport({});
    expect(await verifyMcpServers(transport, [])).toEqual({ ok: true, value: undefined });
    expect(transport.sent).toHaveLength(0);
  });

  it.each([
    [{ data: [{ name: 'computer_use', tools: { type_text: {} } }] }, true],
    [{ data: [{ name: 'computer_use', tools: {} }] }, false],
    [{ data: [{ name: 'other', tools: { type_text: {} } }] }, false],
    [{ data: [] }, false],
    [{ data: null }, false],
  ])('validates actual nonempty native tool inventory %#', async (result, expected) => {
    const transport = createFakeTransport({
      'mcpServerStatus/list': (message) => ({ id: message.id, result }),
    });
    expect((await verifyMcpServers(transport, ['computer_use'])).ok).toBe(expected);
  });

  it('bounds an unresponsive readiness check', async () => {
    const transport = createFakeTransport({});
    const result = await verifyMcpServers(transport, ['computer_use'], { timeoutMs: 5 });
    expect(result.ok).toBe(false);
  });
});

interface FakeTransport extends AppServerHandle {
  /** Every frame the client wrote, in order. */
  sent: AppServerMessage[];
  /** Pushes an unsolicited frame at the client, as the real server may. */
  emit(message: AppServerMessage): void;
}

/**
 * A transport whose canned answers are keyed by method. A script entry may
 * return `undefined` to model a server that never answers.
 */
function createFakeTransport(
  script: Script,
  options: { sendError?: Error } = {},
): FakeTransport {
  const listeners = new Set<(message: AppServerMessage) => void>();
  const sent: AppServerMessage[] = [];

  const emit = (message: AppServerMessage): void => {
    for (const listener of [...listeners]) {
      listener(message);
    }
  };

  return {
    sent,
    emit,

    async send(message) {
      if (options.sendError !== undefined) {
        throw options.sendError;
      }
      sent.push(message);

      const reply = script[String(message.method)]?.(message);
      if (reply !== undefined) {
        // Answers arrive on a later tick, as they would over a real pipe.
        queueMicrotask(() => emit(reply));
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
      listeners.clear();
    },
  };
}

const THREAD_ID = '019f63c2-8b22-7613-89ce-023b27e0be00';

/**
 * The canned frames below mirror what a real `codex app-server` 0.144 answers,
 * trimmed to the fields this client reads. Note that `initialize` carries no
 * auth information at all — that only comes back from `getAuthStatus`.
 */
const okInit = (request: AppServerMessage): AppServerMessage => ({
  jsonrpc: '2.0',
  id: request.id,
  result: {
    userAgent: 'codex/0.144.2 (app-server)',
    codexHome: '/home/dev/.codex',
    platformOs: 'macos',
  },
});

const okAuthStatus = (request: AppServerMessage): AppServerMessage => ({
  jsonrpc: '2.0',
  id: request.id,
  result: { authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: true },
});

/** A Codex home nobody has logged into: initialize succeeds, auth is absent. */
const loggedOutAuthStatus = (request: AppServerMessage): AppServerMessage => ({
  jsonrpc: '2.0',
  id: request.id,
  result: { authMethod: null, authToken: null, requiresOpenaiAuth: true },
});

const thread = (id: string): Record<string, unknown> => ({
  id,
  sessionId: id,
  status: { type: 'idle' },
  turns: [],
});

const okStart = (request: AppServerMessage): AppServerMessage => ({
  jsonrpc: '2.0',
  id: request.id,
  result: { thread: thread(THREAD_ID), model: 'gpt-5.6-sol', cwd: '/repo' },
});

const okResume = (request: AppServerMessage): AppServerMessage => ({
  jsonrpc: '2.0',
  id: request.id,
  result: {
    thread: thread(String((request.params as { threadId?: unknown }).threadId)),
    model: 'gpt-5.6-sol',
    initialTurnsPage: { items: [] },
  },
});

const authError = (request: AppServerMessage): AppServerMessage => ({
  jsonrpc: '2.0',
  id: request.id,
  error: {
    code: 'auth_required',
    message: 'No Codex credentials found; run `codex login`',
  },
});

describe('initialize', () => {
  it('handshakes and reports the active auth method', async () => {
    const transport = createFakeTransport({
      initialize: okInit,
      getAuthStatus: okAuthStatus,
    });

    const result = await initialize(transport);

    expect(result).toEqual({
      ok: true,
      value: { userAgent: 'codex/0.144.2 (app-server)', authMethod: 'chatgpt' },
    });
    expect(transport.sent[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { clientInfo: { name: '@codex-lens/gateway' } },
    });
    expect(transport.sent[0]?.id).toEqual(expect.any(Number));
  });

  it('acknowledges the handshake, then asks for auth status', async () => {
    const transport = createFakeTransport({
      initialize: okInit,
      getAuthStatus: okAuthStatus,
    });

    await initialize(transport);

    expect(transport.sent.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'getAuthStatus',
    ]);
    expect(transport.sent[1]).toEqual({
      jsonrpc: '2.0',
      method: 'initialized',
      params: {},
    });
  });

  it('fails with the auth code when the app-server reports no credentials', async () => {
    const transport = createFakeTransport({ initialize: authError });

    const result = await initialize(transport);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: {
        code: CODEX_AUTH_UNAVAILABLE,
        message: expect.stringContaining('codex login'),
      },
    });
    // A rejected handshake is never acknowledged.
    expect(transport.sent).toHaveLength(1);
  });

  it('fails with the auth code when a clean Codex home reports no auth method', async () => {
    // The real trap: initialize succeeds and says nothing about auth, so only
    // the explicit status query can tell nobody has logged in.
    const transport = createFakeTransport({
      initialize: okInit,
      getAuthStatus: loggedOutAuthStatus,
    });

    const result = await initialize(transport);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: CODEX_AUTH_UNAVAILABLE,
        message: expect.stringContaining('codex login'),
      },
    });
  });

  it('fails with the auth code when auth status omits the auth method entirely', async () => {
    const transport = createFakeTransport({
      initialize: okInit,
      getAuthStatus: (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        result: { requiresOpenaiAuth: true },
      }),
    });

    const result = await initialize(transport);

    expect(result).toMatchObject({
      ok: false,
      error: { code: CODEX_AUTH_UNAVAILABLE },
    });
  });

  it('succeeds without a login when the provider needs no OpenAI auth', async () => {
    const transport = createFakeTransport({
      initialize: okInit,
      getAuthStatus: (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        result: { authMethod: null, requiresOpenaiAuth: false },
      }),
    });

    const result = await initialize(transport);

    expect(result).toEqual({
      ok: true,
      value: { userAgent: 'codex/0.144.2 (app-server)' },
    });
  });

  it('fails with the auth code when the status query is rejected for auth', async () => {
    const transport = createFakeTransport({
      initialize: okInit,
      getAuthStatus: authError,
    });

    const result = await initialize(transport);

    expect(result).toMatchObject({
      ok: false,
      error: { code: CODEX_AUTH_UNAVAILABLE },
    });
  });

  it('recognizes an auth failure stated only in the error message', async () => {
    const transport = createFakeTransport({
      initialize: (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: 'You are not logged in to Codex' },
      }),
    });

    const result = await initialize(transport);

    expect(result).toMatchObject({
      ok: false,
      error: { code: CODEX_AUTH_UNAVAILABLE },
    });
  });

  it('reports an unrelated rejection under its own code', async () => {
    const transport = createFakeTransport({
      initialize: (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Method not found' },
      }),
    });

    const result = await initialize(transport);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'CODEX_REQUEST_FAILED',
        message: expect.stringContaining('Method not found'),
      },
    });
  });
});

describe('createThread', () => {
  it('starts a thread and returns the id nested under result.thread', async () => {
    const transport = createFakeTransport({ 'thread/start': okStart });

    const result = await createThread(transport);

    expect(result).toEqual({ ok: true, value: { threadId: THREAD_ID } });
    expect(transport.sent[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'thread/start',
      params: {},
    });
  });

  it('passes cwd and model through when given', async () => {
    const transport = createFakeTransport({ 'thread/start': okStart });

    await createThread(transport, { cwd: '/repo', model: 'gpt-5-codex' });

    expect(transport.sent[0]?.params).toEqual({
      cwd: '/repo',
      model: 'gpt-5-codex',
    });
  });

  it('fails with the auth code rather than fabricating a thread', async () => {
    const transport = createFakeTransport({ 'thread/start': authError });

    const result = await createThread(transport);

    expect(result).toMatchObject({
      ok: false,
      error: { code: CODEX_AUTH_UNAVAILABLE },
    });
  });

  it('rejects a response whose thread carries no id', async () => {
    const transport = createFakeTransport({
      'thread/start': (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        result: { thread: {} },
      }),
    });

    const result = await createThread(transport);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'CODEX_PROTOCOL_ERROR' },
    });
  });

  it('rejects a legacy flat threadId rather than reading past the thread object', async () => {
    const transport = createFakeTransport({
      'thread/start': (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        result: { threadId: THREAD_ID },
      }),
    });

    const result = await createThread(transport);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'CODEX_PROTOCOL_ERROR' },
    });
  });
});

describe('resumeThread', () => {
  it('resumes an existing thread by id', async () => {
    const transport = createFakeTransport({ 'thread/resume': okResume });

    const result = await resumeThread(transport, THREAD_ID);

    expect(result).toEqual({ ok: true, value: { threadId: THREAD_ID } });
    expect(transport.sent[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'thread/resume',
      params: { threadId: THREAD_ID },
    });
  });

  it('reports an unknown thread under its own code', async () => {
    const transport = createFakeTransport({
      'thread/resume': (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32600,
          message: `no rollout found for thread id ${THREAD_ID}`,
        },
      }),
    });

    const result = await resumeThread(transport, THREAD_ID);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'CODEX_REQUEST_FAILED',
        message: expect.stringContaining('no rollout found'),
      },
    });
  });

  it('fails with the auth code rather than fabricating a resume', async () => {
    const transport = createFakeTransport({ 'thread/resume': authError });

    const result = await resumeThread(transport, THREAD_ID);

    expect(result).toMatchObject({
      ok: false,
      error: { code: CODEX_AUTH_UNAVAILABLE },
    });
  });

  it('rejects an empty thread id without touching the transport', async () => {
    const transport = createFakeTransport({ 'thread/resume': okResume });

    const result = await resumeThread(transport, '');

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_THREAD_ID' },
    });
    expect(transport.sent).toHaveLength(0);
  });
});

describe('request handling', () => {
  it('ignores unrelated traffic while waiting for its own response', async () => {
    const transport = createFakeTransport({
      'thread/start': (request) => {
        queueMicrotask(() => {
          transport.emit({ jsonrpc: '2.0', method: 'codex/event', params: {} });
          transport.emit({
            jsonrpc: '2.0',
            id: 9999,
            result: { thread: thread('someone-elses-thread') },
          });
        });
        return okStart(request);
      },
    });

    const result = await createThread(transport);

    expect(result).toEqual({ ok: true, value: { threadId: THREAD_ID } });
  });

  it('uses a distinct request id per call', async () => {
    const transport = createFakeTransport({ 'thread/start': okStart });

    await createThread(transport);
    await createThread(transport);

    expect(transport.sent[0]?.id).not.toBe(transport.sent[1]?.id);
  });

  it('times out instead of hanging when the app-server never answers', async () => {
    const transport = createFakeTransport({ 'thread/start': () => undefined });

    const result = await createThread(transport, { timeoutMs: 10 });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'CODEX_REQUEST_TIMED_OUT' },
    });
  });

  it('returns a Failed Result when the transport cannot send', async () => {
    const transport = createFakeTransport(
      { 'thread/start': okStart },
      { sendError: new Error('Codex app-server transport is closed') },
    );

    const result = await createThread(transport);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'CODEX_TRANSPORT_FAILED',
        message: expect.stringContaining('transport is closed'),
      },
    });
  });
});
