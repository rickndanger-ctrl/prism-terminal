import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GeminiToolDispatcher, type GeminiToolBinding } from '../src/realtime/geminiToolDispatcher.js';

const call = (id = 'one', args: unknown = { app: 'Calculator' }) => ({
  functionCalls: [{ id, name: 'open_app', args }],
});
function setup(execute = vi.fn<GeminiToolBinding['execute']>(async () => ({ simulated: true }))) {
  const send = vi.fn();
  const dispatcher = new GeminiToolDispatcher(new Map([['open_app', {
    arguments: z.object({ app: z.literal('Calculator') }).strict(), execute,
  }]]), send);
  return { dispatcher, execute, send };
}

describe('Gemini tool message boundary', () => {
  it('returns a correlated tool result and never executes duplicate IDs', async () => {
    const { dispatcher, execute, send } = setup();
    await dispatcher.dispatch(call());
    await dispatcher.dispatch(call());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![0])).toEqual({ toolResponse: { functionResponses: [{
      id: 'one', name: 'open_app', response: { result: { simulated: true } },
    }] } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects the entire batch when one tool or argument is unapproved', async () => {
    for (const bad of [
      { id: 'two', name: 'shell', args: { command: 'anything' } },
      { id: 'two', name: 'open_app', args: { app: 'Calculator', command: 'anything' } },
    ]) {
      const { dispatcher, execute, send } = setup();
      await dispatcher.dispatch({ functionCalls: [...call().functionCalls, bad] });
      expect(dispatcher.isClosed).toBe(true);
      expect(execute).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    }
  });

  it('cancels queued work immediately without a provider round trip', async () => {
    const { dispatcher, execute, send } = setup();
    const pending = dispatcher.dispatch(call());
    dispatcher.stop();
    await pending;
    expect(execute).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('handles provider cancellation before the call is dispatched', async () => {
    const { dispatcher, execute } = setup();
    dispatcher.cancel({ ids: ['one'] });
    await dispatcher.dispatch(call());
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not send a result after the connection closes during execution', async () => {
    let resolve!: (value: unknown) => void;
    let began!: () => void;
    const started = new Promise<void>(done => { began = done; });
    const execute = vi.fn<GeminiToolBinding['execute']>(async () => {
      began(); return new Promise<unknown>(done => { resolve = done; });
    });
    const { dispatcher, send } = setup(execute);
    const pending = dispatcher.dispatch(call()); await started;
    dispatcher.close(); resolve({ late: true }); await pending;
    expect(send).not.toHaveBeenCalled();
  });

  it('does not replay execution after uncertain result delivery', async () => {
    const { dispatcher, execute, send } = setup();
    send.mockImplementation(() => { throw new Error('connection lost'); });
    await dispatcher.dispatch(call()); await dispatcher.dispatch(call());
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('closes rather than retaining an unbounded queued workload', async () => {
    const { dispatcher, execute, send } = setup();
    const pending = Array.from({ length: 257 }, (_, index) => dispatcher.dispatch(call(`call-${index}`)));
    await Promise.all(pending);
    expect(execute).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
});
