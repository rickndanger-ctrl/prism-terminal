import { describe, expect, it } from 'vitest';
import { GeminiSpeechTurnBuffer } from '../src/realtime/geminiSpeechTurnBuffer.js';

describe('Gemini captured speech ownership', () => {
  it('copies exactly one turn and never returns it twice', () => {
    const buffer = new GeminiSpeechTurnBuffer(); buffer.begin('one');
    const pcm = Buffer.from([1, 0]); buffer.append('one', pcm); pcm.fill(9);
    buffer.append('one', Buffer.from([2, 0]));
    const result = buffer.end('one')!;
    expect(result.pcm).toEqual(Buffer.from([1, 0, 2, 0]));
    expect(result.sampleRate).toBe(16000);
    expect(result.signal.aborted).toBe(false);
    expect(buffer.end('one')).toBeUndefined();
    expect(buffer.append('one', Buffer.from([1, 0]))).toBe(false);
  });

  it('cancels an old evaluator when new speech starts', () => {
    const buffer = new GeminiSpeechTurnBuffer(); buffer.begin('old');
    buffer.append('old', Buffer.from([1, 0]));
    const old = buffer.end('old')!;
    buffer.begin('new');
    expect(old.signal.aborted).toBe(true);
    expect(buffer.append('old', Buffer.from([9, 0]))).toBe(false);
    expect(buffer.end('old')).toBeUndefined();
    buffer.append('new', Buffer.from([2, 0]));
    expect(buffer.end('new')!.pcm).toEqual(Buffer.from([2, 0]));
  });

  it('bounds audio to sixty seconds and refuses malformed samples', () => {
    const buffer = new GeminiSpeechTurnBuffer(); buffer.begin('one');
    for (let i = 0; i < 60; i++) expect(buffer.append('one', Buffer.alloc(32000))).toBe(true);
    expect(buffer.append('one', Buffer.from([1, 0]))).toBe(false);
    expect(buffer.end('one')).toBeUndefined();
    for (const value of [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(32002)]) {
      buffer.begin('bad'); expect(buffer.append('bad', value)).toBe(false);
    }
  });

  it('does not turn empty capture or cancellation into a request', () => {
    const buffer = new GeminiSpeechTurnBuffer(); buffer.begin('one');
    expect(buffer.end('one')).toBeUndefined();
    buffer.append('one', Buffer.from([1, 0])); const result = buffer.end('one')!;
    buffer.cancel(); expect(result.signal.aborted).toBe(true);
    expect(buffer.end('one')).toBeUndefined();
  });
});
