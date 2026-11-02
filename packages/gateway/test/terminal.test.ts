import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/schema.js';
import { TerminalService } from '../src/terminal/service.js';
import type { AppServerHandle, AppServerMessage } from '../src/codex/transport.js';
import { buildServer } from '../src/server.js';
import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });

function fixture(options: { resumeError?: string; resumeErrorCode?: number; startError?: string;
  beforeTurnResponse?: (emit: (method: string, params: Record<string, unknown>) => void, threadId: string, turnId: string) => void } = {}) {
  const db = openDb(':memory:');
  const listeners = new Set<(message: AppServerMessage) => void>();
  const messages: AppServerMessage[] = [];
  let thread = 0, turn = 0;
  const emit = (method: string, params: Record<string, unknown>) => {
    for (const listener of listeners) listener({ method, params });
  };
  const transport: AppServerHandle = {
    send: vi.fn(async (message) => {
      messages.push(message);
      if (!('id' in message)) return;
      const failure = message.method === 'thread/resume' ? options.resumeError
        : message.method === 'thread/start' ? options.startError : undefined;
      if (failure !== undefined) {
        for (const listener of listeners) listener({
          id: message.id, error: {
            code: message.method === 'thread/resume' ? options.resumeErrorCode ?? -32000 : -32000,
            message: failure,
          },
        });
        return;
      }
      let result: Record<string, unknown> = {};
      if (message.method === 'getAuthStatus') result = { authMethod: 'chatgpt' };
      if (message.method === 'thread/start') result = { thread: { id: 'thread-' + ++thread } };
      if (message.method === 'thread/resume') result = { thread: { id: (message.params as {threadId: string}).threadId } };
      if (message.method === 'turn/start') {
        const params = message.params as {threadId: string};
        result = { turn: { id: 'turn-' + ++turn } };
        emit('turn/started', { threadId: params.threadId, turn: result.turn });
        options.beforeTurnResponse?.(emit, params.threadId, 'turn-' + turn);
      }
      for (const listener of listeners) listener({ id: message.id, result });
    }),
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() { /* listeners own this stream */ },
  };
  const service = new TerminalService({ db, runtimeFactory: () => ({ codexHome: '/test', env: {}, cleanup() {} }), transportFactory: () => transport });
  service.activate();
  cleanup.push(async () => { await service.close(); db.close(); });
  return { db, service, transport, messages, emit };
}

