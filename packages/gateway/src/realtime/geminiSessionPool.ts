import { randomUUID } from 'node:crypto';

export const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
export interface ManagedGeminiSession { answer(sdp: string): Promise<string>; close(): void }
export type GeminiSessionFactory = (events: { ready(): void; closed(): void }) => ManagedGeminiSession;
export class GeminiPoolError extends Error {
  constructor(readonly kind: 'unavailable' | 'capacity' | 'setup') { super(`Gemini session ${kind}`); }
}
interface Entry {
  session?: ManagedGeminiSession;
  setupTimer?: ReturnType<typeof setTimeout>;
  lifetimeTimer?: ReturnType<typeof setTimeout>;
  reject(error: Error): void;
}

/** The factory is host-owned and must forward session ready/closed events.
 * Reserve capacity before starting any provider or child. No caller-selected
 * models, keys, executable paths, or automatic reconnect/replay in this layer.
 */
export class GeminiSessionPool {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private readonly capacity: number;
  private readonly setupMs: number;
  readonly maxDurationMs: number;

  constructor(private readonly factory: GeminiSessionFactory, options: {
    capacity?: number; setupMs?: number; maxDurationMs?: number;
    isReady?: () => boolean;
  } = {}) {
    this.capacity = options.capacity ?? 1;
    this.isReady = options.isReady ?? (() => true);
    this.setupMs = options.setupMs ?? 30_000;
    this.maxDurationMs = options.maxDurationMs ?? 60 * 60_000;
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 4 ||
        !Number.isInteger(this.setupMs) || this.setupMs < 1000 || this.setupMs > 60_000 ||
        !Number.isInteger(this.maxDurationMs) || this.maxDurationMs < this.setupMs || this.maxDurationMs > 60 * 60_000) {
      throw new Error('Invalid Gemini session limits');
    }
  }

  private readonly isReady: () => boolean;
  get available(): boolean { return !this.closed && this.isReady(); }
  get activeCount(): number { return this.entries.size; }

  async start(sdp: string, signal?: AbortSignal): Promise<{ id: string; sdp: string; expiresAt: string }> {
    if (!this.available) throw new GeminiPoolError('unavailable');
    if (this.entries.size >= this.capacity) throw new GeminiPoolError('capacity');
    if (signal?.aborted || !sdp.startsWith('v=0') || Buffer.byteLength(sdp) > 131072) throw new GeminiPoolError('setup');
    const id = randomUUID();
    let reject!: Entry['reject'];
    const stopped = new Promise<never>((_resolve, fail) => { reject = fail; });
    void stopped.catch(() => {});
    const entry: Entry = { reject };
    this.entries.set(id, entry);
    const stop = () => { this.stop(id); };
    const expiresAt = new Date(Date.now() + this.maxDurationMs).toISOString();
    entry.setupTimer = setTimeout(stop, this.setupMs);
    entry.lifetimeTimer = setTimeout(stop, this.maxDurationMs);
    entry.setupTimer.unref(); entry.lifetimeTimer.unref();
    signal?.addEventListener('abort', stop, { once: true });
    let ready = false;
    let answered = false;
    try {
      const session = this.factory({
        ready: () => { ready = true; if (answered) clearTimeout(entry.setupTimer); },
        closed: stop,
      });
      entry.session = session;
      if (!this.entries.has(id)) { session.close(); throw new GeminiPoolError('setup'); }
      const answer = await Promise.race([session.answer(sdp), stopped]);
      if (!this.entries.has(id) || !answer.startsWith('v=0') || Buffer.byteLength(answer) > 131072) throw new GeminiPoolError('setup');
      answered = true;
      if (ready) clearTimeout(entry.setupTimer);
      return { id, sdp: answer, expiresAt };
    } catch {
      this.stop(id);
      throw new GeminiPoolError('setup');
    } finally { signal?.removeEventListener('abort', stop); }
  }

  stop(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id); // Remove first; closing the session can call us back.
    clearTimeout(entry.setupTimer); clearTimeout(entry.lifetimeTimer);
    entry.reject(new GeminiPoolError('setup'));
    try { entry.session?.close(); } catch { /* other sessions remain independently closable */ }
    return true;
  }

  close(): void {
    this.closed = true;
    for (const id of this.entries.keys()) this.stop(id);
  }
}
