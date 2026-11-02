import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { PassThrough } from 'node:stream';
import { GeminiBridgeProcess, type GeminiBridgeEvent } from '../src/realtime/geminiBridgeProcess.js';

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return { spawn: vi.fn(() => Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: vi.fn(),
  })) };
});
const bridges: GeminiBridgeProcess[] = [];
afterEach(() => { bridges.splice(0).forEach(bridge => bridge.close()); vi.clearAllMocks(); vi.useRealTimers(); });
function setup() {
  const events: GeminiBridgeEvent[] = [];
  const bridge = new GeminiBridgeProcess({ pythonExecutable: '/runtime/python', onEvent: event => events.push(event) });
  bridges.push(bridge);
  const answer = bridge.answer('v=0\r\n');
  const child = vi.mocked(spawn).mock.results.at(-1)!.value as ChildProcessWithoutNullStreams;
  const emit = (event: unknown) => child.stdout.emit('data', JSON.stringify(event) + '\n');
  return { bridge, answer, child, emit, events };
}

describe('Gemini bridge process supervisor', () => {
  it('uses host-owned executable without a shell or inherited credential environment', async () => {
    const { child, emit, answer } = setup();
    const args = vi.mocked(spawn).mock.calls[0]!;
    expect(args[0]).toBe('/runtime/python');
    expect(args[2]).toMatchObject({ shell: false, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONNOUSERSITE: '1' } });
    expect(Object.keys((args[2] as { env: object }).env)).toHaveLength(3);
    expect(JSON.parse((child.stdin as PassThrough).read().toString())).toEqual({ type: 'offer', sdp: 'v=0\r\n' });
    emit({ type: 'answer', sdp: 'v=0\r\nanswer' });
    await expect(answer).resolves.toBe('v=0\r\nanswer');
  });

  it('handles split frames and multiple messages without corrupting PCM', async () => {
    const { child, emit, answer, events } = setup();
    child.stdout.emit('data', '{"type":"ans');
    child.stdout.emit('data', 'wer","sdp":"v=0"}\n{"type":"inputAudio","pcm":"AQA="}\n');
    await answer;
    emit({ type: 'control', message: 'test-only' });
    expect(events).toEqual([{ type: 'inputAudio', pcm: Buffer.from([1, 0]) }, { type: 'control', message: 'test-only' }]);
  });

  it('rejects malformed data without forwarding it', async () => {
    const { child, answer, events } = setup();
    child.stdout.emit('data', 'private-malformed\n');
    await expect(answer).rejects.toThrow('protocol');
    expect(events).toEqual([{ type: 'closed', reason: 'protocol' }]);
    child.stdout.emit('data', '{"type":"state","state":"connected"}\n');
    expect(events).toHaveLength(1);
  });

  it('closes on invalid PCM instead of passing corrupt audio to the provider', async () => {
    const { emit, answer, events } = setup();
    emit({ type: 'answer', sdp: 'v=0' }); await answer;
    emit({ type: 'inputAudio', pcm: '!!!' });
    expect(events).toEqual([{ type: 'closed', reason: 'protocol' }]);
  });

  it('bounds the offer wait and kills only its own unresponsive child', async () => {
    vi.useFakeTimers();
    const { answer, child } = setup();
    const rejected = expect(answer).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(20_000); await rejected;
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('does not respawn or replay when the process exits', async () => {
    const { child, answer, bridge } = setup();
    Object.defineProperty(child, 'exitCode', { value: 1 }); child.emit('exit', 1);
    await expect(answer).rejects.toThrow('exit');
    await expect(bridge.answer('v=0')).rejects.toThrow('duplicate');
    expect(spawn).toHaveBeenCalledOnce();
  });
});