describe('persistent Prism Terminal', () => {
  it('supports an account-selected model without requiring an OpenAI API key', async () => {
    vi.stubEnv('CODEX_LENS_TERMINAL_MODEL', ' account-supported-model ');
    vi.stubEnv('OPENAI_API_KEY', undefined);
    const f = fixture(), id = randomUUID();
    expect((await f.service.connect(id)).model).toBe('account-supported-model');
    await f.service.send(id, randomUUID(), 'A test request');
    expect(f.messages.find(message => message.method === 'thread/start')?.params)
      .toMatchObject({ model: 'account-supported-model' });
    expect(f.messages.find(message => message.method === 'turn/start')?.params)
      .toMatchObject({ model: 'account-supported-model', effort: 'medium' });
  });
  it('preserves the accepted default when the model override is empty', async () => {
    vi.stubEnv('CODEX_LENS_TERMINAL_MODEL', ' ');
    const f = fixture();
    expect((await f.service.connect(randomUUID())).model).toBe('gpt-5.6-sol');
  });
  it('binds a final reply to its request, excludes commentary, and durably replays it exactly once', async () => {
    const f = fixture(), id = randomUUID(), requestId = randomUUID();
    await f.service.connect(id);
    await f.service.send(id, requestId, 'Answer once');
    const cursor = f.service.store.events(id, 0).at(-1)!.sequence;
    f.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'I will check.' } });
    f.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer', delta: 'partial' });
    expect(f.service.store.events(id, cursor).filter((event) => event.kind === 'reply')).toEqual([]);
    f.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'The verified final answer.' } });
    f.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'late', type: 'agentMessage', phase: 'commentary', text: 'Not the final answer.' } });
    f.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
    f.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
    await f.service.send(id, requestId, 'Answer once');
    const replies = f.service.store.events(id, cursor).filter((event) => event.kind === 'reply');
    expect(replies).toEqual([expect.objectContaining({ kind: 'reply', itemId: requestId, status: 'completed', text: 'The verified final answer.' })]);
    expect(f.service.store.events(id, cursor).filter((event) => event.kind === 'reply')).toEqual(replies);
    expect(f.messages.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    await f.service.close();
    const restarted = new TerminalService({ db: f.db });
    restarted.activate();
    expect(restarted.store.events(id, cursor).filter((event) => event.kind === 'reply')).toEqual(replies);
    await restarted.close();
  });
  it('never completes a new request from an older, missing-ID or wrong-thread notification', async () => {
    const f = fixture(), id = randomUUID(), first = randomUUID(), second = randomUUID();
    await f.service.connect(id);
    await f.service.send(id, first, 'First');
    f.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [{ id: 'old', type: 'agentMessage', phase: 'final_answer', text: 'Old reply' }] } });
    await f.service.send(id, second, 'Second');
    for (const params of [
      { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      { threadId: 'thread-1', turn: { status: 'completed' } },
      { threadId: 'unknown-thread', turn: { id: 'turn-2', status: 'completed' } },
    ]) f.emit('turn/completed', params);
    f.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'Stale answer' } });
    expect(f.service.get(id).state).toBe('running');
    expect(f.service.store.events(id, 0).filter((event) => event.kind === 'reply')).toHaveLength(1);
    f.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', items: [
      { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'Working' },
      { id: 'new', type: 'agentMessage', phase: 'final_answer', text: 'New reply' },
    ] } });
    expect(f.service.store.events(id, 0).filter((event) => event.kind === 'reply')).toEqual([
      expect.objectContaining({ itemId: first, text: 'Old reply' }), expect.objectContaining({ itemId: second, text: 'New reply' }),
    ]);
  });
  it('buffers a fast completion until turn/start confirms request ownership', async () => {
    const f = fixture({ beforeTurnResponse: (emit, threadId, turnId) => {
      emit('turn/completed', { threadId, turn: { id: 'stale-turn', status: 'completed' } });
      emit('item/completed', { threadId, turnId, item: { type: 'agentMessage', phase: 'final_answer', text: 'Fast final' } });
      emit('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
    } });
    const id = randomUUID(), requestId = randomUUID();
    await f.service.connect(id);
    expect((await f.service.send(id, requestId, 'Quick answer')).state).toBe('ready');
    expect(f.service.store.events(id, 0).filter((event) => event.kind === 'reply')).toEqual([
      expect.objectContaining({ itemId: requestId, text: 'Fast final', status: 'completed' }),
    ]);
  });
  it.each(['failed', 'interrupted'] as const)('emits a request-owned %s outcome without speaking partial text', async (status) => {
    const f = fixture(), id = randomUUID(), requestId = randomUUID();
    await f.service.connect(id); await f.service.send(id, requestId, 'Work');
    f.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'Partial result' } });
    f.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status } });
    expect(f.service.store.events(id, 0).filter((event) => event.kind === 'reply')).toEqual([
      expect.objectContaining({ itemId: requestId, text: '', status }),
    ]);
  });
  it('does not turn a commentary-only completion into a spoken reply', async () => {
    const f = fixture(), id = randomUUID(), requestId = randomUUID();
    await f.service.connect(id); await f.service.send(id, requestId, 'Work');
    f.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'commentary', text: 'Checking now' } });
    f.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
    expect(f.service.store.events(id, 0).find((event) => event.kind === 'reply')).toMatchObject({ itemId: requestId, text: '' });
  });
  function savedEmptyThread(f: ReturnType<typeof fixture>) {
    const id = randomUUID();
    f.service.store.save({ id, threadId: 'missing-thread', title: 'New session', model: 'gpt-5.6-sol',
      state: 'disconnected', turnId: null, updatedAt: new Date().toISOString() });
    return id;
  }
  it('refreshes the same trusted policy for an existing thread without recreating it or dispatching a turn', async () => {
    const f = fixture(), fresh = randomUUID();
    await f.service.connect(fresh);
    const start = f.messages.find((message) => message.method === 'thread/start')!.params as Record<string, unknown>;
    const existing = savedEmptyThread(f);
    const resumed = await f.service.connect(existing);
    const resume = f.messages.find((message) => message.method === 'thread/resume')!.params as Record<string, unknown>;
    expect(typeof start.developerInstructions).toBe('string');
    expect(resume).toEqual({ threadId: 'missing-thread', excludeTurns: true, developerInstructions: start.developerInstructions });
    expect(resumed.threadId).toBe('missing-thread');
    expect(f.messages.filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(f.messages.filter((message) => message.method === 'turn/start')).toHaveLength(0);
  });
  it('preserves ordinary chat and command text without unsupported per-turn instruction overrides', async () => {
    const f = fixture(), id = randomUUID();
    await f.service.connect(id);
    for (const [index, text] of ['Suggest a friendly way to say good job.', 'What does "type good job" mean?', 'type good job', 'search Google for vintage cameras'].entries()) {
      await f.service.send(id, randomUUID(), text);
      const start = f.messages.filter((message) => message.method === 'turn/start').at(-1)!.params as Record<string, unknown>;
      expect(start.input).toEqual([{ type: 'text', text }]);
      expect(start).not.toHaveProperty('developerInstructions');
      f.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-' + (index + 1), status: 'completed' } });
    }
  });
  it('replaces a missing unused rollout without changing the phone session or replaying a command', async () => {
    const f = fixture({ resumeError: 'no rollout found for thread missing-thread' });
    const id = savedEmptyThread(f);
    const session = await f.service.connect(id);
    expect(session).toMatchObject({ id, threadId: 'thread-1', state: 'ready', title: 'New session' });
    expect(f.messages.filter((m) => m.method === 'thread/resume')).toHaveLength(1);
    expect(f.messages.filter((m) => m.method === 'thread/start')).toHaveLength(1);
    expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(0);
    await f.service.connect(id);
    expect(f.messages.filter((m) => m.method === 'thread/start')).toHaveLength(1);
    await f.service.send(id, randomUUID(), 'A new explicit command');
    expect(f.messages.find((m) => m.method === 'turn/start')?.params).toMatchObject({ threadId: 'thread-1' });
  });
  it('preserves a missing used thread when only its durable request receipt survives', async () => {
    const f = fixture({ resumeError: 'no rollout found for thread missing-thread' });
    const id = savedEmptyThread(f), requestId = randomUUID();
    f.service.store.claim(requestId, id, 'durable-receipt');
    await expect(f.service.connect(id)).rejects.toThrow('no rollout found');
    expect(f.service.get(id).threadId).toBe('missing-thread');
    expect(f.service.store.request(requestId)).toMatchObject({ sessionId: id, digest: 'durable-receipt' });
    expect(f.messages.filter((m) => m.method === 'thread/start')).toHaveLength(0);
    expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(0);
  });
  it.each(['input', 'assistant', 'tool'] as const)('preserves a missing thread with durable %s history beyond the first event page', async (kind) => {
    const f = fixture({ resumeError: 'no rollout found for thread missing-thread' });
    const id = savedEmptyThread(f);
    for (let index = 0; index < 300; index += 1) f.service.store.append(id, { kind: 'state', itemId: 'state', status: 'disconnected' });
    f.service.store.append(id, { kind, itemId: 'evidence', text: 'Retained history' });
    await expect(f.service.connect(id)).rejects.toThrow('no rollout found');
    expect(f.service.get(id).threadId).toBe('missing-thread');
    expect(f.messages.filter((m) => m.method === 'thread/start')).toHaveLength(0);
  });
  it.each(['permission denied', 'thread storage is temporarily unavailable'])('does not replace an unused thread after an unrelated resume error: %s', async (resumeError) => {
    const f = fixture({ resumeError }), id = savedEmptyThread(f);
    await expect(f.service.connect(id)).rejects.toThrow(resumeError);
    expect(f.service.get(id).threadId).toBe('missing-thread');
    expect(f.messages.filter((m) => m.method === 'thread/start')).toHaveLength(0);
  });
  it('does not treat an authentication failure as a missing unused rollout', async () => {
    const f = fixture({ resumeError: 'no rollout found for thread missing-thread', resumeErrorCode: 401 });
    const id = savedEmptyThread(f);
    await expect(f.service.connect(id)).rejects.toThrow('authentication');
    expect(f.service.get(id).threadId).toBe('missing-thread');
    expect(f.messages.filter((m) => m.method === 'thread/start')).toHaveLength(0);
  });
  it('preserves the original mapping if replacing an empty rollout fails', async () => {
    const f = fixture({ resumeError: 'no rollout found for thread missing-thread', startError: 'Cannot create a thread now' });
    const id = savedEmptyThread(f);
    await expect(f.service.connect(id)).rejects.toThrow('Cannot create a thread now');
    expect(f.service.get(id).threadId).toBe('missing-thread');
    expect(f.messages.filter((m) => m.method === 'thread/start')).toHaveLength(1);
    expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(0);
  });

  it('reuses one thread across follow-ups and never replays an accepted request', async () => {
    const f = fixture(), id = randomUUID(), requestId = randomUUID();
    await f.service.connect(id);
    await f.service.send(id, requestId, 'Remember amber.');
    await f.service.send(id, requestId, 'Remember amber.');
    f.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
    await f.service.send(id, randomUUID(), 'What word?');
    expect(f.messages.filter((m) => m.method === 'thread/start')).toHaveLength(1);
    const starts = f.messages.filter((m) => m.method === 'turn/start');
    expect(starts).toHaveLength(2);
    expect(starts.map((m) => (m.params as {threadId: string}).threadId)).toEqual(['thread-1','thread-1']);
    await expect(f.service.send(id, requestId, 'Different command')).rejects.toThrow('different content');
  });
  it('holds the Mac lease until the interruption is confirmed', async () => {
    const f = fixture(), a = randomUUID(), b = randomUUID();
    await f.service.connect(a); await f.service.connect(b);
    await f.service.send(a, randomUUID(), 'First');
    await expect(f.service.send(b, randomUUID(), 'Second')).rejects.toThrow('already working');
    await f.service.interrupt(a);
    expect(f.service.get(a).state).toBe('stopping');
    await expect(f.service.send(b, randomUUID(), 'Second')).rejects.toThrow('already working');
    f.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } });
    await f.service.send(b, randomUUID(), 'Second');
    expect(f.service.get(b).state).toBe('running');
  });
  it('streams final text, tool output and images without forwarding hidden reasoning', async () => {
    const f = fixture(), id = randomUUID();
    await f.service.connect(id);
    await f.service.send(id, randomUUID(), 'Describe', [{ label: 'Glasses', jpegBase64: '/9j/2Q==' }]);
    const turn = f.messages.find((m) => m.method === 'turn/start');
    expect(JSON.stringify(turn)).toContain('data:image/jpeg;base64,/9j/2Q==');
    f.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer', delta: 'Hi' });
    f.emit('item/reasoning/textDelta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'private', delta: 'hidden-reasoning' });
    f.emit('item/commandExecution/outputDelta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd', delta: 'result' });
    f.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'answer', type: 'agentMessage', text: 'Hi there' } });
    const events = f.service.store.events(id, 0);
    expect(JSON.stringify(events)).not.toContain('hidden-reasoning');
    expect(events.at(-1)).toMatchObject({ text: 'Hi there', operation: 'replace' });
    expect(f.service.store.events(id, events[2]!.sequence)).toEqual(events.slice(3));
    expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
  });
  it('requires review after a restart and resumes history without resending the interrupted command', async () => {
    const f = fixture(), id = randomUUID();
    await f.service.connect(id); await f.service.send(id, randomUUID(), 'Open an app');
    await f.service.close();
    const next = new TerminalService({ db: f.db, runtimeFactory: () => ({ codexHome: '/test', env: {}, cleanup() {} }), transportFactory: () => f.transport });
    next.activate();
    await expect(next.connect(randomUUID())).rejects.toThrow('interrupted session');
    await expect(next.connect(id)).rejects.toThrow('interrupted session');
    await next.connect(id, true);
    expect(f.messages.filter((m) => m.method === 'thread/resume')).toHaveLength(1);
    expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    await next.close();
  });
  it('publishes a restart state to foreground clients without replaying commands', async () => {
    const f = fixture(), id = randomUUID();
    await f.service.connect(id);
    await f.service.close();
    const cursor = f.service.store.events(id, 0).at(-1)!.sequence;
    const restarted = new TerminalService({ db: f.db });
    restarted.activate();
    expect(restarted.store.events(id, cursor)).toContainEqual(expect.objectContaining({ kind: 'state', status: 'disconnected' }));
    expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(0);
    await restarted.close();
  });
  it('does not mutate a live owner when an unactivated duplicate gateway closes', async () => {
    const f = fixture(), id = randomUUID();
    await f.service.connect(id); await f.service.send(id, randomUUID(), 'Work');
    const duplicate = new TerminalService({ db: f.db });
    await duplicate.close();
    expect(f.service.get(id).state).toBe('running');
  });
  it('reconnects an authenticated SSE stream from its cursor without dispatching another turn', async () => {
    vi.stubEnv(GATEWAY_TOKEN_ENV, 'terminal-test-token');
    const f = fixture(), server = buildServer({ db: f.db, terminalService: f.service });
    cleanup.push(async () => { await server.close(); });
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    const headers = { authorization: 'Bearer terminal-test-token' };
    const id = randomUUID();
    await f.service.connect(id);
    const first = new AbortController();
    const response = await fetch(base + '/v1/terminal/' + id + '/events', { headers, signal: first.signal });
    const initial = new TextDecoder().decode((await response.body!.getReader().read()).value);
    expect(initial).toContain('"status":"ready"');
    const cursor = f.service.store.events(id, 0).at(-1)!.sequence;
    first.abort();
    await f.service.send(id, randomUUID(), 'Only once');
    const second = new AbortController();
    const resumed = await fetch(base + '/v1/terminal/' + id + '/events?after=' + cursor, { headers, signal: AbortSignal.any([second.signal, AbortSignal.timeout(2000)]) });
    const reader = resumed.body!.getReader();
    let replay = '';
    while (!replay.includes('Only once')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      replay += new TextDecoder().decode(chunk.value);
    }
    expect(replay).toContain('Only once');
    expect(replay).not.toContain('"status":"ready"');
    expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    second.abort();
  });
  it('protects terminal routes and rejects extra dispatch fields and invalid images', async () => {
    vi.stubEnv(GATEWAY_TOKEN_ENV, 'terminal-test-token');
    const f = fixture(), server = buildServer({ db: f.db, terminalService: f.service });
    cleanup.push(async () => { await server.close(); });
    expect((await server.inject('/v1/terminal/sessions')).statusCode).toBe(401);
    const headers = { authorization: 'Bearer terminal-test-token' };
    const id = randomUUID();
    expect((await server.inject({ method: 'POST', url: '/v1/terminal/connect', headers, payload: { sessionId: id, cwd: '/' } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/v1/terminal/connect', headers, payload: { sessionId: id } })).statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url: '/v1/terminal/' + id + '/turns', headers, payload: { requestId: randomUUID(), text: 'See', images: [{ label: 'x', jpegBase64: 'abcd' }] } })).statusCode).toBe(400);
    expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(0);
  });
});
