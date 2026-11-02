import { describe, expect, it, vi } from 'vitest';
import { ok } from '@codex-lens/shared';
import { openGmailAccount, type GmailCredentialStore } from '../src/email/gmailAccount.js';
import type { GoogleGrant } from '../src/email/googleAuthorization.js';

const grant: GoogleGrant = { accessToken: 'old', refreshToken: 'renew', expiresAt: 1, scopes: ['read'] };
const fresh: GoogleGrant = { ...grant, accessToken: 'fresh', expiresAt: 999999 };
function store(initial: GoogleGrant | undefined = grant) {
  let value: GoogleGrant | undefined = initial;
  const vault: GmailCredentialStore = {
    load: vi.fn(async () => value),
    save: vi.fn(async next => { value = structuredClone(next); }),
    clear: vi.fn(async () => { value = undefined; }),
  };
  return { vault, value: () => value };
}
describe('Gmail account lifecycle', () => {
  it('coalesces concurrent refreshes and persists before releasing access', async () => {
    const { vault, value } = store();
    const refresh = vi.fn(async () => ok(fresh));
    const account = await openGmailAccount({ store: vault, refresh, now: () => 100 });
    expect(await Promise.all([account.accessToken(['read']), account.accessToken(['read'])]))
      .toEqual([ok('fresh'), ok('fresh')]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(vault.save).toHaveBeenCalledOnce();
    expect(value()).toEqual(fresh);
  });
  it('never reconnects from a refresh that finishes after disconnect', async () => {
    let release!: (value: ReturnType<typeof ok<GoogleGrant>>) => void;
    const { vault, value } = store();
    const account = await openGmailAccount({ store: vault, now: () => 100,
      refresh: () => new Promise(resolve => { release = resolve; }) });
    const pending = account.accessToken(['read']);
    expect((await account.disconnectLocal()).ok).toBe(true);
    release(ok(fresh));
    expect((await pending).ok).toBe(false);
    expect(value()).toBeUndefined();
    expect(vault.save).not.toHaveBeenCalled();
  });
  it('never overwrites a replacement account with an old refresh', async () => {
    let release!: (value: ReturnType<typeof ok<GoogleGrant>>) => void;
    const { vault, value } = store();
    const account = await openGmailAccount({ store: vault, now: () => 100,
      refresh: () => new Promise(resolve => { release = resolve; }) });
    const pending = account.accessToken(['read']);
    const replacement = { ...fresh, accessToken: 'replacement-account' };
    expect((await account.connect(replacement)).ok).toBe(true);
    release(ok(fresh));
    expect((await pending).ok).toBe(false);
    expect(value()).toEqual(replacement);
    expect(await account.accessToken(['read'])).toEqual(ok('replacement-account'));
  });
  it('clears storage after an already-started write finishes', async () => {
    let release!: () => void;
    let started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    const { vault, value } = store();
    const save = vault.save;
    vault.save = async next => { started(); await new Promise<void>(resolve => { release = resolve; }); await save(next); };
    const account = await openGmailAccount({ store: vault, refresh: async () => ok(fresh), now: () => 100 });
    const connecting = account.connect(fresh);
    await writing;
    const disconnecting = account.disconnectLocal();
    expect((await account.accessToken(['read'])).ok).toBe(false);
    release();
    expect((await connecting).ok).toBe(false);
    expect((await disconnecting).ok).toBe(true);
    expect(value()).toBeUndefined();
  });
  it('does not release tokens after a storage failure', async () => {
    const { vault } = store();
    vault.save = async () => { throw new Error('private-secret'); };
    const account = await openGmailAccount({ store: vault, refresh: async () => ok(fresh), now: () => 100 });
    const result = await account.accessToken(['read']);
    expect(result).toMatchObject({ ok: false, error: { code: 'GMAIL_STORAGE_FAILED' } });
    expect(JSON.stringify(result)).not.toContain('private-secret');
    expect((await account.accessToken(['read'])).ok).toBe(false);
  });
  it('reports failed durable deletion honestly and stays disabled', async () => {
    const { vault } = store(fresh);
    vault.clear = async () => { throw new Error('private'); };
    const account = await openGmailAccount({ store: vault, refresh: async () => ok(fresh), now: () => 100 });
    expect(await account.disconnectLocal()).toMatchObject({ ok: false, error: { code: 'GMAIL_DISCONNECT_UNCONFIRMED' } });
    expect((await account.accessToken(['read'])).ok).toBe(false);
  });
  it('still clears old credentials if a newer connection fails to save', async () => {
    const { vault, value } = store(fresh);
    vault.save = async () => { throw new Error('save failed'); };
    const account = await openGmailAccount({ store: vault, refresh: async () => ok(fresh), now: () => 100 });
    const disconnecting = account.disconnectLocal();
    const connecting = account.connect({ ...fresh, accessToken: 'new-account' });
    await disconnecting;
    expect((await connecting).ok).toBe(false);
    expect(vault.clear).toHaveBeenCalledOnce();
    expect(value()).toBeUndefined();
  });
  it('checks scopes before and after refresh', async () => {
    const { vault } = store();
    const refresh = vi.fn(async () => ok({ ...fresh, scopes: ['different'] }));
    const account = await openGmailAccount({ store: vault, refresh, now: () => 100 });
    expect((await account.accessToken(['send'])).ok).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect((await account.accessToken(['read'])).ok).toBe(false);
    expect(vault.save).not.toHaveBeenCalled();
  });
  it('fails closed on malformed stored credentials', async () => {
    const { vault } = store(); vault.load = async () => ({ accessToken: 'private' });
    await expect(openGmailAccount({ store: vault, refresh: async () => ok(fresh) })).rejects.toThrow('Stored Gmail credentials are invalid');
  });
});
