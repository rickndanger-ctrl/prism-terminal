import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GeminiGatewaySession, type GeminiSessionEvent } from '../src/realtime/geminiGatewaySession.js';
import type { GeminiBridgeEvent } from '../src/realtime/geminiBridgeProcess.js';
import type { GeminiLiveEvent, GeminiLiveOptions } from '../src/realtime/geminiLiveConnection.js';
import type { GeminiCapturedSpeech } from '../src/realtime/geminiSpeechTurnBuffer.js';

function setup(automaticSpeech = false, onCapturedSpeech?: (speech: GeminiCapturedSpeech) => Promise<void>) {
  let bridgeEvent!: (event: GeminiBridgeEvent) => void;
  let providerEvent!: (event: GeminiLiveEvent) => void;
  let config!: GeminiLiveOptions;
  const events: GeminiSessionEvent[] = [];
  const onControl = vi.fn();
  const execute = vi.fn(async () => ({ simulated: true }));
  const bridge = { answer: vi.fn(async () => 'v=0 answer'), sendPCM: vi.fn(), sendControl: vi.fn(), clearAudio: vi.fn(), close: vi.fn() };
  const connection = { sendText: vi.fn(), beginActivity: vi.fn(), sendPCM: vi.fn(), endActivity: vi.fn(), cancelPendingTools: vi.fn(), dismissResponse: vi.fn(), close: vi.fn() };
  const session = new GeminiGatewaySession({ pythonExecutable: '/test/python', automaticSpeech, onCapturedSpeech,
    connection: { apiKey: 'test', instruction: 'test', bindings: new Map([['test_tool', {
      arguments: z.object({}).strict(), execute,
    }]]) }, onControl, onEvent: event => events.push(event),
    bridgeFactory: callback => { bridgeEvent = callback; return bridge; },
    connectionFactory: value => { config = value; providerEvent = value.onEvent; return connection; },
  });
  async function start() {
    const answer = session.answer('v=0 offer');
    providerEvent({ type: 'ready' });
    await answer;
    bridgeEvent({ type: 'state', state: 'controlReady' });
  }
  return { session, bridge, connection, events, execute, onControl, start,
    bridgeEvent: (event: GeminiBridgeEvent) => bridgeEvent(event),
    providerEvent: (event: GeminiLiveEvent) => providerEvent(event),
    binding: () => config.bindings!.get('test_tool')!,
  };
}

