import { createHash, randomUUID } from 'node:crypto';
import { err, ok } from '@codex-lens/shared';
import { z } from 'zod';

// Deliberately requires resolved ASCII mailbox addresses, not contact guesses,
// display-name parsing, address groups or caller-provided MIME headers.
const Address = z.string().max(254).regex(/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u)
  .refine(value => value.split('@')[0]!.length <= 64);
const Input = z.object({
  from: Address, to: z.array(Address).min(1).max(20),
  cc: z.array(Address).max(20).default([]), bcc: z.array(Address).max(20).default([]),
  subject: z.string().max(500).refine(value => value.isWellFormed() && !Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)),
  body: z.string().max(100000).refine(value => value.isWellFormed() && !value.includes('\0')),
}).strict().refine(value => value.to.length + value.cc.length + value.bcc.length <= 20);

function subjectHeader(subject: string): string {
  if (!subject) return 'Subject:';
  const words: string[] = [];
  let chunk = '';
  for (const character of subject) {
    if (Buffer.byteLength(chunk + character) > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`); chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return `Subject: ${words.join('\r\n ')}`;
}

/** Creates local bytes only, never saves or sends. The caller must supply the
 * verified sending account, resolve recipients, persist the entire snapshot,
 * and bind approval to its digest before any provider write. Bcc is private.
 */
export function composeGmailSnapshot(input: unknown, now = new Date()) {
  const parsed = Input.safeParse(input);
  if (!parsed.success || !Number.isFinite(now.getTime())) return err('GMAIL_COMPOSE_INVALID', 'Resolved email addresses, a bounded subject and a plain-text body are required.');
  const content = { ...parsed.data, body: parsed.data.body.replace(/\r\n|\r|\n/gu, '\r\n') };
  const messageId = `<${randomUUID()}@codex-lens.invalid>`;
  const headers = [
    `From: ${content.from}`,
    `To: ${content.to.join(',\r\n ')}`,
    ...(content.cc.length ? [`Cc: ${content.cc.join(',\r\n ')}`] : []),
    ...(content.bcc.length ? [`Bcc: ${content.bcc.join(',\r\n ')}`] : []),
    subjectHeader(content.subject), `Date: ${now.toUTCString()}`, `Message-ID: ${messageId}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
  ];
  const encoded = Buffer.from(content.body).toString('base64');
  const bodyLines = encoded.match(/.{1,76}/gu) ?? [''];
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${bodyLines.join('\r\n')}\r\n`).toString('base64url');
  const digest = createHash('sha256').update(raw).digest('hex');
  return ok({ content, messageId, raw, digest });
}
