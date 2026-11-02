/** Connection-local guard, not an authorization policy or durable task store.
 * Create a fresh instance for each Gemini connection. Never replay actions on
 * reconnect. The executor must honor AbortSignal before each external action;
 * abort cannot undo an action already performed.
 */
export type GeminiToolResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'cancelled' | 'duplicate' | 'closed' | 'invalid' | 'failed' };

type Entry = { controller: AbortController; cancelled: boolean };

export class GeminiToolLifecycle {
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(private readonly capacity = 4096) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4096) {
      throw new Error('Invalid Gemini tool capacity');
    }
  }

  private validID(id: string): boolean {
    return typeof id === 'string' && id.length > 0 && id.length <= 256
      && Array.from(id).every(character => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127);
  }

  private reserve(id: string): Entry | undefined {
    if (this.entries.size >= this.capacity) {
      // Retain duplicate/cancellation protection; never evict old IDs to make
      // room and accidentally allow a replay. End this connection instead.
      this.close();
      return undefined;
    }
    const entry = { controller: new AbortController(), cancelled: false };
    this.entries.set(id, entry);
    return entry;
  }

  cancel(id: string): void {
    if (this.closed || !this.validID(id)) return;
    // Tombstone unseen IDs too: cancellation may beat queued dispatch.
    const entry = this.entries.get(id) ?? this.reserve(id);
    if (!entry) return;
    entry.cancelled = true;
    entry.controller.abort();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values()) {
      entry.cancelled = true;
      entry.controller.abort();
    }
    this.entries.clear();
  }

  allowsResult(id: string): boolean {
    const entry = this.entries.get(id);
    return !this.closed && entry !== undefined && !entry.cancelled;
  }

  async run<T>(id: string, execute: (signal: AbortSignal) => Promise<T>): Promise<GeminiToolResult<T>> {
    if (this.closed) return { status: 'closed' };
    if (!this.validID(id)) return { status: 'invalid' };
    const existing = this.entries.get(id);
    if (existing) return { status: existing.cancelled ? 'cancelled' : 'duplicate' };
    const entry = this.reserve(id);
    if (!entry) return { status: 'closed' };
    // A locally requested stop in this tick wins over queued execution.
    await Promise.resolve();
    if (entry.cancelled || this.closed) return { status: 'cancelled' };
    let onAbort!: () => void;
    const cancelled = new Promise<GeminiToolResult<T>>(resolve => {
      onAbort = () => resolve({ status: 'cancelled' });
      entry.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const work = (async (): Promise<GeminiToolResult<T>> => {
        try {
          const value = await execute(entry.controller.signal);
          if (entry.cancelled || this.closed) return { status: 'cancelled' };
          return { status: 'completed', value };
        } catch {
          return { status: entry.cancelled || this.closed ? 'cancelled' : 'failed' };
        }
      })();
      return await Promise.race([work, cancelled]);
    } finally {
      entry.controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
