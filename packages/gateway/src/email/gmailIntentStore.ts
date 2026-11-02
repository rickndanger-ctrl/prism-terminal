import { z } from 'zod';
import type { Db } from '../db/schema.js';

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Input = z.object({ id: z.uuid(), requestKey: z.uuid(), digest: Hash, accountBinding: Hash,
  operation: z.enum(['draft', 'send']), expiresAt: z.number().int().positive() }).strict();
export type GmailIntentInput = z.infer<typeof Input>;
export type GmailIntentState = 'prepared' | 'submitting' | 'accepted' | 'uncertain' | 'rejected' | 'expired';
type Row = { id: string; request_key: string; digest: string; account_binding: string;
  operation: 'draft' | 'send'; state: GmailIntentState; expires_at: number; receipt_id: string | null };

/** Metadata only: no recipient, body, raw MIME or credential in this table.
 * The trusted service keeps exact prepared bytes in memory. On restart those
 * preparations expire; dispatched-but-unfinished operations become uncertain.
 * This store does NOT authorize a user action or call Gmail itself.
 */
export function createGmailIntentStore(db: Db, now: () => number = Date.now) {
  const get = (id: string) => db.prepare('SELECT * FROM gmail_write_intents WHERE id = ?').get(id) as Row | undefined;
  return {
    prepare(input: GmailIntentInput): 'created' | 'existing' | 'conflict' {
      const parsed = Input.safeParse(input);
      if (!parsed.success || input.expiresAt <= now() || input.expiresAt > now() + 600000) throw new Error('Invalid Gmail preparation metadata.');
      return db.transaction(() => {
        const previous = db.prepare('SELECT * FROM gmail_write_intents WHERE request_key = ?').get(input.requestKey) as Row | undefined;
        if (previous) return previous.id === input.id && previous.digest === input.digest
          && previous.account_binding === input.accountBinding && previous.operation === input.operation
          && previous.expires_at === input.expiresAt ? 'existing' as const : 'conflict' as const;
        if (get(input.id)) return 'conflict' as const;
        db.prepare(`INSERT INTO gmail_write_intents (id, request_key, digest, account_binding, operation, state, expires_at)
          VALUES (?, ?, ?, ?, ?, 'prepared', ?)`).run(input.id, input.requestKey, input.digest, input.accountBinding, input.operation, input.expiresAt);
        return 'created' as const;
      })();
    },
    status(id: string): { state: GmailIntentState; receiptId?: string } | undefined {
      const row = get(id);
      if (!row) return undefined;
      return { state: row.state, ...(row.receipt_id ? { receiptId: row.receipt_id } : {}) };
    },
    /** Call only AFTER wearer authorization and exact-byte validation. Atomic
     * claim must commit before the single provider write is dispatched. */
    claim(id: string, digest: string, accountBinding: string, operation: 'draft' | 'send'): boolean {
      return db.prepare(`UPDATE gmail_write_intents SET state = 'submitting'
        WHERE id = ? AND digest = ? AND account_binding = ? AND operation = ?
        AND state = 'prepared' AND expires_at > ?`).run(id, digest, accountBinding, operation, now()).changes === 1;
    },
    finish(id: string, state: 'accepted' | 'uncertain' | 'rejected', receiptId?: string): boolean {
      if (!['accepted', 'uncertain', 'rejected'].includes(state)
        || (state === 'accepted' ? !receiptId || !/^[A-Za-z0-9_-]{1,256}$/u.test(receiptId) : receiptId !== undefined)) {
        throw new Error('Invalid Gmail terminal receipt.');
      }
      return db.prepare(`UPDATE gmail_write_intents SET state = ?, receipt_id = ? WHERE id = ? AND state = 'submitting'`)
        .run(state, receiptId ?? null, id).changes === 1;
    },
    cancel(id: string): boolean {
      return db.prepare("UPDATE gmail_write_intents SET state = 'rejected' WHERE id = ? AND state = 'prepared'").run(id).changes === 1;
    },
    /** Only the newly acquired canonical listener owner may run recovery. */
    recoverOwnedStartup(): void {
      db.transaction(() => {
        db.prepare("UPDATE gmail_write_intents SET state = 'expired' WHERE state = 'prepared'").run();
        db.prepare("UPDATE gmail_write_intents SET state = 'uncertain' WHERE state = 'submitting'").run();
      })();
    },
  };
}
