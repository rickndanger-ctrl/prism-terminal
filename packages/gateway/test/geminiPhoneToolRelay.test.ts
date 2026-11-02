import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiPhoneToolRelay } from '../src/realtime/geminiPhoneToolRelay.js';

afterEach(() => vi.useRealTimers());
function setup() {
  const send = vi.fn(); const turnId = randomUUID();
  const relay = new GeminiPhoneToolRelay({ names: new Set(['get_current_time']), send, timeoutMs: 1000 });
  relay.acceptSource({ turnId, transcript: 'What time is it?' });
  return { send, turnId, relay, signal: new AbortController().signal };
}

describe('Gemini phone tool relay', () => {
  it('correlates the exact request and accepts its reply only once', async () => {
    const s = setup(); const work = s.relay.call('get_current_time', {}, s.signal);
    const request = s.send.mock.calls[0]![0];
    expect(request.transcript).toBe('What time is it?');
    const response = JSON.stringify({ type: 'gemini.toolResult', requestId: request.requestId, turnId: s.turnId, output: { time: '12:30' } });
    expect(s.relay.handleResponse(response)).toBe(true);
    expect(s.relay.handleResponse(response)).toBe(false);
    await expect(work).resolves.toEqual({ time: '12:30' }); s.relay.close();
  });

  it('rejects unregistered tools and changes to accepted speech', async () => {
    const s = setup(); await expect(s.relay.call('run_anything', {}, s.signal)).rejects.toThrow('unavailable');
    expect(s.send).not.toHaveBeenCalled();
    expect(() => s.relay.acceptSource({ turnId: s.turnId, transcript: 'Different command' })).toThrow('replace'); s.relay.close();
  });

  it('cancels an old request on new speech and rejects late or wrong-turn results', async () => {
    const s = setup(); const work = s.relay.call('get_current_time', {}, s.signal);
    const rejected = expect(work).rejects.toThrow('cancelled');
    const request = s.send.mock.calls[0]![0];
    expect(s.relay.handleResponse(JSON.stringify({ type: 'gemini.toolResult', requestId: request.requestId, turnId: randomUUID(), output: {} }))).toBe(false);
    s.relay.acceptSource({ turnId: randomUUID(), transcript: 'Next request' }); await rejected;
    expect(s.relay.handleResponse(JSON.stringify({ type: 'gemini.toolResult', requestId: request.requestId, turnId: s.turnId, output: {} }))).toBe(false);
    expect(s.send.mock.calls.filter(call => call[0].type === 'gemini.toolCall')).toHaveLength(1); s.relay.close();
  });

  it('times out without replay or claiming the phone did nothing', async () => {
    vi.useFakeTimers(); const s = setup(); const work = s.relay.call('get_current_time', {}, s.signal);
    const rejected = expect(work).rejects.toThrow('completion is unconfirmed');
    await vi.advanceTimersByTimeAsync(1000); await rejected;
    expect(s.send.mock.calls.filter(call => call[0].type === 'gemini.toolCall')).toHaveLength(1); s.relay.close();
  });

  it('bounds concurrent calls and cancels only pending requests on close', async () => {
    const s = setup();
    const outcomes = Array.from({ length: 8 }, () => s.relay.call('get_current_time', {}, s.signal).catch(error => error.message));
    await expect(s.relay.call('get_current_time', {}, s.signal)).rejects.toThrow('unavailable');
    s.relay.close();
    expect(await Promise.all(outcomes)).toEqual(Array(8).fill('Phone tool cancelled'));
    expect(s.send.mock.calls.filter(call => call[0].type === 'gemini.toolCall')).toHaveLength(8);
    await expect(s.relay.call('get_current_time', {}, s.signal)).rejects.toThrow('unavailable');
  });

  it('honors cancellation and rejects malformed or oversized replies', async () => {
    const s = setup(); const abort = new AbortController();
    const work = s.relay.call('get_current_time', {}, abort.signal);
    const rejected = expect(work).rejects.toThrow('cancelled');
    for (const raw of ['not JSON', '{}', 'x'.repeat(65537)]) expect(s.relay.handleResponse(raw)).toBe(false);
    abort.abort(); await rejected;
    expect(s.send.mock.calls.filter(call => call[0].type === 'gemini.toolCall')).toHaveLength(1); s.relay.close();
  });
});
