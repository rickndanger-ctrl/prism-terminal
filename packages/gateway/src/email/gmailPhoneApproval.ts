import { z } from 'zod';
import type { GmailWritePreview } from './gmailWriter.js';

export const GmailPhoneApprovalSchema = z.object({
  kind: z.literal('phone-email-confirmation'), id: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u), operation: z.enum(['draft', 'send']),
  sourceItemId: z.string().min(1).max(256),
  readbackCompletedAt: z.number().finite().nonnegative(),
  confirmedAt: z.number().finite().nonnegative(),
}).strict();

/** Validate the trusted authenticated phone's confirmation record. This is
 * not independent server proof of speech: the phone must run its own exact
 * readback/utterance checks and never accept this object from model arguments.
 */
export function acceptsGmailPhoneApproval(input: unknown, preview: GmailWritePreview, now = Date.now()): boolean {
  const parsed = GmailPhoneApprovalSchema.safeParse(input);
  if (!parsed.success) return false;
  const approval = parsed.data;
  return approval.id === preview.id && approval.digest === preview.digest && approval.operation === preview.operation
    && approval.readbackCompletedAt >= preview.expiresAt - 300000
    && approval.confirmedAt - approval.readbackCompletedAt >= 750
    && approval.confirmedAt <= now && now - approval.confirmedAt <= 30000
    && now < preview.expiresAt;
}
