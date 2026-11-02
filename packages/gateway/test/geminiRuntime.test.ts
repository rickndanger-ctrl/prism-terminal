import { describe, expect, it, vi } from 'vitest';
import { createGeminiRuntime } from '../src/realtime/geminiRuntime.js';
import type { createGeminiAttentiveSession } from '../src/realtime/geminiAttentiveSession.js';
import { randomUUID } from 'node:crypto';

describe('Gemini opt-in runtime', () => {
  it('relays only accepted phone-clock calls and returns their correlated result', async () => {
    let config!: Parameters<typeof createGeminiAttentiveSession>[0];
    const sendPhoneToolMessage = vi.fn();
    const runtime = createGeminiRuntime({ pythonExecutable: '/test/python', checkPython: async () => {}, loadKey: async () => 'test',
      createSession: options => { config = options; return { close: vi.fn(), decideResponse: () => true, sendPhoneToolMessage,
        answer: async () => { config.onEvent({ type: 'ready' }); return 'v=0 answer'; } }; },
    });
    await runtime.activate(); await runtime.pool.start('v=0 offer');
    const binding = config.connection.bindings!.get('get_current_time')!;
    await expect(binding.execute({}, new AbortController().signal)).rejects.toThrow('unavailable');
    const turnId = randomUUID(); config.onEvent({ type: 'activityStarted', turnId });
    config.onAttention!({ turnId, transcript: 'What time is it?', attention: 'addressed', elapsedMs: 1, model: 'test', usage: {} });
    const work = binding.execute({}, new AbortController().signal);
    const request = sendPhoneToolMessage.mock.calls[0]![0];
    config.onControl(JSON.stringify({ type: 'gemini.toolResult', requestId: request.requestId, turnId,
      output: { localDateTime: '12:30', timeZoneIdentifier: 'America/Los_Angeles' } }));
    await expect(work).resolves.toEqual({ localDateTime: '12:30', timeZoneIdentifier: 'America/Los_Angeles' });
    expect([...config.connection.bindings!.keys()]).toEqual(['get_current_time', 'get_assistant_task_status', 'prepare_assistant_task', 'research_web', 'reason_question']);
    const prepare = config.connection.bindings!.get('prepare_assistant_task')!;
    expect(prepare.arguments.safeParse({ scope: 'mac' }).success).toBe(true);
    expect(prepare.arguments.safeParse({ scope: 'project' }).success).toBe(true);
    expect(prepare.arguments.safeParse({ scope: 'all' }).success).toBe(false);
    expect(prepare.arguments.safeParse({ scope: 'mac', instruction: 'invented' }).success).toBe(false);
    const preparation = prepare.execute({ scope: 'mac' }, new AbortController().signal);
    const preparedRequest = sendPhoneToolMessage.mock.calls.at(-1)![0];
    expect(preparedRequest.transcript).toBe('What time is it?'); // Bound source is not model-authored text.
    expect(preparedRequest.arguments).toEqual({ scope: 'mac' });
    config.onControl(JSON.stringify({ type: 'gemini.toolResult', requestId: preparedRequest.requestId, turnId,
      output: { state: 'prepared', requiresExplicitConfirmation: true } }));
    await expect(preparation).resolves.toEqual({ state: 'prepared', requiresExplicitConfirmation: true });
    expect(config.connection.bindings!.has('start_prepared_assistant_task')).toBe(false);
    const taskStatus = config.connection.bindings!.get('get_assistant_task_status')!;
    expect(taskStatus.arguments.safeParse({ taskId: 'model-selected-job' }).success).toBe(false);
    expect(taskStatus.arguments.safeParse({}).success).toBe(true);
    const statusWork = taskStatus.execute({}, new AbortController().signal);
    const statusRequest = sendPhoneToolMessage.mock.calls.at(-1)![0];
    expect(statusRequest.name).toBe('get_assistant_task_status');
    expect(statusRequest.arguments).toEqual({});
    config.onControl(JSON.stringify({ type: 'gemini.toolResult', requestId: statusRequest.requestId, turnId,
      output: { state: 'running', summary: 'Still working' } }));
    await expect(statusWork).resolves.toEqual({ state: 'running', summary: 'Still working' });
    for (const name of ['research_web', 'reason_question']) {
      const informational = config.connection.bindings!.get(name)!;
      expect(informational.arguments.safeParse({ question: ' ' }).success).toBe(false);
      expect(informational.arguments.safeParse({ question: 'x'.repeat(1001) }).success).toBe(false);
      expect(informational.arguments.safeParse({ question: 'Test question', command: 'run' }).success).toBe(false);
      const question = 'What is seven times eight?';
      const answer = informational.execute({ question }, new AbortController().signal);
      const sent = sendPhoneToolMessage.mock.calls.at(-1)![0];
      expect(sent.name).toBe(name); expect(sent.arguments).toEqual({ question });
      config.onControl(JSON.stringify({ type: 'gemini.toolResult', requestId: sent.requestId, turnId,
        output: { answer: '56', sources: [] } }));
      await expect(answer).resolves.toEqual({ answer: '56', sources: [] });
    }
    const pending = binding.execute({}, new AbortController().signal);
    const stopped = expect(pending).rejects.toThrow();
    runtime.close();
    await stopped;
    await expect(binding.execute({}, new AbortController().signal)).rejects.toThrow('unavailable');
  });
  it('does not access Keychain or advertise readiness until activation succeeds', async () => {
    const loadKey = vi.fn(async () => 'dedicated-key');
    const checkPython = vi.fn(async () => {});
    const runtime = createGeminiRuntime({ pythonExecutable: '/test/python', loadKey, checkPython });
    expect(loadKey).not.toHaveBeenCalled(); expect(runtime.pool.available).toBe(false);
    await expect(runtime.pool.start('v=0')).rejects.toMatchObject({ kind: 'unavailable' });
    await Promise.all([runtime.activate(), runtime.activate()]);
    expect(loadKey).toHaveBeenCalledOnce(); expect(checkPython).toHaveBeenCalledWith('/test/python');
    expect(runtime.status).toBe('ready'); expect(runtime.pool.available).toBe(true);
    runtime.close(); expect(runtime.status).toBe('closed'); expect(runtime.pool.available).toBe(false);
  });

  it('cannot reactivate after closing during credential loading', async () => {
    let resolve!: (key: string) => void;
    const loading = new Promise<string>(done => { resolve = done; });
    const runtime = createGeminiRuntime({ pythonExecutable: '/test/python', checkPython: async () => {}, loadKey: () => loading });
    const activation = runtime.activate(); await Promise.resolve(); runtime.close();
    resolve('late-key'); await activation;
    expect(runtime.status).toBe('closed'); expect(runtime.pool.available).toBe(false);
  });

  it('keeps invalid configuration and unavailable credentials out of ready state', async () => {
    for (const key of ['', 'x'.repeat(513), 'one\ntwo']) {
      const runtime = createGeminiRuntime({ pythonExecutable: '/test/python', checkPython: async () => {}, loadKey: async () => key });
      await runtime.activate(); expect(runtime.status).toBe('unavailable'); runtime.close();
    }
    const loadKey = vi.fn(async () => 'test');
    const runtime = createGeminiRuntime({ pythonExecutable: 'relative/python', loadKey });
    await runtime.activate(); expect(runtime.status).toBe('unavailable'); expect(loadKey).not.toHaveBeenCalled(); runtime.close();
  });

  it('constructs one attentive session and only accepts the native stop control', async () => {
    let config!: Parameters<typeof createGeminiAttentiveSession>[0];
    const close = vi.fn(); const decideResponse = vi.fn(() => true);
    const runtime = createGeminiRuntime({ pythonExecutable: '/test/python', checkPython: async () => {}, loadKey: async () => 'test',
      createSession: options => { config = options; return { close, decideResponse, sendPhoneToolMessage: vi.fn(), answer: async () => {
        config.onEvent({ type: 'ready' }); return 'v=0 answer';
      } }; },
    });
    await runtime.activate(); await runtime.pool.start('v=0 offer');
    config.onControl('{"type":"gemini.decideResponse","allow":true,"turnId":"fake"}');
    config.onControl('{"type":"run","command":"anything"}');
    expect(decideResponse).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    config.onControl('{"type":"gemini.stop"}'); expect(close).toHaveBeenCalledOnce();
    config.onEvent({ type: 'closed', reason: 'local' }); expect(runtime.pool.activeCount).toBe(0);
    runtime.close();
  });
});
