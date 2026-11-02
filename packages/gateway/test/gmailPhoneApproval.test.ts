import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { acceptsGmailPhoneApproval } from '../src/email/gmailPhoneApproval.js';
import type { GmailWritePreview } from '../src/email/gmailWriter.js';

const preview: GmailWritePreview = { id: randomUUID(), digest: 'a'.repeat(64), operation: 'send', expiresAt: 310000,
  content: { from: 'me@example.com', to: ['friend@example.com'], cc: [], bcc: [], subject: 'Fixture', body: 'Fixture' } };
const approval = { kind: 'phone-email-confirmation', id: preview.id, digest: preview.digest, operation: 'send',
  sourceItemId: 'wearer-turn', readbackCompletedAt: 11000, confirmedAt: 13000 };
describe('authenticated phone email confirmation boundary', () => {
  it('accepts a matching fresh confirmation record', () => {
    expect(acceptsGmailPhoneApproval(approval, preview, 14000)).toBe(true);
  });
  it.each([
    { operation: 'draft' }, { digest: 'b'.repeat(64) }, { id: randomUUID() },
    { confirmedAt: 11500 }, { confirmedAt: 15000 }, { readbackCompletedAt: 9000 },
    { sourceItemId: '' }, { arbitrary: 'extra' },
  ])('rejects mismatched or invalid confirmation %j', change => {
    expect(acceptsGmailPhoneApproval({ ...approval, ...change }, preview, 14000)).toBe(false);
  });
  it('rejects stale and expired confirmations', () => {
    expect(acceptsGmailPhoneApproval(approval, preview, 50000)).toBe(false);
    expect(acceptsGmailPhoneApproval({ ...approval, readbackCompletedAt: 307000, confirmedAt: 309000 }, preview, 310000)).toBe(false);
  });
});
