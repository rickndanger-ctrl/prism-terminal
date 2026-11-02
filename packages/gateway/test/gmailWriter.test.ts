import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@codex-lens/shared';
import { openDb } from '../src/db/schema.js';
import { createGmailIntentStore } from '../src/email/gmailIntentStore.js';
import { createGmailWriter } from '../src/email/gmailWriter.js';

function fixture() {
  const db = openDb(':memory:');
  let revision = 0;
  const account = { revision: () => revision, authorizedScopes: () => ['https://www.googleapis.com/auth/gmail.compose'], accessToken: async () => ok('fixture') };
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'receipt', threadId: 'thread', message: { id: 'message', threadId: 'thread' } })));
  const authorize = vi.fn(async (approval: unknown) => approval === 'approved-fixture');
  const writer = createGmailWriter({ account, fetchImpl, authorize, store: createGmailIntentStore(db),
    identity: async () => ok({ emailAddress: 'verified@example.com', accountBinding: 'b'.repeat(64), revision }) });
  return { db, fetchImpl, authorize, writer, changeAccount: () => { revision += 1; } };
}
const request = (operation: 'send' | 'draft' = 'send') => ({ requestKey: randomUUID(), operation,
  message: { to: ['friend@example.com'], subject: 'Fixture', body: 'Exact approved body' } });
describe('Gmail authorized write orchestration', () => {
  it('releases expired previews without requiring another request', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const f = fixture();
    try {
      const prepared = await f.writer.prepare(request());
      if (!prepared.ok) throw new Error('prepare');
      await vi.advanceTimersByTimeAsync(300001);
      expect(f.writer.status(prepared.value.id)?.state).toBe('rejected');
      // A clock correction cannot resurrect the removed private snapshot.
      vi.setSystemTime(start + 1000);
      expect((await f.writer.execute(prepared.value.id, prepared.value.digest, 'approved-fixture')).ok).toBe(false);
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.fetchImpl).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { await f.writer.close(); f.db.close(); vi.useRealTimers(); }
  });
  it('cancelling during authorization prevents provider dispatch', async () => {
    const f = fixture();
    let release!: (authorized: boolean) => void;
    f.authorize.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    try {
      const prepared = await f.writer.prepare(request());
      if (!prepared.ok) throw new Error('prepare');
      const sending = f.writer.execute(prepared.value.id, prepared.value.digest, 'approved-fixture');
      expect(f.writer.cancel(prepared.value.id)).toBe(true);
      release(true);
      expect((await sending).ok).toBe(false);
      expect(f.fetchImpl).not.toHaveBeenCalled();
    } finally { await f.writer.close(); f.db.close(); }
  });
  it('drains an already dispatched write before shutdown completes', async () => {
    const f = fixture();
    let release!: (response: Response) => void;
    f.fetchImpl.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    try {
      const prepared = await f.writer.prepare(request());
      if (!prepared.ok) throw new Error('prepare');
      const sending = f.writer.execute(prepared.value.id, prepared.value.digest, 'approved-fixture');
      await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
      let stopped = false;
      const closing = f.writer.close().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect((await f.writer.prepare(request())).ok).toBe(false);
      release(new Response(JSON.stringify({ id: 'receipt', threadId: 'thread' })));
      expect((await sending).ok).toBe(true);
      await closing;
      expect(f.writer.status(prepared.value.id)?.state).toBe('accepted');
    } finally { f.db.close(); }
  });
  it('blocks dispatch when shutdown occurs during authorization', async () => {
    const f = fixture();
    let release!: (authorized: boolean) => void;
    f.authorize.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    try {
      const prepared = await f.writer.prepare(request());
      if (!prepared.ok) throw new Error('prepare');
      const sending = f.writer.execute(prepared.value.id, prepared.value.digest, 'approved-fixture');
      const closing = f.writer.close();
      release(true);
      expect((await sending).ok).toBe(false);
      await closing;
      expect(f.fetchImpl).not.toHaveBeenCalled();
      expect(f.writer.status(prepared.value.id)?.state).toBe('rejected');
    } finally { f.db.close(); }
  });
  it('does not dispatch without exact approval', async () => {
    const f = fixture();
    try {
      const prepared = await f.writer.prepare(request());
      if (!prepared.ok) throw new Error('prepare');
      expect((await f.writer.execute(prepared.value.id, prepared.value.digest, 'no')).ok).toBe(false);
      expect(f.fetchImpl).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it('dispatches exactly once under concurrent execution and uses verified sender', async () => {
    const f = fixture();
    try {
      const prepared = await f.writer.prepare(request());
      if (!prepared.ok) throw new Error('prepare');
      const { id, digest } = prepared.value;
      const results = await Promise.all([f.writer.execute(id, digest, 'approved-fixture'), f.writer.execute(id, digest, 'approved-fixture')]);
      expect(results.filter(r => r.ok)).toHaveLength(1);
      expect(f.fetchImpl).toHaveBeenCalledOnce();
      const raw = JSON.parse(String(f.fetchImpl.mock.calls[0]![1]?.body)).raw as string;
      expect(Buffer.from(raw, 'base64url').toString()).toContain('From: verified@example.com');
      expect(f.writer.status(id)?.state).toBe('accepted');
    } finally { f.db.close(); }
  });
  it('keeps a lost provider response uncertain and never retries it', async () => {
    const f = fixture(); f.fetchImpl.mockRejectedValue(new Error('lost response'));
    try {
      const prepared = await f.writer.prepare(request());
      if (!prepared.ok) throw new Error('prepare');
      const { id, digest } = prepared.value;
      expect((await f.writer.execute(id, digest, 'approved-fixture')).ok).toBe(false);
      expect(f.writer.status(id)?.state).toBe('uncertain');
      await f.writer.execute(id, digest, 'approved-fixture');
      expect(f.fetchImpl).toHaveBeenCalledOnce();
    } finally { f.db.close(); }
  });
  it('creates a draft on its own endpoint, not the send endpoint', async () => {
    const f = fixture();
    try {
      const prepared = await f.writer.prepare(request('draft'));
      if (!prepared.ok) throw new Error('prepare');
      await f.writer.execute(prepared.value.id, prepared.value.digest, 'approved-fixture');
      expect(String(f.fetchImpl.mock.calls[0]![0])).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    } finally { f.db.close(); }
  });
  it('invalidates a preparation when the account changes', async () => {
    const f = fixture();
    try {
      const prepared = await f.writer.prepare(request());
      if (!prepared.ok) throw new Error('prepare');
      f.changeAccount();
      expect((await f.writer.execute(prepared.value.id, prepared.value.digest, 'approved-fixture')).ok).toBe(false);
      expect(f.fetchImpl).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
});
