import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { composeGmailSnapshot } from '../src/email/gmailCompose.js';

const input = { from: 'me@example.com', to: ['friend@example.com'], subject: 'A café ☕', body: 'Hello\nSecond line' };
describe('exact Gmail MIME snapshot', () => {
  it('round-trips the Unicode body and binds the exact bytes', () => {
    const result = composeGmailSnapshot(input);
    if (!result.ok) throw new Error('compose failed');
    const mime = Buffer.from(result.value.raw, 'base64url').toString();
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(Buffer.from(mime.split('\r\n\r\n')[1]!, 'base64').toString()).toBe('Hello\r\nSecond line');
    expect(result.value.digest).toBe(createHash('sha256').update(result.value.raw).digest('hex'));
    expect(result.value.content.body).toBe('Hello\r\nSecond line');
  });
  it('encodes a long Unicode subject without splitting a character', () => {
    const subject = '🕶 café '.repeat(30);
    const result = composeGmailSnapshot({ ...input, subject });
    if (!result.ok) throw new Error('compose failed');
    const mime = Buffer.from(result.value.raw, 'base64url').toString();
    const words = [...mime.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/gu)];
    expect(words.map(word => Buffer.from(word[1]!, 'base64').toString()).join('')).toBe(subject);
    expect(mime.split('\r\n').every(line => line.length <= 998)).toBe(true);
  });
  it.each([
    { to: ['friend@example.com\r\nBcc: attacker@example.com'] },
    { subject: 'Hello\r\nBcc: attacker@example.com' },
    { from: 'Someone <me@example.com>' }, { to: ['my friend'] },
    { body: 'bad\0text' }, { subject: '\ud800' }, { extraHeader: 'injected' },
  ])('rejects header injection or unresolved input %j', change => {
    expect(composeGmailSnapshot({ ...input, ...change }).ok).toBe(false);
  });
  it('keeps cc and bcc in the approved snapshot without merging them', () => {
    const result = composeGmailSnapshot({ ...input, cc: ['copy@example.com'], bcc: ['private@example.com'] });
    expect(result.ok && result.value.content).toMatchObject({ cc: ['copy@example.com'], bcc: ['private@example.com'] });
  });
  it('uses distinct message identity for distinct preparations', () => {
    const a = composeGmailSnapshot(input), b = composeGmailSnapshot(input);
    expect(a.ok && a.value.messageId).not.toBe(b.ok && b.value.messageId);
  });
});