describe('Gemini gateway session composition', () => {
  it('cancels only the accepted current response without closing the voice session', async () => {
    const s = setup(); await s.start();
    const id = s.session.beginActivity(); s.session.endActivity();
    s.bridgeEvent({ type: 'control', message: JSON.stringify({ type: 'gemini.cancelResponse', turnId: id }) });
    expect(s.connection.dismissResponse).not.toHaveBeenCalled();
    s.session.decideResponse(id, true);
    const cancel = JSON.stringify({ type: 'gemini.cancelResponse', turnId: id });
    s.bridgeEvent({ type: 'control', message: cancel });
    expect(s.connection.dismissResponse).toHaveBeenCalledOnce();
    expect(s.connection.cancelPendingTools).toHaveBeenCalled();
    expect(s.bridge.clearAudio).toHaveBeenCalled();
    s.providerEvent({ type: 'audio', pcm: Buffer.from([3, 0]), sampleRate: 24000 });
    expect(s.bridge.sendPCM).not.toHaveBeenCalled();
    s.bridgeEvent({ type: 'control', message: cancel });
    expect(s.connection.dismissResponse).toHaveBeenCalledOnce();
    expect(s.connection.close).not.toHaveBeenCalled();
    const next = s.session.beginActivity(); s.session.endActivity(); s.session.decideResponse(next, true);
    s.bridgeEvent({ type: 'control', message: cancel });
    expect(s.connection.dismissResponse).toHaveBeenCalledOnce();
    s.session.close();
  });
  it('hands exact captured audio to the evaluator without trusting provider transcripts', async () => {
    const evaluate = vi.fn<(speech: GeminiCapturedSpeech) => Promise<void>>(async () => {});
    const s = setup(true, evaluate); await s.start();
    s.bridgeEvent({ type: 'activityStart' });
    s.providerEvent({ type: 'inputTranscript', text: 'late unrelated transcript' });
    s.bridgeEvent({ type: 'inputAudio', pcm: Buffer.from([1, 0, 2, 0]) });
    s.bridgeEvent({ type: 'activityEnd', reason: 'silence' });
    await Promise.resolve();
    expect(evaluate).toHaveBeenCalledOnce();
    const captured = evaluate.mock.calls[0]![0];
    expect(captured.pcm).toEqual(Buffer.from([1, 0, 2, 0]));
    expect(captured).not.toHaveProperty('transcript');
    s.providerEvent({ type: 'audio', pcm: Buffer.from([3, 0]), sampleRate: 24000 });
    expect(s.bridge.sendPCM).not.toHaveBeenCalled();
    s.bridgeEvent({ type: 'activityStart' });
    expect(captured.signal.aborted).toBe(true);
    expect(s.session.decideResponse(captured.turnId, true)).toBe(false);
    s.session.close();
  });

  it('cancels capture evaluation on close before the asynchronous callback starts', async () => {
    const evaluate = vi.fn<(speech: GeminiCapturedSpeech) => Promise<void>>(async () => {});
    const s = setup(true, evaluate); await s.start();
    s.bridgeEvent({ type: 'activityStart' });
    s.bridgeEvent({ type: 'inputAudio', pcm: Buffer.from([1, 0]) });
    s.bridgeEvent({ type: 'activityEnd', reason: 'silence' }); s.session.close();
    await Promise.resolve(); expect(evaluate).not.toHaveBeenCalled();
  });

  it('defers ignored-turn feedback until active speech ends', async () => {
    const s = setup(); await s.start();
    const id = s.session.beginActivity();
    expect(s.session.decideResponse(id, false)).toBe(true);
    expect(s.connection.dismissResponse).not.toHaveBeenCalled();
    s.session.endActivity();
    expect(s.connection.dismissResponse).toHaveBeenCalledOnce();
    expect(s.session.decideResponse(id, true)).toBe(false);
    s.providerEvent({ type: 'audio', pcm: Buffer.from([1, 0]), sampleRate: 24000 });
    expect(s.bridge.sendPCM).not.toHaveBeenCalled(); s.session.close();
  });

  it('closes cleanly if provider dismissal cannot be delivered', async () => {
    const s = setup(); await s.start();
    const id = s.session.beginActivity(); s.session.endActivity();
    s.connection.dismissResponse.mockImplementation(() => { throw new Error('network failure'); });
    s.session.decideResponse(id, false);
    expect(s.bridge.close).toHaveBeenCalledOnce();
    expect(s.connection.close).toHaveBeenCalledOnce();
    expect(s.events.at(-1)).toEqual({ type: 'closed', reason: 'provider' });
  });

  it('detects automatic boundaries while holding the response for an attention decision', async () => {
    const s = setup(true); await s.start();
    s.bridgeEvent({ type: 'activityStart' });
    s.bridgeEvent({ type: 'inputAudio', pcm: Buffer.from([1, 0]) });
    s.bridgeEvent({ type: 'activityEnd', reason: 'silence' });
    expect(s.connection.beginActivity).toHaveBeenCalledOnce();
    expect(s.connection.sendPCM).toHaveBeenCalledOnce();
    expect(s.connection.endActivity).toHaveBeenCalledOnce();
    const ended = s.bridge.sendControl.mock.calls.map(call => JSON.parse(call[0])).find(event => event.type === 'gemini.activityEnded');
    expect(ended.reason).toBe('silence');
    s.providerEvent({ type: 'audio', pcm: Buffer.from([2, 0]), sampleRate: 24000 });
    expect(s.bridge.sendPCM).not.toHaveBeenCalled();
    expect(s.session.decideResponse(ended.turnId, true)).toBe(true);
    expect(s.bridge.sendPCM).toHaveBeenCalledOnce(); s.session.close();
  });

  it('does not speak at a forced long-speech boundary', async () => {
    const s = setup(true); await s.start();
    s.bridgeEvent({ type: 'activityStart' });
    s.bridgeEvent({ type: 'activityEnd', reason: 'limit' });
    const ended = s.bridge.sendControl.mock.calls.map(call => JSON.parse(call[0])).find(event => event.type === 'gemini.activityEnded');
    expect(s.session.decideResponse(ended.turnId, true)).toBe(false);
    s.providerEvent({ type: 'audio', pcm: Buffer.from([2, 0]), sampleRate: 24000 });
    expect(s.bridge.sendPCM).not.toHaveBeenCalled(); s.session.close();
  });

  it('ignores detector events when automatic speech is not enabled', async () => {
    const s = setup(); await s.start();
    s.bridgeEvent({ type: 'activityStart' });
    s.bridgeEvent({ type: 'activityEnd', reason: 'silence' });
    expect(s.connection.beginActivity).not.toHaveBeenCalled();
    expect(s.connection.endActivity).not.toHaveBeenCalled(); s.session.close();
  });
  it('announces readiness only after provider setup, SDP answer, and control channel', async () => {
    const s = setup(); const answer = s.session.answer('v=0 offer');
    s.bridgeEvent({ type: 'state', state: 'controlReady' });
    expect(s.events).toEqual([]);
    expect(() => s.session.beginActivity()).toThrow('not ready');
    s.providerEvent({ type: 'ready' }); await answer;
    expect(s.events).toEqual([{ type: 'ready' }]);
    expect(JSON.parse(s.bridge.sendControl.mock.calls[0]![0])).toEqual({ type: 'gemini.ready' });
    s.session.close();
  });

  it('drops idle PCM and forwards only host-started audio activity', async () => {
    const s = setup(); await s.start();
    const event = { type: 'inputAudio' as const, pcm: Buffer.from([1, 0]) };
    s.bridgeEvent(event); expect(s.connection.sendPCM).not.toHaveBeenCalled();
    s.session.beginActivity({ deferResponse: false }); s.bridgeEvent(event); s.session.endActivity(); s.bridgeEvent(event);
    expect(s.connection.sendPCM).toHaveBeenCalledExactlyOnceWith(event.pcm);
    expect(s.connection.beginActivity).toHaveBeenCalledOnce();
    expect(s.connection.endActivity).toHaveBeenCalledOnce(); s.session.close();
  });

  it('routes audio and transcripts without pretending generation completion is playback completion', async () => {
    const s = setup(); await s.start(); s.session.sendText('synthetic question');
    s.providerEvent({ type: 'audio', pcm: Buffer.from([1, 0]), sampleRate: 24000 });
    s.providerEvent({ type: 'outputTranscript', text: 'synthetic answer' });
    s.providerEvent({ type: 'turnComplete' });
    expect(s.bridge.sendPCM).toHaveBeenCalledOnce();
    expect(s.bridge.close).not.toHaveBeenCalled(); // Do not cut off buffered final audio.
    expect(s.events.at(-1)).toEqual({ type: 'turnComplete' }); s.session.close();
  });

  it('clears old playback and cancels pending tools before a new speech turn', async () => {
    const s = setup(); await s.start(); s.session.sendText('first');
    s.connection.cancelPendingTools.mockClear(); s.bridge.clearAudio.mockClear();
    s.session.beginActivity({ deferResponse: false });
    s.providerEvent({ type: 'audio', pcm: Buffer.from([1, 0]), sampleRate: 24000 });
    s.providerEvent({ type: 'turnComplete' });
    expect(s.bridge.sendPCM).not.toHaveBeenCalled();
    expect(s.connection.cancelPendingTools).toHaveBeenCalledOnce();
    expect(s.bridge.clearAudio).toHaveBeenCalledOnce();
    s.session.endActivity();
    s.providerEvent({ type: 'audio', pcm: Buffer.from([2, 0]), sampleRate: 24000 });
    expect(s.bridge.sendPCM).toHaveBeenCalledOnce(); s.session.close();
  });

  it('does not turn data-channel messages into actions without a host policy', async () => {
    const s = setup(); await s.start();
    s.bridgeEvent({ type: 'control', message: '{"type":"run_anything"}' });
    expect(s.onControl).toHaveBeenCalledWith('{"type":"run_anything"}');
    expect(s.connection.sendText).not.toHaveBeenCalled();
    expect(s.connection.beginActivity).not.toHaveBeenCalled(); s.session.close();
  });

  it('does not let delayed completion of an interrupted turn silence the next answer', async () => {
    const s = setup(); await s.start(); s.session.sendText('old question');
    s.session.beginActivity({ deferResponse: false });
    s.providerEvent({ type: 'clearAudio' });
    s.session.endActivity();
    s.providerEvent({ type: 'turnComplete' }); // Old interrupted response, delayed.
    s.providerEvent({ type: 'audio', pcm: Buffer.from([2, 0]), sampleRate: 24000 });
    expect(s.bridge.sendPCM).toHaveBeenCalledOnce();
    s.providerEvent({ type: 'turnComplete' });
    expect(s.events.filter(event => event.type === 'turnComplete')).toHaveLength(1);
    s.session.close();
  });

  it('does not execute provider tools while idle or speaking', async () => {
    const s = setup(); await s.start();
    const signal = new AbortController().signal;
    await expect(s.binding().execute({}, signal)).rejects.toThrow('No authorized');
    s.session.beginActivity({ deferResponse: false });
    await expect(s.binding().execute({}, signal)).rejects.toThrow('No authorized');
    s.session.endActivity(); await s.binding().execute({}, signal);
    expect(s.execute).toHaveBeenCalledOnce();
    s.session.close(); await expect(s.binding().execute({}, signal)).rejects.toThrow('No authorized');
  });

  it('quarantines output and tools until the interrupted predecessor completes', async () => {
    const s = setup(); await s.start(); s.session.sendText('old request');
    s.session.beginActivity({ deferResponse: false });
    s.providerEvent({ type: 'clearAudio' });
    s.session.endActivity();
    s.providerEvent({ type: 'audio', pcm: Buffer.from([2, 0]), sampleRate: 24000 });
    s.providerEvent({ type: 'outputTranscript', text: 'old answer arriving late' });
    await expect(s.binding().execute({}, new AbortController().signal)).rejects.toThrow('No authorized');
    expect(s.bridge.sendPCM).not.toHaveBeenCalled();
    expect(s.events.some(event => event.type === 'outputTranscript')).toBe(false);
    expect(s.execute).not.toHaveBeenCalled();
    s.providerEvent({ type: 'turnComplete' });
    s.providerEvent({ type: 'audio', pcm: Buffer.from([3, 0]), sampleRate: 24000 });
    await s.binding().execute({}, new AbortController().signal);
    expect(s.bridge.sendPCM).toHaveBeenCalledOnce();
    expect(s.execute).toHaveBeenCalledOnce(); s.session.close();
  });

  it('closes the other half immediately when a provider or bridge fails', async () => {
    for (const side of ['bridge', 'provider']) {
      const s = setup(); await s.start();
      if (side === 'bridge') s.bridgeEvent({ type: 'closed', reason: 'exit' });
      else s.providerEvent({ type: 'closed', reason: 'network' });
      expect(s.bridge.close).toHaveBeenCalledOnce();
      expect(s.connection.close).toHaveBeenCalledOnce();
      expect(() => s.session.beginActivity()).toThrow('not ready');
      s.session.close(); expect(s.bridge.close).toHaveBeenCalledOnce();
    }
  });

  it('rejects setup and closes the peer if provider setup fails', async () => {
    const s = setup(); const answer = s.session.answer('v=0');
    s.providerEvent({ type: 'closed', reason: 'network' });
    await expect(answer).rejects.toThrow('could not start');
    expect(s.bridge.close).toHaveBeenCalledOnce();
  });

  it('holds generated speech and tool work by default until the turn is approved', async () => {
    const s = setup(); await s.start();
    const id = s.session.beginActivity(); s.session.endActivity();
    const work = s.binding().execute({}, new AbortController().signal);
    s.providerEvent({ type: 'audio', pcm: Buffer.from([3, 0]), sampleRate: 24000 });
    s.providerEvent({ type: 'outputTranscript', text: 'held response' });
    await Promise.resolve(); expect(s.execute).not.toHaveBeenCalled(); expect(s.bridge.sendPCM).not.toHaveBeenCalled();
    expect(s.session.decideResponse(id, true)).toBe(true); await work;
    expect(s.execute).toHaveBeenCalledOnce(); expect(s.bridge.sendPCM).toHaveBeenCalledOnce(); s.session.close();
  });

  it('drops a denied turn and still answers a later explicitly authorized request', async () => {
    const s = setup(); await s.start();
    const id = s.session.beginActivity({ deferResponse: true }); s.session.endActivity();
    const work = s.binding().execute({}, new AbortController().signal);
    const rejected = expect(work).rejects.toThrow('No authorized');
    s.providerEvent({ type: 'audio', pcm: Buffer.from([3, 0]), sampleRate: 24000 });
    s.session.decideResponse(id, false); await rejected;
    expect(s.connection.dismissResponse).toHaveBeenCalledOnce();
    expect(s.execute).not.toHaveBeenCalled(); expect(s.bridge.sendPCM).not.toHaveBeenCalled();
    s.session.sendText('next explicit request');
    expect(s.session.decideResponse(id, true)).toBe(false);
    s.providerEvent({ type: 'audio', pcm: Buffer.from([4, 0]), sampleRate: 24000 });
    expect(s.bridge.sendPCM).toHaveBeenCalledOnce(); s.session.close();
  });
});
