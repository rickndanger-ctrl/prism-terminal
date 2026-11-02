import { err, type Result } from '@codex-lens/shared';

import type { Db } from './schema.js';

/**
 * Runs `fn` inside a SQLite transaction and rolls back unless it returns an
 * ok Result. This lets Result-returning store operations compose atomically:
 * either every write in `fn` commits, or none do.
 */
export function withAtomicResult<T>(db: Db, fn: () => Result<T>): Result<T> {
  let failure: Result<T> | undefined;
  try {
    return db.transaction(() => {
      const result = fn();
      if (!result.ok) {
        failure = result;
        // Throwing makes better-sqlite3 roll the transaction back; the
        // original error Result is re-surfaced from the closure below.
        throw new Error(result.error.message);
      }
      return result;
    })();
  } catch (error) {
    if (failure !== undefined) {
      return failure;
    }
    return err(
      'TRANSACTION_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}
