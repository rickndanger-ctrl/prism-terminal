import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiResponseGate } from '../src/realtime/geminiResponseGate.js';

afterEach(() => vi.useRealTimers());
describe('Gemini response approval hold', () => {
  it('holds copied audio and text until that exact turn is approved', () => {
    const release = vi.fn(); const gate = new GeminiResponseGate({ release }); const id = gate.begin();
    const pcm = Buffer.from([1, 0]);
    gate.push(id, { type: 'audio', pcm }); pcm[0] = 9;
    gate.push(id, { type: 'outputTranscript', text: 'test' });
    gate.push(id, { type: 'turnComplete' });
    expect(release).not.toHaveBeenCalled(); expect(gate.decide('wrong', true)).toBe(false);
    expect(gate.decide(id, true)).toBe(true);
    expect(release.mock.calls.map(call => call[1])).toEqual([
      { type: 'audio', pcm: Buffer.from([1, 0]) }, { type: 'outputTranscript', text: 'test' }, { type: 'turnComplete' },
    ]);
    gate.invalidate();
  });

  it('denies old waiters and buffers when a new turn begins', async () => {
    const release = vi.fn(); const gate = new GeminiResponseGate({ release }); const old = gate.begin();
    const waiting = gate.waitForPermission(old, new AbortController().signal);
    gate.push(old, { type: 'audio', pcm: Buffer.from([1, 0]) });
    const next = gate.begin();
    await expect(waiting).resolves.toBe(false); expect(gate.decide(old, true)).toBe(false);
    gate.decide(next, true); expect(release).not.toHaveBeenCalled(); gate.invalidate();
  });

  it('cancels a waiting tool without waiting for an attention decision', async () => {
    const gate = new GeminiResponseGate({ release: vi.fn() }); const id = gate.begin();
    const controller = new AbortController(); const waiting = gate.waitForPermission(id, controller.signal);
    controller.abort(); await expect(waiting).resolves.toBe(false);
    gate.decide(id, true); gate.invalidate();
  });

  it('bounds memory and discards overflow without releasing anything', async () => {
    const release = vi.fn(); const denied = vi.fn(); const gate = new GeminiResponseGate({ release, denied });
    const id = gate.begin(); const waiting = gate.waitForPermission(id, new AbortController().signal);
    gate.push(id, { type: 'audio', pcm: Buffer.alloc(512002) });
    expect(release).not.toHaveBeenCalled(); expect(denied).toHaveBeenCalledWith(id);
    await expect(waiting).resolves.toBe(false); expect(gate.decide(id, true)).toBe(false); gate.invalidate();
  });

  it('starts a bounded deadline after speech ends and never resurrects an expired turn', async () => {
    vi.useFakeTimers(); const denied = vi.fn(); const gate = new GeminiResponseGate({ release: vi.fn(), denied });
    const id = gate.begin(); await vi.advanceTimersByTimeAsync(20000); expect(denied).not.toHaveBeenCalled();
    gate.armDeadline(id); await vi.advanceTimersByTimeAsync(10000);
    expect(denied).toHaveBeenCalledOnce(); expect(gate.decide(id, true)).toBe(false); gate.invalidate();
  });
});
