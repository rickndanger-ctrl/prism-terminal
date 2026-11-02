import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GeminiLiveConnection, type GeminiLiveEvent, type GeminiWireHandlers } from '../src/realtime/geminiLiveConnection.js';

const connections: GeminiLiveConnection[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); vi.useRealTimers(); });
function setup(execute?: (args: unknown, signal: AbortSignal) => Promise<unknown>) {
  const events: GeminiLiveEvent[] = [];
  const send = vi.fn(); const close = vi.fn(); const bufferedBytes = vi.fn(() => 0);
  let handlers!: GeminiWireHandlers;
  const connection = new GeminiLiveConnection({
    apiKey: 'synthetic-key-not-real', instruction: 'Synthetic test only.', onEvent: event => events.push(event),
    ...(execute ? { tools: [{ name: 'open_app', description: 'Simulated only', parameters: { type: 'OBJECT' } }],
      bindings: new Map([['open_app', { arguments: z.object({ app: z.literal('Calculator') }).strict(), execute }]]) } : {}),
    wireFactory: (url, callbacks) => {
      expect(new URL(url).host).toBe('generativelanguage.googleapis.com');
      handlers = callbacks; return { send, close, bufferedBytes };
    },
  });
  connections.push(connection);
  const receive = (message: unknown) => handlers.message(JSON.stringify(message));
  const ready = () => { handlers.open(); receive({ setupComplete: {} }); };
  return { connection, events, send, close, bufferedBytes, handlers, receive, ready };
}
const toolCall = { functionCalls: [{ id: 'one', name: 'open_app', args: { app: 'Calculator' } }] };
const audio = { inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from([1, 0, 2, 0]).toString('base64') } };

