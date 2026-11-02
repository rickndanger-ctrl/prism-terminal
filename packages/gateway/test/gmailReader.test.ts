import { describe, expect, it, vi } from 'vitest';
import { ok } from '@codex-lens/shared';
import { openGmailAccount } from '../src/email/gmailAccount.js';
import { createGmailReader } from '../src/email/gmailReader.js';

async function fixture(scopes = ['https://www.googleapis.com/auth/gmail.readonly']) {
  const account = await openGmailAccount({ store: { load: async () => ({ accessToken: 'fixture', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000, scopes }),
    save: async () => undefined, clear: async () => undefined }, refresh: async grant => ok(grant) });
  return account;
}
describe('authorized Gmail reader', () => {
  it('returns extracted HTML through the authorized provider path without loading its URLs', async () => {
    const account = await fixture();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'one', threadId: 'thread', payload: { mimeType: 'text/html', body: {
        data: Buffer.from('<h1>Receipt</h1><p>Total: $29</p><img src="https://tracking.example">').toString('base64url'),
      } },
    })));
    try {
      const result = await createGmailReader({ account, fetchImpl }).readText('one');
      expect(result).toMatchObject({ ok: true, value: { contentKind: 'html-text', untrustedContent: true, omittedParts: true } });
      expect(result.ok && result.value.text).toContain('Total: $29');
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(String(fetchImpl.mock.calls[0]![0])).toContain('gmail.googleapis.com/gmail/v1/users/me/messages/one');
      expect(String(fetchImpl.mock.calls[0]![0])).toContain('format=full');
    } finally { await account.close(); }
  });
  it('checks read scope before making any provider call', async () => {
    const account = await fixture(['https://www.googleapis.com/auth/gmail.send']);
    const fetchImpl = vi.fn<typeof fetch>();
    const reader = createGmailReader({ account, fetchImpl });
    expect((await reader.search('is:unread')).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('discards a response completed after disconnect', async () => {
    const account = await fixture();
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve; }));
    const reader = createGmailReader({ account, fetchImpl });
    const pending = reader.search('is:unread');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await account.disconnectLocal();
    release(new Response(JSON.stringify({ messages: [{ id: 'private-old', threadId: 'old' }] })));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { code: 'GMAIL_ACCOUNT_CHANGED' } });
    expect(JSON.stringify(result)).not.toContain('private-old');
  });
  it('returns one bounded authorized search', async () => {
    const account = await fixture();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ messages: [{ id: 'one', threadId: 'thread' }] })));
    expect(await createGmailReader({ account, fetchImpl }).search('is:unread')).toMatchObject({ ok: true, value: { messages: [{ id: 'one' }] } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
