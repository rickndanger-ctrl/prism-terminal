export interface DomainError {
  code: string;
  message: string;
  /**
   * Structured context for failures a message alone cannot hand back — chiefly
   * one that leaves state behind, where a caller needs the thing itself to
   * recover rather than a description of it. Untyped here because only the
   * producing module knows the shape; it publishes a reader for its own codes.
   */
  details?: unknown;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: DomainError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(code: string, message: string, details?: unknown): Result<never> {
  return {
    ok: false,
    // Omitted rather than set to undefined, so an error without context has no
    // `details` key at all and compares equal to one built before this existed.
    error: details === undefined ? { code, message } : { code, message, details },
  };
}
