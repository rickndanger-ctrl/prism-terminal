import { randomUUID } from 'node:crypto';

export type GatedGeminiOutput = { type: 'audio'; pcm: Buffer }
  | { type: 'outputTranscript'; text: string } | { type: 'turnComplete' };
interface Turn {
  id: string;
  decision: 'pending' | 'allowed' | 'denied';
  queue: GatedGeminiOutput[];
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
  waiters: Set<(allowed: boolean) => void>;
}

/** A transport permission hold, not an attention classifier or action approval.
 * Host decisions are bound to one generated turn ID. No text, audio, or decision
 * is persisted. A stale decision cannot release a newer turn or a cancelled tool.
 */
export class GeminiResponseGate {
  private turn?: Turn;
  constructor(private readonly options: {
    release(turnId: string, output: GatedGeminiOutput): void;
    denied?(turnId: string): void;
  }) {}

  begin(): string {
    this.invalidate();
    this.turn = { id: randomUUID(), decision: 'pending', queue: [], bytes: 0, waiters: new Set() };
    return this.turn.id;
  }

  /** Start the decision deadline only after speech ends, not mid-question. */
  armDeadline(id: string): void {
    const turn = this.turn;
    if (!turn || turn.id !== id || turn.decision !== 'pending' || turn.timer) return;
    turn.timer = setTimeout(() => this.decide(id, false), 10_000);
    turn.timer.unref();
  }

  allows(id: string): boolean { return this.turn?.id === id && this.turn.decision === 'allowed'; }

  decide(id: string, allow: boolean): boolean {
    const turn = this.turn;
    if (!turn || turn.id !== id || turn.decision !== 'pending') return false;
    clearTimeout(turn.timer);
    turn.decision = allow ? 'allowed' : 'denied';
    if (!allow) {
      turn.queue = []; turn.bytes = 0;
      for (const resolve of turn.waiters) resolve(false);
      try { this.options.denied?.(id); } catch { this.invalidate(); }
      return true;
    }
    const queued = turn.queue;
    turn.queue = []; turn.bytes = 0;
    try {
      for (const output of queued) {
        if (!this.allows(id)) return false;
        this.options.release(id, output);
      }
    } catch { this.invalidate(); return false; }
    for (const resolve of turn.waiters) resolve(this.allows(id));
    return this.allows(id);
  }

  push(id: string, output: GatedGeminiOutput): void {
    const turn = this.turn;
    if (!turn || turn.id !== id || turn.decision === 'denied') return;
    if (turn.decision === 'allowed') { this.options.release(id, output); return; }
    const bytes = output.type === 'audio' ? output.pcm.length : output.type === 'outputTranscript' ? Buffer.byteLength(output.text) : 0;
    if (turn.bytes + bytes > 512_000 || turn.queue.length >= 256) { this.decide(id, false); return; }
    turn.bytes += bytes;
    turn.queue.push(output.type === 'audio' ? { ...output, pcm: Buffer.from(output.pcm) } : { ...output });
  }

  waitForPermission(id: string, signal: AbortSignal): Promise<boolean> {
    const turn = this.turn;
    if (signal.aborted || !turn || turn.id !== id || turn.decision === 'denied') return Promise.resolve(false);
    if (turn.decision === 'allowed') return Promise.resolve(true);
    if (turn.waiters.size >= 64) { this.decide(id, false); return Promise.resolve(false); }
    return new Promise(resolve => {
      const finish = (allowed: boolean) => {
        turn.waiters.delete(finish); signal.removeEventListener('abort', abort); resolve(allowed);
      };
      const abort = () => finish(false);
      turn.waiters.add(finish);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  invalidate(): void {
    const turn = this.turn;
    this.turn = undefined;
    if (!turn) return;
    clearTimeout(turn.timer); turn.queue = []; turn.bytes = 0;
    for (const resolve of turn.waiters) resolve(false);
  }
}
