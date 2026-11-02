import { describe, expect, it, vi } from 'vitest';
import { err, ok, type Result } from '@codex-lens/shared';
import { createGmailConnection } from '../src/email/gmailConnection.js';
import type { GoogleGrant } from '../src/email/googleAuthorization.js';

const grant: GoogleGrant = { accessToken: 'private', refreshToken: 'private-refresh',
  expiresAt: 99999999, scopes: ['read'] };
function fixture() {
  let resolve!: (result: Result<GoogleGrant>) => void;
  const flow = { authorizationURL: 'https://accounts.google.com/fixture',
    completion: new Promise<Result<GoogleGrant>>(done => { resolve = done; }), cancel: vi.fn() };
  const account = { connect: vi.fn(async () => ok(undefined)),
    disconnectLocal: vi.fn(async () => ok(undefined)), accessToken: vi.fn(async () => ok('private')) };
  const start = vi.fn(async () => flow);
  return { flow, account, start, resolve,
    connection: createGmailConnection({ account, clientId: 'fixture.apps.googleusercontent.com', start }) };
}
describe('host Gmail connection', () => {
  it('returns no credentials and waits for persistence before declaring success', async () => {
    const f = fixture();
    let saved!: () => void;
    f.account.connect.mockImplementation(async () => { await new Promise<void>(r => { saved = r; }); return ok(undefined); });
    const begun = await f.connection.begin(['read']);
    if (!begun.ok) throw new Error('begin failed');
    f.resolve(ok(grant));
    await Promise.resolve();
    expect(f.account.connect).toHaveBeenCalledWith(grant);
    let finished = false;
    void begun.value.completion.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    saved();
    expect(await begun.value.completion).toEqual(ok(undefined));
    expect(JSON.stringify(begun)).not.toContain('private');
  });
  it('does not save late authorization after disconnect', async () => {
    const f = fixture();
    const begun = await f.connection.begin(['read']);
    if (!begun.ok) throw new Error('begin failed');
    await f.connection.disconnectLocal();
    f.resolve(ok(grant));
    expect((await begun.value.completion).ok).toBe(false);
    expect(f.account.connect).not.toHaveBeenCalled();
    expect(f.account.disconnectLocal).toHaveBeenCalledOnce();
    expect(f.flow.cancel).toHaveBeenCalledOnce();
  });
  it('closes a listener whose startup finishes after cancellation', async () => {
    const f = fixture();
    let release!: () => void;
    f.start.mockImplementation(async () => { await new Promise<void>(r => { release = r; }); return f.flow; });
    const begun = f.connection.begin(['read']);
    f.connection.cancel();
    release();
    expect((await begun).ok).toBe(false);
    expect(f.flow.cancel).toHaveBeenCalledOnce();
  });
  it('reports storage failure instead of a connected account', async () => {
    const f = fixture();
    f.account.connect.mockImplementation(async () => { throw new Error('private detail'); });
    const begun = await f.connection.begin(['read']);
    if (!begun.ok) throw new Error('begin failed');
    f.resolve(ok(grant));
    const result = await begun.value.completion;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('does not save a declined authorization', async () => {
    const f = fixture();
    const begun = await f.connection.begin(['read']);
    if (!begun.ok) throw new Error('begin failed');
    f.resolve(err('GMAIL_AUTH_DENIED', 'Authorization declined.'));
    expect((await begun.value.completion).ok).toBe(false);
    expect(f.account.connect).not.toHaveBeenCalled();
  });
});