describe('Gemini live connection', () => {
  function resumableSetup(execute?: (args: unknown, signal: AbortSignal) => Promise<unknown>) {
    const wires: Array<{ handlers: GeminiWireHandlers; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const events: GeminiLiveEvent[] = [];
    const connection = new GeminiLiveConnection({ apiKey: 'test', instruction: 'test', onEvent: event => events.push(event),
      ...(execute ? { tools: [{ name: 'open_app', description: 'Simulated only', parameters: { type: 'OBJECT' } }],
        bindings: new Map([['open_app', { arguments: z.object({ app: z.literal('Calculator') }).strict(), execute }]]) } : {}),
      wireFactory: (_url, handlers) => {
        const wire = { handlers, send: vi.fn(), close: vi.fn(() => handlers.failed()) };
        wires.push(wire); return { ...wire, bufferedBytes: () => 0 };
      } });
    connections.push(connection);
    wires[0]!.handlers.open(); wires[0]!.handlers.message('{"setupComplete":{}}');
    const receive = (message: unknown, index = 0) => wires[index]!.handlers.message(JSON.stringify(message));
    return { connection, wires, events, receive };
  }

  it('resumes only an idle fresh checkpoint and queues new speech until setup', () => {
    const { connection, wires, events, receive } = resumableSetup();
    receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'private-checkpoint' } });
    receive({ goAway: { timeLeft: '30s' } });
    expect(wires).toHaveLength(2);
    expect(wires[0]!.close).toHaveBeenCalledOnce();
    receive({ serverContent: { outputTranscription: { text: 'stale' }, turnComplete: true } });
    connection.beginActivity(); connection.sendPCM(new Uint8Array([1, 0])); connection.endActivity();
    expect(wires[1]!.send).not.toHaveBeenCalled();
    wires[1]!.handlers.open();
    expect(JSON.parse(wires[1]!.send.mock.calls[0]![0]).setup.sessionResumption).toEqual({ handle: 'private-checkpoint' });
    receive({ setupComplete: {} }, 1);
    expect(wires[1]!.send.mock.calls.slice(1).map(call => Object.keys(JSON.parse(call[0]).realtimeInput)[0]))
      .toEqual(['activityStart', 'audio', 'activityEnd']);
    expect(events).toEqual([{ type: 'ready' }]);
    connection.close(); expect(wires[1]!.close).toHaveBeenCalledOnce();
  });

  it('parks a quiet provider socket and resumes only when new speech arrives', () => {
    vi.useFakeTimers();
    const { connection, wires, events, receive } = resumableSetup();
    receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'quiet-checkpoint' } });
    vi.advanceTimersByTime(60_000);
    expect(wires).toHaveLength(1); expect(wires[0]!.close).toHaveBeenCalledOnce();
    expect(connection.isReady).toBe(true); expect(events).toEqual([{ type: 'ready' }]);
    vi.advanceTimersByTime(5 * 60_000);
    expect(wires).toHaveLength(1); // No reconnect churn or dummy speech during silence.
    connection.beginActivity(); connection.sendPCM(new Uint8Array([1, 0])); connection.endActivity();
    expect(wires).toHaveLength(2);
    wires[1]!.handlers.open();
    expect(JSON.parse(wires[1]!.send.mock.calls[0]![0]).setup.sessionResumption.handle).toBe('quiet-checkpoint');
    receive({ setupComplete: {} }, 1);
    expect(wires[1]!.send).toHaveBeenCalledTimes(4);
    expect(events).toEqual([{ type: 'ready' }]);
  });

  it('new input cancels parking and local stop cannot wake a parked connection', () => {
    vi.useFakeTimers();
    const first = resumableSetup();
    first.receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'checkpoint' } });
    vi.advanceTimersByTime(59_999); first.connection.beginActivity();
    vi.advanceTimersByTime(1000);
    expect(first.wires[0]!.close).not.toHaveBeenCalled();
    first.connection.close();
    const second = resumableSetup();
    second.receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'checkpoint' } });
    vi.advanceTimersByTime(60_000); second.connection.close();
    expect(() => second.connection.beginActivity()).toThrow('not ready');
    expect(second.wires).toHaveLength(1);
  });

  it('can park before the first utterance without inventing a resumption handle', () => {
    vi.useFakeTimers();
    const { connection, wires, receive, events } = resumableSetup();
    vi.advanceTimersByTime(60_000);
    expect(wires[0]!.close).toHaveBeenCalledOnce();
    connection.sendText('first question');
    wires[1]!.handlers.open();
    expect(JSON.parse(wires[1]!.send.mock.calls[0]![0]).setup.sessionResumption).toEqual({});
    receive({ setupComplete: {} }, 1);
    expect(events).toEqual([{ type: 'ready' }]);
    expect(wires[1]!.send).toHaveBeenCalledTimes(2);
  });

  it('never resumes a checkpoint predating new input or a revoked checkpoint', () => {
    const { connection, wires, receive } = resumableSetup();
    receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'old' } });
    connection.sendText('new question');
    receive({ goAway: { timeLeft: '10s' } });
    receive({ serverContent: { turnComplete: true } });
    expect(wires).toHaveLength(1);
    receive({ sessionResumptionUpdate: { resumable: false, newHandle: '' } });
    expect(wires).toHaveLength(1);
    receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'fresh' } });
    expect(wires).toHaveLength(2);
  });

  it('waits for a checkpoint after the completed answer, not one during generation', () => {
    const { connection, wires, receive } = resumableSetup();
    connection.sendText('seven times eight');
    receive({ serverContent: { outputTranscription: { text: 'Seven times' } } });
    receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'partial-answer' } });
    receive({ goAway: { timeLeft: '30s' } });
    receive({ serverContent: { outputTranscription: { text: 'eight is fifty-six.' }, turnComplete: true } });
    expect(wires).toHaveLength(1);
    receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'completed-answer' } });
    expect(wires).toHaveLength(2);
    wires[1]!.handlers.open();
    expect(JSON.parse(wires[1]!.send.mock.calls[0]![0]).setup.sessionResumption.handle).toBe('completed-answer');
  });

  it('closes rather than accumulating unbounded input during handoff', () => {
    const { connection, receive, wires, events } = resumableSetup();
    receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'fresh' }, goAway: { timeLeft: '30s' } });
    connection.beginActivity();
    expect(() => { for (let index = 0; index < 20; index++) connection.sendPCM(new Uint8Array(32000)); }).toThrow();
    expect(events.at(-1)).toEqual({ type: 'closed', reason: 'backpressure' });
    wires[1]!.handlers.open(); expect(wires[1]!.send).not.toHaveBeenCalled();
  });

  it('does not retry an unexpected network failure', () => {
    const { wires, receive, events } = resumableSetup();
    receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'fresh' } });
    wires[0]!.handlers.failed();
    expect(wires).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'closed', reason: 'network' });
  });

  it('waits for pending tools and does not repeat an executed call after handoff', async () => {
    let resolve!: (value: unknown) => void;
    const execute = vi.fn(() => new Promise(done => { resolve = done; }));
    const { wires, receive } = resumableSetup(execute);
    receive({ toolCall });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'before-result' }, goAway: { timeLeft: '30s' } });
    expect(wires).toHaveLength(1);
    resolve({ simulated: true });
    await vi.waitFor(() => expect(wires[0]!.send.mock.calls.some(call => JSON.parse(call[0]).toolResponse)).toBe(true));
    expect(wires).toHaveLength(1); // Sending the result invalidated the checkpoint.
    receive({ serverContent: { turnComplete: true } });
    receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'after-result' } });
    expect(wires).toHaveLength(2);
    wires[1]!.handlers.open(); receive({ setupComplete: {} }, 1);
    receive({ toolCall }, 1); // Provider replays the same ID after resumption.
    await new Promise(done => setImmediate(done));
    expect(execute).toHaveBeenCalledOnce();
    expect(wires[1]!.send.mock.calls.some(call => JSON.parse(call[0]).toolResponse)).toBe(false);
  });

  it('does not replay cancelled work or deliver its late result across handoff', async () => {
    let resolve!: (value: unknown) => void;
    let signal!: AbortSignal;
    const execute = vi.fn((_args, incoming: AbortSignal) => {
      signal = incoming; return new Promise(done => { resolve = done; });
    });
    const { wires, receive } = resumableSetup(execute);
    receive({ toolCall }); await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    receive({ toolCallCancellation: { ids: ['one'] } });
    expect(signal.aborted).toBe(true);
    await new Promise(done => setImmediate(done));
    receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'cancelled' }, goAway: { timeLeft: '30s' } });
    expect(wires).toHaveLength(2);
    wires[1]!.handlers.open(); receive({ setupComplete: {} }, 1);
    resolve({ tooLate: true }); receive({ toolCall }, 1);
    await new Promise(done => setImmediate(done));
    expect(execute).toHaveBeenCalledOnce();
    expect(wires.flatMap(wire => wire.send.mock.calls).some(call => JSON.parse(call[0]).toolResponse)).toBe(false);
  });
  it('sends host dismissal as context only without requesting generation', () => {
    const { connection, ready, send } = setup(); ready();
    connection.beginActivity();
    expect(() => connection.dismissResponse()).toThrow('active speech');
    connection.endActivity(); connection.dismissResponse();
    const message = JSON.parse(send.mock.calls.at(-1)![0]);
    expect(message.clientContent.turnComplete).toBe(false);
    expect(message.clientContent.turns[0].role).toBe('user');
    expect(message.clientContent.turns[0].parts[0].text).toContain('Do not answer it');
    expect(message).not.toHaveProperty('realtimeInput');
  });
  it('waits for setup and sends bounded PCM with explicit activity boundaries', () => {
    const { connection, ready, send } = setup();
    expect(() => connection.sendText('test')).toThrow('not ready');
    ready();
    const config = JSON.parse(send.mock.calls[0]![0]);
    expect(config.setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(true);
    expect(config.setup.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(config.setup).not.toHaveProperty('apiKey');
    expect(() => connection.sendPCM(new Uint8Array([0, 0]))).toThrow();
    connection.beginActivity();
    expect(() => connection.beginActivity()).toThrow();
    expect(() => connection.sendText('interleave')).toThrow();
    expect(() => connection.sendPCM(new Uint8Array([0]))).toThrow();
    connection.sendPCM(new Uint8Array([1, 0])); connection.endActivity();
    expect(() => connection.endActivity()).toThrow();
    expect(send.mock.calls.slice(1).map(call => JSON.parse(call[0]))).toEqual([
      { realtimeInput: { activityStart: {} } },
      { realtimeInput: { audio: { data: 'AQA=', mimeType: 'audio/pcm;rate=16000' } } },
      { realtimeInput: { activityEnd: {} } },
    ]);
  });

  it('processes every audio part and transcripts before turn completion', () => {
    const { ready, receive, events } = setup(); ready();
    receive({ serverContent: { modelTurn: { parts: [audio, { thought: true, ...audio }, audio] },
      inputTranscription: { text: 'question' }, outputTranscription: { text: 'answer' }, turnComplete: true } });
    expect(events.map(event => event.type)).toEqual(['ready', 'inputTranscript', 'audio', 'audio', 'outputTranscript', 'turnComplete']);
  });

  it('discards interrupted audio and clears playback first', () => {
    const { ready, receive, events } = setup(); ready();
    receive({ serverContent: { interrupted: true, modelTurn: { parts: [audio] }, outputTranscription: { text: 'stale' } } });
    expect(events.map(event => event.type)).toEqual(['ready', 'clearAudio']);
  });

  it('handles provider cancellation while a tool executor is waiting', async () => {
    let signal: AbortSignal | undefined;
    const execute = vi.fn(async (_args, incoming: AbortSignal) => { signal = incoming; return await new Promise(() => {}); });
    const { ready, receive, connection, send } = setup(execute); ready();
    receive({ toolCall }); await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    receive({ toolCallCancellation: { ids: ['one'] } });
    expect(signal?.aborted).toBe(true);
    connection.sendText('next question');
    expect(send.mock.calls.some(call => JSON.parse(call[0]).toolResponse)).toBe(false);
  });

  it('honors cancellation that shares a frame with a tool call', async () => {
    const execute = vi.fn(async () => ({ simulated: true }));
    const { ready, receive } = setup(execute); ready();
    receive({ toolCall, toolCallCancellation: { ids: ['one'] } });
    await new Promise(resolve => setImmediate(resolve));
    expect(execute).not.toHaveBeenCalled();
  });

  it('delivers correlated results through the actual dispatcher', async () => {
    const { ready, receive, send } = setup(async () => ({ code: '7319' })); ready();
    receive({ toolCall });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(JSON.parse(send.mock.calls[1]![0])).toEqual({ toolResponse: { functionResponses: [
      { id: 'one', name: 'open_app', response: { result: { code: '7319' } } },
    ] } });
  });

  it('closes and clears playback once on malformed content without exposing payloads', () => {
    const { ready, handlers, events, close, connection } = setup(); ready();
    handlers.message('private malformed payload'); handlers.failed();
    expect(close).toHaveBeenCalledOnce();
    expect(events.slice(1)).toEqual([{ type: 'clearAudio' }, { type: 'closed', reason: 'protocol' }]);
    expect(() => connection.sendText('retry')).toThrow('not ready');
  });

  it('refuses invalid PCM and oversized frames', () => {
    for (const payload of [
      JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: '!!!' } }] } } }),
      ' '.repeat(1_048_577),
    ]) {
      const { ready, handlers, connection } = setup(); ready(); handlers.message(payload);
      expect(connection.isReady).toBe(false);
    }
  });

  it('stops locally before queued tools start and ignores late server frames', async () => {
    const execute = vi.fn(async () => ({ simulated: true }));
    const { ready, receive, connection, events } = setup(execute); ready();
    receive({ toolCall }); connection.close();
    receive({ serverContent: { modelTurn: { parts: [audio] } } });
    await new Promise(resolve => setImmediate(resolve));
    expect(execute).not.toHaveBeenCalled();
    expect(events.map(event => event.type)).toEqual(['ready', 'clearAudio', 'closed']);
  });

  it('fails closed on backpressure rather than queuing stale speech', () => {
    const { ready, bufferedBytes, connection, events } = setup(); ready();
    bufferedBytes.mockReturnValue(1_048_576);
    expect(() => connection.sendText('test')).toThrow('backpressure');
    expect(events.at(-1)).toEqual({ type: 'closed', reason: 'backpressure' });
  });

  it('ends setup waits after fifteen seconds', () => {
    vi.useFakeTimers(); const { connection, events } = setup();
    vi.advanceTimersByTime(15_000);
    expect(connection.isReady).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'closed', reason: 'timeout' });
  });

  it('reports a sanitized tool failure category without leaking arguments', () => {
    const execute = vi.fn(async () => ({ simulated: true }));
    const { ready, receive, events } = setup(execute); ready();
    receive({ toolCall: { functionCalls: [{ id: 'one', name: 'open_app', args: { app: 'private-value' } }] } });
    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'closed', reason: 'tool', toolFailure: 'invalid_arguments' });
    expect(JSON.stringify(events)).not.toContain('private-value');
  });
});
