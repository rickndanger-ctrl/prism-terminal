import { describe, expect, it, vi } from 'vitest';
import { refreshGoogleGrant } from '../src/email/googleRefresh.js';

const grant = { accessToken: 'old', refreshToken: 'fixture-refresh', expiresAt: 10,
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'] };
function setup(body: unknown = { access_token: 'new', expires_in: 3600, token_type: 'Bearer' }, status = 200) {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  return { fetchImpl, options: { clientId: 'fixture.apps.googleusercontent.com', fetchImpl, now: () => 1000 } };
}
describe('Google refresh boundary', () => {
  it('retains the refresh token when Google only returns a new access token', async () => {
    const { options, fetchImpl } = setup();
    expect(await refreshGoogleGrant(grant, options)).toEqual({ ok: true, value: { ...grant, accessToken: 'new', expiresAt: 3601000 } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init?.redirect).toBe('error');
    expect(new URLSearchParams(String(init?.body)).get('grant_type')).toBe('refresh_token');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('accepts rotation and reduced scopes without inventing permissions', async () => {
    const { options } = setup({ access_token: 'new', refresh_token: 'rotated', expires_in: 120, token_type: 'Bearer', scope: grant.scopes[0] });
    const result = await refreshGoogleGrant({ ...grant, scopes: [...grant.scopes, 'another-scope'] }, options);
    expect(result).toMatchObject({ ok: true, value: { refreshToken: 'rotated', scopes: grant.scopes } });
  });
  it('rejects expanded permissions', async () => {
    const { options } = setup({ access_token: 'new', expires_in: 120, token_type: 'Bearer', scope: 'unexpected' });
    expect(await refreshGoogleGrant(grant, options)).toMatchObject({ ok: false, error: { code: 'GMAIL_REFRESH_SCOPE_CHANGED' } });
  });
  it('requires reconnect after invalid_grant without leaking provider details', async () => {
    const { options, fetchImpl } = setup({ error: 'invalid_grant', error_description: 'private-details' }, 400);
    const result = await refreshGoogleGrant(grant, options);
    expect(result).toMatchObject({ ok: false, error: { code: 'GMAIL_AUTH_REQUIRED' } });
    expect(JSON.stringify(result)).not.toContain('private-details');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('does not dispatch after cancellation', async () => {
    const { options, fetchImpl } = setup();
    expect((await refreshGoogleGrant(grant, { ...options, signal: AbortSignal.abort() })).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('discards a successful response that arrives after cancellation', async () => {
    const abort = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      abort.abort();
      return new Response(JSON.stringify({ access_token: 'late', expires_in: 120, token_type: 'Bearer' }));
    });
    expect(await refreshGoogleGrant(grant, { clientId: 'fixture.apps.googleusercontent.com', fetchImpl, signal: abort.signal }))
      .toMatchObject({ ok: false, error: { code: 'GMAIL_REFRESH_CANCELLED' } });
  });
  it.each([{}, { access_token: 'bad\nheader', expires_in: 120, token_type: 'Bearer' },
    { access_token: 'new', expires_in: -1, token_type: 'Bearer' }])('rejects malformed grants %#', async body => {
    expect((await refreshGoogleGrant(grant, setup(body).options)).ok).toBe(false);
  });
  it('bounds oversized responses and does not retry server failures', async () => {
    for (const { options, fetchImpl } of [setup({ value: 'x'.repeat(65537) }), setup({ error: 'private' }, 503)]) {
      expect((await refreshGoogleGrant(grant, options)).ok).toBe(false);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });
});
