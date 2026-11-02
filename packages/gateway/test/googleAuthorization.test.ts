import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createGoogleAuthorization } from '../src/email/googleAuthorization.js';

const redirectURI = 'http://127.0.0.1:49123/oauth/callback';
const scope = 'https://www.googleapis.com/auth/gmail.readonly';
function setup(body: unknown = { access_token: 'fixture-access', refresh_token: 'fixture-refresh',
  expires_in: 3600, token_type: 'Bearer', scope }) {
  let time = 1000;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body)));
  const auth = createGoogleAuthorization({ clientId: 'fixture.apps.googleusercontent.com', redirectURI,
    fetchImpl, now: () => time });
  const url = new URL(auth.begin(['read']));
  const callback = `${redirectURI}?${new URLSearchParams({ state: url.searchParams.get('state')!, code: 'fixture-code' })}`;
  return { auth, url, callback, fetchImpl, expire: () => { time += 300000; } };
}
describe('Google desktop authorization', () => {
  it('requests only selected scopes and recognizes compose includes send', () => {
    const { auth } = setup();
    const url = new URL(auth.begin(['read', 'draft', 'send']));
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      scope, 'https://www.googleapis.com/auth/gmail.compose',
    ]);
    expect(() => auth.begin([])).toThrow();
  });
  it('binds an unpredictable S256 verifier to the exact exchange', async () => {
    const { auth, url, callback, fetchImpl } = setup();
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe(scope);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('select_account consent');
    expect((await auth.complete(callback)).ok).toBe(true);
    const [endpoint, init] = fetchImpl.mock.calls[0]!;
    expect(endpoint).toBe('https://oauth2.googleapis.com/token');
    expect(init?.redirect).toBe('error');
    const form = new URLSearchParams(String(init?.body));
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(form.get('redirect_uri')).toBe(redirectURI);
  });
  it.each(['http://example.com:123/a', 'http://localhost:123/a', 'https://127.0.0.1:123/a',
    'http://127.0.0.1/a', 'http://user@127.0.0.1:123/a', 'http://127.0.0.1:123/a?x=1'])(
    'rejects non-owned redirect forms %s', value => {
      expect(() => createGoogleAuthorization({ clientId: 'fixture.apps.googleusercontent.com', redirectURI: value })).toThrow();
    });
  it('refuses forged state but preserves the valid pending request', async () => {
    const { auth, callback, fetchImpl } = setup();
    expect((await auth.complete(callback.replace('state=', 'state=forged'))).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await auth.complete(callback)).ok).toBe(true);
  });
  it('consumes a valid callback before concurrent exchanges', async () => {
    const { auth, callback, fetchImpl } = setup();
    const results = await Promise.all([auth.complete(callback), auth.complete(callback)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each(['cancel', 'replace'])('discards an in-flight grant after %s', async action => {
    let finish!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; }));
    const auth = createGoogleAuthorization({ clientId: 'fixture.apps.googleusercontent.com', redirectURI, fetchImpl });
    const url = new URL(auth.begin(['read']));
    const completion = auth.complete(`${redirectURI}?state=${url.searchParams.get('state')}&code=fixture`);
    if (action === 'cancel') auth.cancel(); else auth.begin(['send']);
    finish(new Response(JSON.stringify({ access_token: 'fixture', refresh_token: 'fixture-refresh',
      expires_in: 3600, token_type: 'Bearer', scope })));
    expect(await completion).toMatchObject({ ok: false, error: { code: 'GMAIL_AUTH_SUPERSEDED' } });
  });
  it('rejects expiry, cancellation and replaced transactions', async () => {
    const expired = setup(); expired.expire();
    expect((await expired.auth.complete(expired.callback)).ok).toBe(false);
    const cancelled = setup(); cancelled.auth.cancel();
    expect((await cancelled.auth.complete(cancelled.callback)).ok).toBe(false);
    const replaced = setup(); replaced.auth.begin(['send']);
    expect((await replaced.auth.complete(replaced.callback)).ok).toBe(false);
    for (const fixture of [expired, cancelled, replaced]) expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['&state=duplicate', '&code=duplicate', '&error=access_denied'])('refuses ambiguous or denied callbacks %s', async suffix => {
    const { auth, callback, fetchImpl } = setup();
    expect((await auth.complete(callback + suffix)).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([{}, { access_token: 'private', token_type: 'Bearer', expires_in: 3600, scope },
    { access_token: 'private', refresh_token: 'secret', token_type: 'Bearer', expires_in: 3600, scope: 'unrelated' }])(
    'rejects incomplete grants without leaking tokens %#', async body => {
      const { auth, callback } = setup(body);
      const result = await auth.complete(callback);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('private');
      expect(JSON.stringify(result)).not.toContain('secret');
    });
});
