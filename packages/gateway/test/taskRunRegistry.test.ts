import { describe, expect, it, vi } from 'vitest';

import type { AppServerHandle } from '../src/codex/transport.js';
import { TaskRunRegistry } from '../src/runner/taskRunRegistry.js';

function fakeClient(close: () => Promise<void>): AppServerHandle {
  return {
    send: async () => undefined,
    onMessage: () => () => undefined,
    close,
    [Symbol.asyncIterator]() {
      return { next: async () => ({ value: undefined, done: true as const }) };
    },
  };
}

describe('TaskRunRegistry', () => {
  it('closes the real app-server handle when a running task is paused', async () => {
    const close = vi.fn(async () => undefined);
    const registry = new TaskRunRegistry();
    registry.begin('task-1');
    registry.attach('task-1', fakeClient(close));
    await expect(registry.stop('task-1', 'paused')).resolves.toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(registry.intent('task-1')).toBe('paused');
  });

  it('closes immediately when control arrives before the process attaches', async () => {
    const close = vi.fn(async () => undefined);
    const registry = new TaskRunRegistry();
    registry.begin('task-1');
    await registry.stop('task-1', 'cancelled');
    registry.attach('task-1', fakeClient(close));
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
