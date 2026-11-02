import { describe, expect, it, vi } from 'vitest';
import { createGmailKeychainStore } from '../src/email/gmailKeychain.js';

const grant = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 99999, scopes: ['read'] };
describe('Gmail Keychain protocol', () => {
  it('distinguishes missing credentials from an error', async () => {
    expect(await createGmailKeychainStore(async () => ({ status: 'missing' })).load()).toBeUndefined();
    await expect(createGmailKeychainStore(async () => ({ status: 'keychain_error' })).load()).rejects.toThrow();
  });
  it('loads only a validated grant', async () => {
    expect(await createGmailKeychainStore(async () => ({ status: 'ok', value: grant })).load()).toEqual(grant);
    await expect(createGmailKeychainStore(async () => ({ status: 'ok', value: { accessToken: 'private' } })).load())
      .rejects.toThrow('Gmail Keychain response was invalid');
  });
  it('passes credentials only through the private input payload', async () => {
    const invoke = vi.fn(async () => ({ status: 'ok' }));
    await createGmailKeychainStore(invoke).save(grant);
    expect(invoke).toHaveBeenCalledWith('write', JSON.stringify(grant));
  });
  it('deletes only through the dedicated operation', async () => {
    const invoke = vi.fn(async () => ({ status: 'ok' }));
    await createGmailKeychainStore(invoke).clear();
    expect(invoke).toHaveBeenCalledWith('delete');
  });
  it('refuses malformed save data before invocation', async () => {
    const invoke = vi.fn(async () => ({ status: 'ok' }));
    await expect(createGmailKeychainStore(invoke).save({ ...grant, accessToken: 'bad\nheader' })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('does not treat an unconfirmed save or delete as success', async () => {
    const store = createGmailKeychainStore(async () => ({ status: 'keychain_error', code: -1 }));
    await expect(store.save(grant)).rejects.toThrow('save was not confirmed');
    await expect(store.clear()).rejects.toThrow('deletion was not confirmed');
  });
});
