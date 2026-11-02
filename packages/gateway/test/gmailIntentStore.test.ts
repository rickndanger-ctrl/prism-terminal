import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/schema.js';
import { createGmailIntentStore, type GmailIntentInput } from '../src/email/gmailIntentStore.js';

const input = (): GmailIntentInput => ({ id: randomUUID(), requestKey: randomUUID(), digest: 'a'.repeat(64),
  accountBinding: 'b'.repeat(64), operation: 'send', expiresAt: 10000 });
describe('durable Gmail write claims', () => {
  it('allows only one exact account, operation and content claim', () => {
    const db = openDb(':memory:');
    try {
      const store = createGmailIntentStore(db, () => 1000), item = input();
      expect(store.prepare(item)).toBe('created');
      expect(store.prepare(item)).toBe('existing');
      expect(store.prepare({ ...item, digest: 'c'.repeat(64) })).toBe('conflict');
      expect(store.claim(item.id, item.digest, item.accountBinding, 'draft')).toBe(false);
      expect(store.claim(item.id, 'c'.repeat(64), item.accountBinding, 'send')).toBe(false);
      expect(store.claim(item.id, item.digest, 'c'.repeat(64), 'send')).toBe(false);
      expect(store.claim(item.id, item.digest, item.accountBinding, 'send')).toBe(true);
      expect(store.claim(item.id, item.digest, item.accountBinding, 'send')).toBe(false);
      expect(store.finish(item.id, 'accepted', 'gmail-receipt')).toBe(true);
      expect(store.finish(item.id, 'uncertain')).toBe(false);
      expect(store.status(item.id)).toEqual({ state: 'accepted', receiptId: 'gmail-receipt' });
    } finally { db.close(); }
  });
  it('preserves uncertain outcomes across an actual database close and reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lens-gmail-intent-'));
    const path = join(dir, 'test.sqlite');
    const sent = input(), pending = input();
    let db = openDb(path);
    try {
      const first = createGmailIntentStore(db, () => 1000);
      first.prepare(sent); first.prepare(pending);
      first.claim(sent.id, sent.digest, sent.accountBinding, 'send');
      db.close(); db = openDb(path);
      const restarted = createGmailIntentStore(db, () => 2000);
      restarted.recoverOwnedStartup();
      expect(restarted.status(sent.id)?.state).toBe('uncertain');
      expect(restarted.status(pending.id)?.state).toBe('expired');
      expect(restarted.claim(sent.id, sent.digest, sent.accountBinding, 'send')).toBe(false);
      expect(restarted.claim(pending.id, pending.digest, pending.accountBinding, 'send')).toBe(false);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects expired and cancelled preparations and receipt-free success', () => {
    const db = openDb(':memory:');
    try {
      let time = 1000;
      const store = createGmailIntentStore(db, () => time), item = input();
      store.prepare(item); time = 10001;
      expect(store.claim(item.id, item.digest, item.accountBinding, 'send')).toBe(false);
      expect(store.cancel(item.id)).toBe(true);
      expect(() => store.finish(item.id, 'accepted')).toThrow('Invalid Gmail terminal receipt.');
    } finally { db.close(); }
  });
});
