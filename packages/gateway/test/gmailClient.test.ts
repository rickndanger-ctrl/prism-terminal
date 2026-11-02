import { describe, expect, it, vi } from 'vitest';
import { createGmailClient } from '../src/email/gmailClient.js';

const raw = Buffer.from('Subject: Test\r\n\r\nFixture only.').toString('base64url');
function setup(response: unknown = { id: 'abc', threadId: 'thread1' }, status = 200) {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response), { status }));
  return { fetchImpl, client: createGmailClient({ accessToken: async () => 'fixture-token', fetchImpl }) };
}

describe('Gmail provider boundary', () => {
  it('reads one structured message without fetching its attachments', async () => {
    const { client, fetchImpl } = setup({ id: 'abc', threadId: 'thread1', payload: {
      mimeType: 'text/plain', body: { data: Buffer.from('Hello glasses').toString('base64url') },
    } });
    expect(await client.readText('abc')).toMatchObject({ ok: true, value: { text: 'Hello glasses', untrustedContent: true } });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/abc?format=full');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('requires Google authorization without making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createGmailClient({ accessToken: async () => undefined, fetchImpl });
    expect(await client.search('is:unread')).toMatchObject({ ok: false, error: { code: 'GMAIL_AUTH_REQUIRED' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('bounds search and preserves pagination without crawling', async () => {
    const { client, fetchImpl } = setup({ messages: [{ id: 'abc', threadId: 'thread1' }], nextPageToken: 'next' });
    expect(await client.search('is:unread & from:friend@example.com', 'page')).toMatchObject({ ok: true, value: { nextPageToken: 'next' } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe('https://gmail.googleapis.com');
    expect(parsed.searchParams.get('q')).toBe('is:unread & from:friend@example.com');
    expect(parsed.searchParams.get('maxResults')).toBe('20');
    expect(parsed.searchParams.get('pageToken')).toBe('page');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('labels read email as untrusted content', async () => {
    const { client } = setup({ id: 'abc', threadId: 'thread1', raw });
    expect(await client.readRaw('abc')).toMatchObject({ ok: true, value: { raw, untrustedContent: true } });
  });
  it('rejects a mismatched returned message', async () => {
    const { client } = setup({ id: 'other', threadId: 'thread1', raw });
    expect(await client.readRaw('abc')).toMatchObject({ ok: false, error: { code: 'GMAIL_INVALID_RESPONSE' } });
  });
  it.each(['../profile', 'a?format=full', 'https://evil.test', ''])('rejects unsafe message IDs %s', async id => {
    const { client, fetchImpl } = setup();
    expect((await client.readRaw(id)).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('drafting cannot call send', async () => {
    const { client, fetchImpl } = setup({ id: 'draft1', message: { id: 'abc', threadId: 'thread1' } });
    expect((await client.createDraft(raw)).ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/gmail/v1/users/me/drafts');
    expect(JSON.parse(String(init?.body))).toEqual({ message: { raw } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('sending posts exactly the supplied snapshot once', async () => {
    const { client, fetchImpl } = setup();
    expect((await client.sendRaw(raw)).ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/gmail/v1/users/me/messages/send');
    expect(JSON.parse(String(init?.body))).toEqual({ raw });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each([500, 502, 503])('never retries an uncertain write after HTTP %s', async status => {
    const { client, fetchImpl } = setup({ error: 'private-provider-text' }, status);
    const result = await client.sendRaw(raw);
    expect(result).toMatchObject({ ok: false, error: { code: 'GMAIL_WRITE_OUTCOME_UNCERTAIN' } });
    expect(JSON.stringify(result)).not.toContain('private-provider-text');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('keeps a malformed successful write uncertain', async () => {
    const { client } = setup({ unexpected: true });
    expect(await client.createDraft(raw)).toMatchObject({ ok: false, error: { code: 'GMAIL_WRITE_OUTCOME_UNCERTAIN' } });
  });
  it('does not replay when the connection fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('fixture-token private'); });
    const client = createGmailClient({ accessToken: async () => 'fixture-token', fetchImpl });
    const result = await client.sendRaw(raw);
    expect(result).toMatchObject({ ok: false, error: { code: 'GMAIL_WRITE_OUTCOME_UNCERTAIN' } });
    expect(JSON.stringify(result)).not.toContain('fixture-token');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('rejects an oversized response', async () => {
    const { client } = setup({ raw: 'a'.repeat(1_048_577) });
    expect((await client.readRaw('abc')).ok).toBe(false);
  });
  it.each([[401, 'GMAIL_AUTH_REQUIRED'], [403, 'GMAIL_ACCESS_DENIED'], [429, 'GMAIL_REQUEST_REJECTED']] as const)(
    'reports HTTP %s without replay or upstream private text', async (status, code) => {
      const { client, fetchImpl } = setup({ error: 'private-email-content' }, status);
      const result = await client.sendRaw(raw);
      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(JSON.stringify(result)).not.toContain('private-email-content');
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );
  it('rejects malformed MIME transport data before network access', async () => {
    const { client, fetchImpl } = setup();
    expect((await client.createDraft('not base64\n')).ok).toBe(false);
    expect((await client.sendRaw('')).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects token header injection without disclosing the token', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createGmailClient({ accessToken: async () => 'private\r\ninjected', fetchImpl });
    const result = await client.search('is:unread');
    expect(result).toMatchObject({ ok: false, error: { code: 'GMAIL_AUTH_REQUIRED' } });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
