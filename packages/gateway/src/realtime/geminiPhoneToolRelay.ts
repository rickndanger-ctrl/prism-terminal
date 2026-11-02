import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const sourceSchema = z.object({ turnId: z.uuid(), transcript: z.string().trim().min(1).max(8000) }).strict();
const responseSchema = z.object({ type: z.literal('gemini.toolResult'), requestId: z.uuid(), turnId: z.uuid(), output: z.unknown() }).strict();
interface Pending {
  turnId: string;
  finish(output?: unknown, failure?: string): void;
}

/** Correlated host-to-phone tool requests. Not a model tool registry or approval
 * policy. The host supplies an already accepted captured-speech source and a
 * fixed tool-name allowlist. No retries; cancellation cannot undo completed work. */
export class GeminiPhoneToolRelay {
  private source?: z.infer<typeof sourceSchema>;
  private readonly pending = new Map<string, Pending>();
  private readonly names: ReadonlySet<string>;
  private closed = false;

  constructor(private readonly options: { names: ReadonlySet<string>; send(message: object): void; timeoutMs?: number }) {
    this.names = new Set(options.names);
    if (this.names.size > 64 || [...this.names].some(name => !/^[a-z][a-z0-9_]{0,63}$/.test(name)) ||
        (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 90_000))) {
      throw new Error('Invalid phone relay configuration');
    }
  }

  acceptSource(source: { turnId: string; transcript: string }): void {
    if (this.closed) throw new Error('Phone relay closed');
    const parsed = sourceSchema.parse(source);
    if (this.source?.turnId === parsed.turnId) {
      if (this.source.transcript !== parsed.transcript) throw new Error('Cannot replace accepted speech');
      return;
    }
    this.clearTurn(); this.source = parsed;
  }

  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const source = this.source;
    if (this.closed || !source || signal.aborted || !this.names.has(name) || this.pending.size >= 8) {
      return Promise.reject(new Error('Phone tool unavailable'));
    }
    const requestId = randomUUID();
    let message: object;
    try {
      const serialized = JSON.stringify({ type: 'gemini.toolCall', requestId, turnId: source.turnId,
        name, arguments: args, transcript: source.transcript });
      if (Buffer.byteLength(serialized) > 32768) throw new Error('Too large');
      message = JSON.parse(serialized) as object; // Snapshot caller-owned arguments.
    } catch { return Promise.reject(new Error('Invalid phone tool request')); }
    return new Promise((resolve, reject) => {
      const finish = (output?: unknown, failure?: string) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (failure) {
          try { this.options.send({ type: 'gemini.toolCancelled', requestId, turnId: source.turnId }); } catch { /* no replay */ }
          reject(new Error(failure));
        } else resolve(output);
      };
      const abort = () => finish(undefined, 'Phone tool cancelled');
      const timer = setTimeout(() => finish(undefined, 'Phone tool timed out; completion is unconfirmed'), this.options.timeoutMs ?? 20_000);
      timer.unref();
      this.pending.set(requestId, { turnId: source.turnId, finish });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try { this.options.send(message); } catch { finish(undefined, 'Phone tool delivery failed'); }
    });
  }

  handleResponse(raw: string): boolean {
    if (this.closed || Buffer.byteLength(raw) > 65536) return false;
    let result;
    try { result = responseSchema.safeParse(JSON.parse(raw)); } catch { return false; }
    if (!result.success || !Object.hasOwn(result.data, 'output')) return false;
    const response = result.data;
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.turnId !== response.turnId || this.source?.turnId !== response.turnId) return false;
    pending.finish(response.output);
    return true;
  }

  clearTurn(): void {
    this.source = undefined;
    for (const pending of [...this.pending.values()]) pending.finish(undefined, 'Phone tool cancelled');
  }

  close(): void { this.closed = true; this.clearTurn(); }
}
