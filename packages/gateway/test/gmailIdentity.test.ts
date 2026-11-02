import { describe, expect, it, vi } from 'vitest';
import { ok } from '@codex-lens/shared';
import { createGmailIdentity } from '../src/email/gmailIdentity.js';

describe('verified Gmail account identity', () => {
  it('gets the authenticated profile and omits mailbox statistics', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ emailAddress: 'owner@example.com', messagesTotal: 999, historyId: 'private-history' })));
    const account = { revision: () => 0, authorizedScopes: () => ['https://www.googleapis.com/auth/gmail.compose'], accessToken: vi.fn(async () => ok('fixture')) };
    const result = await createGmailIdentity({ account, fetchImpl })();
    expect(result).toMatchObject({ ok: true, value: { emailAddress: 'owner@example.com', revision: 0 } });
    expect(JSON.stringify(result)).not.toContain('private-history');
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    expect(account.accessToken).toHaveBeenCalledWith(['https://www.googleapis.com/auth/gmail.compose']);
  });
  it('does not silently expand send-only permission', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const account = { revision: () => 0, authorizedScopes: () => ['https://www.googleapis.com/auth/gmail.send'], accessToken: vi.fn(async () => ok('fixture')) };
    expect((await createGmailIdentity({ account, fetchImpl })()).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(account.accessToken).not.toHaveBeenCalled();
  });
  it('discards identity from an account disconnected during the request', async () => {
    let revision = 0;
    const account = { revision: () => revision, authorizedScopes: () => ['https://www.googleapis.com/auth/gmail.readonly'], accessToken: async () => ok('fixture') };
    const fetchImpl = vi.fn<typeof fetch>(async () => { revision += 1; return new Response(JSON.stringify({ emailAddress: 'old@example.com' })); });
    const result = await createGmailIdentity({ account, fetchImpl })();
    expect(result).toMatchObject({ ok: false, error: { code: 'GMAIL_ACCOUNT_CHANGED' } });
    expect(JSON.stringify(result)).not.toContain('old@example.com');
  });
});
