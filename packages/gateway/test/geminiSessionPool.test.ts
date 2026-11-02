import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiSessionPool, type GeminiSessionFactory } from '../src/realtime/geminiSessionPool.js';

const pools: GeminiSessionPool[] = [];
afterEach(() => { pools.splice(0).forEach(pool => pool.close()); vi.useRealTimers(); });
function setup(answer = vi.fn(async () => 'v=0 answer')) {
  let callbacks!: Parameters<GeminiSessionFactory>[0];
  const close = vi.fn();
  const factory = vi.fn<GeminiSessionFactory>(events => { callbacks = events; return { answer, close }; });
  const pool = new GeminiSessionPool(factory, { setupMs: 1000, maxDurationMs: 5000 });
  pools.push(pool);
  return { pool, factory, answer, close, ready: () => callbacks.ready(), ended: () => callbacks.closed() };
}

describe('Gemini session lifecycle limits', () => {
  it('reserves capacity before starting a session and releases only the exact ID', async () => {
    const s = setup(); const first = await s.pool.start('v=0'); s.ready();
    await expect(s.pool.start('v=0')).rejects.toMatchObject({ kind: 'capacity' });
    expect(s.factory).toHaveBeenCalledOnce();
    expect(s.pool.stop('not-the-session')).toBe(false); expect(s.pool.activeCount).toBe(1);
    expect(s.pool.stop(first.id)).toBe(true); expect(s.close).toHaveBeenCalledOnce();
    expect(s.pool.stop(first.id)).toBe(false); expect(s.pool.activeCount).toBe(0);
  });

  it('ends abandoned signaling even if the session ignores cancellation', async () => {
    vi.useFakeTimers(); const s = setup(vi.fn(() => new Promise<string>(() => {})));
    const attempt = s.pool.start('v=0');
    const rejected = expect(attempt).rejects.toMatchObject({ kind: 'setup' });
    s.ready(); // An early/misbehaving callback cannot disable the SDP deadline.
    await vi.advanceTimersByTimeAsync(1000); await rejected;
    expect(s.close).toHaveBeenCalledOnce(); expect(s.pool.activeCount).toBe(0);
  });

  it('closes an answered offer that never attaches its control channel', async () => {
    vi.useFakeTimers(); const s = setup(); await s.pool.start('v=0');
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.close).toHaveBeenCalledOnce(); expect(s.pool.activeCount).toBe(0);
  });

  it('keeps ready sessions until their hard lifetime limit', async () => {
    vi.useFakeTimers(); const s = setup(); await s.pool.start('v=0'); s.ready();
    await vi.advanceTimersByTimeAsync(1000); expect(s.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000); expect(s.close).toHaveBeenCalledOnce();
  });

  it('stops pending setup immediately on request abort without replay', async () => {
    const s = setup(vi.fn(() => new Promise<string>(() => {})));
    const controller = new AbortController();
    const attempt = s.pool.start('v=0', controller.signal); controller.abort();
    await expect(attempt).rejects.toMatchObject({ kind: 'setup' });
    expect(s.close).toHaveBeenCalledOnce(); expect(s.factory).toHaveBeenCalledOnce();
    expect(s.pool.activeCount).toBe(0);
  });

  it('releases capacity on source closure and refuses starts after shutdown', async () => {
    const s = setup(); await s.pool.start('v=0'); s.ended();
    expect(s.pool.activeCount).toBe(0);
    await s.pool.start('v=0'); s.pool.close();
    expect(s.pool.activeCount).toBe(0); expect(s.pool.available).toBe(false);
    await expect(s.pool.start('v=0')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('sanitizes provider/factory failures and closes invalid SDP answers', async () => {
    const s = setup(vi.fn(async () => 'private invalid SDP'));
    await expect(s.pool.start('v=0')).rejects.toThrow('Gemini session setup');
    expect(s.close).toHaveBeenCalledOnce(); expect(s.pool.activeCount).toBe(0);
  });
});
