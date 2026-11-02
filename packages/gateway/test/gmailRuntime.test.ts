import { describe, expect, it, vi } from 'vitest';
import { createGmailRuntime } from '../src/email/gmailRuntime.js';

function fixture(clientId = 'fixture.apps.googleusercontent.com') {
  const store = { load: vi.fn(async (): Promise<unknown> => undefined),
    save: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) };
  return { store, runtime: createGmailRuntime({ clientId, store }) };
}
describe('optional Gmail runtime', () => {
  it('does not touch Keychain before listener-owned activation', async () => {
    const { store, runtime } = fixture();
    expect((await runtime.connection.begin(['read'])).ok).toBe(false);
    expect(store.load).not.toHaveBeenCalled();
    await Promise.all([runtime.activate(), runtime.activate()]);
    expect(store.load).toHaveBeenCalledOnce();
    expect((await runtime.connection.disconnectLocal()).ok).toBe(true);
    expect(store.clear).toHaveBeenCalledOnce();
    runtime.close();
  });
  it('isolates storage failure instead of rejecting gateway startup', async () => {
    const { store, runtime } = fixture();
    store.load.mockRejectedValue(new Error('private detail'));
    await expect(runtime.activate()).resolves.toBeUndefined();
    expect((await runtime.connection.begin(['read'])).ok).toBe(false);
    runtime.close();
  });
  it('does not activate after shutdown or invalid configuration', async () => {
    const invalid = fixture('invalid');
    await invalid.runtime.activate();
    expect(invalid.store.load).not.toHaveBeenCalled();
    const closed = fixture();
    closed.runtime.close();
    await closed.runtime.activate();
    expect(closed.store.load).not.toHaveBeenCalled();
  });
  it('discards storage loaded after shutdown', async () => {
    const { store, runtime } = fixture();
    let release!: () => void;
    store.load.mockImplementation(async () => { await new Promise<void>(r => { release = r; }); });
    const activating = runtime.activate();
    runtime.close();
    release();
    await activating;
    expect((await runtime.connection.disconnectLocal()).ok).toBe(false);
    expect(store.clear).not.toHaveBeenCalled();
  });
});
