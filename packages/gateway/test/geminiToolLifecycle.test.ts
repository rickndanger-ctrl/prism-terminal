import { describe, expect, it, vi } from 'vitest';
import { GeminiToolLifecycle } from '../src/realtime/geminiToolLifecycle.js';

describe('Gemini connection tool guard', () => {
  it('executes once and rejects duplicate delivery even after completion', async () => {
    const guard = new GeminiToolLifecycle();
    const execute = vi.fn(async () => 'done');
    const first = guard.run('call-1', execute);
    expect(await guard.run('call-1', execute)).toEqual({ status: 'duplicate' });
    expect(await first).toEqual({ status: 'completed', value: 'done' });
    expect(await guard.run('call-1', execute)).toEqual({ status: 'duplicate' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stops queued execution before the callback starts', async () => {
    const guard = new GeminiToolLifecycle();
    const execute = vi.fn(async () => 'not allowed');
    const result = guard.run('call-1', execute);
    guard.cancel('call-1');
    expect(await result).toEqual({ status: 'cancelled' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('remembers cancellation arriving before dispatch', async () => {
    const guard = new GeminiToolLifecycle();
    guard.cancel('call-1');
    const execute = vi.fn(async () => 'not allowed');
    expect(await guard.run('call-1', execute)).toEqual({ status: 'cancelled' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'close'] as const)('signals running work and suppresses its late result on %s', async mode => {
    const guard = new GeminiToolLifecycle();
    let signal: AbortSignal | undefined;
    let finish!: (value: string) => void;
    const result = guard.run('call-1', async received => {
      signal = received;
      return new Promise<string>(resolve => { finish = resolve; });
    });
    await Promise.resolve();
    if (mode === 'cancel') guard.cancel('call-1'); else guard.close();
    expect(signal?.aborted).toBe(true);
    finish('late completion must not be spoken');
    expect(await result).toEqual({ status: 'cancelled' });
  });

  it('does not replay failed work or expose exception contents', async () => {
    const guard = new GeminiToolLifecycle();
    const execute = vi.fn(async () => { throw new Error('private provider response'); });
    expect(await guard.run('call-1', execute)).toEqual({ status: 'failed' });
    expect(await guard.run('call-1', execute)).toEqual({ status: 'duplicate' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns cancellation even when an executor ignores abort and never settles', async () => {
    const guard = new GeminiToolLifecycle();
    const result = guard.run('hung', async () => new Promise<never>(() => {}));
    await Promise.resolve();
    guard.cancel('hung');
    expect(await result).toEqual({ status: 'cancelled' });
  });

  it('closes on capacity instead of evicting replay protection', async () => {
    const guard = new GeminiToolLifecycle(1);
    guard.cancel('old');
    const execute = vi.fn(async () => 'not allowed');
    expect(await guard.run('new', execute)).toEqual({ status: 'closed' });
    expect(await guard.run('old', execute)).toEqual({ status: 'closed' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects invalid IDs without invoking an executor', async () => {
    const guard = new GeminiToolLifecycle();
    const execute = vi.fn(async () => 'not allowed');
    for (const id of ['', 'x\ny', 'x'.repeat(257)]) {
      expect(await guard.run(id, execute)).toEqual({ status: 'invalid' });
    }
    expect(execute).not.toHaveBeenCalled();
  });
});
