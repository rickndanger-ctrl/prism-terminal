import { err, ok } from '@codex-lens/shared';
import { z } from 'zod';
import { gmailHtmlText } from './gmailHtmlText.js';

const Header = z.object({ name: z.string().max(256), value: z.string().max(8192) });
const Part = z.object({ mimeType: z.string().max(256), filename: z.string().max(1024).optional(),
  headers: z.array(Header).max(200).default([]),
  body: z.object({ data: z.string().max(1_048_576).optional(), attachmentId: z.string().max(4096).optional() }).optional(),
  parts: z.array(z.unknown()).max(100).optional() });
export const GmailFullMessageSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u),
  threadId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u),
  snippet: z.string().max(8192).optional(), payload: z.unknown(),
});

function clean(value: string): string {
  return Array.from(value).filter(c => c === '\n' || c === '\t' || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)).join('');
}

/** Extract inline plain text or inert HTML text. No HTML rendering, attachment request,
 * external image load, script execution or recursive attached-message reading.
 * A preview is labelled as a preview, never passed off as the complete email.
 */
export function readableGmailMessage(input: unknown) {
  const message = GmailFullMessageSchema.safeParse(input);
  const invalid = () => err('GMAIL_CONTENT_INVALID', 'This email could not be decoded safely.');
  if (!message.success) return invalid();
  const root = Part.safeParse(message.data.payload);
  if (!root.success) return invalid();
  let visited = 0;
  type Extracted = { text: string; html: boolean; truncated: boolean; omitted: boolean };
  const empty = (): Extracted => ({ text: '', html: false, truncated: false, omitted: true });
  function extract(input: unknown, depth: number): Extracted {
    if (++visited > 100 || depth > 8) throw new Error('MIME complexity limit');
    const parsed = Part.safeParse(input);
    if (!parsed.success) throw new Error('Invalid MIME part');
    const part = parsed.data;
    const mime = part.mimeType.toLowerCase();
    const disposition = part.headers.find(h => h.name.toLowerCase() === 'content-disposition')?.value ?? '';
    if (part.filename || /^attachment\b/iu.test(disposition) || mime === 'message/rfc822') {
      return empty();
    }
    if (mime.startsWith('multipart/')) {
      const children = (part.parts ?? []).map(child => extract(child, depth + 1));
      // Alternatives represent the same body. Prefer plain text and never
      // read both copies aloud; mixed/related siblings remain independent.
      if (mime === 'multipart/alternative') {
        return children.find(child => child.text.trim() && !child.html) ?? children.find(child => child.text.trim())
          ?? { ...empty(), truncated: children.some(child => child.truncated) };
      }
      const joined = children.map(child => child.text).filter(Boolean).join('\n');
      return { text: joined.slice(0, 16000), html: children.some(child => child.html && child.text.length > 0),
        truncated: joined.length > 16000 || children.some(child => child.truncated), omitted: children.some(child => child.omitted) };
    }
    if (!['text/plain', 'text/html'].includes(mime) || part.body?.attachmentId) return empty();
    const data = part.body?.data ?? '';
    if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(data) || data.replace(/=+$/u, '').length % 4 === 1) throw new Error('Invalid body encoding');
    try {
      const contentType = part.headers.find(h => h.name.toLowerCase() === 'content-type')?.value ?? '';
      const charset = /charset\s*=\s*"?([^";\s]+)/iu.exec(contentType)?.[1] ?? 'utf-8';
      const decoded = clean(new TextDecoder(charset, { fatal: true }).decode(Buffer.from(data, 'base64url')));
      if (mime === 'text/html') return { ...gmailHtmlText(decoded), html: true };
      return { text: decoded.slice(0, 16000), html: false, truncated: decoded.length > 16000, omitted: false };
    } catch { return empty(); }
  }
  let extracted: Extracted;
  try { extracted = extract(message.data.payload, 0); } catch { return invalid(); }
  const body = clean(extracted.text).trim();
  const header = (name: string) => clean(root.data.headers.find(h => h.name.toLowerCase() === name)?.value ?? '').slice(0, 2000);
  return ok({ id: message.data.id, threadId: message.data.threadId,
    from: header('from'), to: header('to'), subject: header('subject'), date: header('date'),
    text: body || clean(message.data.snippet ?? ''),
    contentKind: body ? extracted.html ? 'html-text' as const : 'plain-text' as const : message.data.snippet ? 'preview-only' as const : 'unavailable' as const,
    truncated: extracted.truncated, omittedParts: extracted.omitted, untrustedContent: true as const });
}
