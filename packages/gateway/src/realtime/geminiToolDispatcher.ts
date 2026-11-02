import { z } from 'zod';
import { GeminiToolLifecycle } from './geminiToolLifecycle.js';

const idSchema = z.string().min(1).max(256).refine(value =>
  Array.from(value).every(character => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127));
const callSchema = z.object({ id: idSchema, name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  args: z.record(z.string(), z.unknown()) }).strict();
const callsSchema = z.object({ functionCalls: z.array(callSchema).min(1).max(8) }).strict();
const cancellationSchema = z.object({ ids: z.array(idSchema).min(1).max(8) }).strict();

export interface GeminiToolBinding {
  /** Must strictly validate the tool-specific argument shape. */
  arguments: z.ZodType;
  /** Host-owned authorization remains mandatory before any external action. */
  execute: (arguments_: unknown, signal: AbortSignal) => Promise<unknown>;
}

export type GeminiToolFailure = 'malformed_call' | 'malformed_cancellation' | 'unknown_tool'
  | 'invalid_arguments' | 'queue_limit' | 'lifecycle' | 'result_delivery';

/** Consumes toolCall/toolCallCancellation payloads, not whole server messages.
 * The host must route cancellation immediately, not wait for an active dispatch.
 * No bindings are enabled by default. Never pass model-selected executable code.
 */
export class GeminiToolDispatcher {
  private readonly lifecycle = new GeminiToolLifecycle();
  private readonly pending = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private queuedCalls = 0;
  private failure?: GeminiToolFailure;
  private readonly bindings: ReadonlyMap<string, GeminiToolBinding>;

  constructor(bindings: ReadonlyMap<string, GeminiToolBinding>,
    private readonly send: (message: string) => void) {
    this.bindings = new Map(bindings);
  }

  stop(): void {
    for (const id of this.pending) this.lifecycle.cancel(id);
  }

  get isClosed(): boolean { return this.closed; }
  get hasPendingCalls(): boolean { return this.pending.size > 0; }
  /** Diagnostic category only; never includes arguments, result data, or secrets. */
  get failureReason(): GeminiToolFailure | undefined { return this.failure; }

  private fail(reason: GeminiToolFailure): void {
    this.failure ??= reason;
    this.close();
  }

  close(): void {
    this.closed = true;
    this.lifecycle.close();
    this.pending.clear();
  }

  cancel(payload: unknown): boolean {
    const parsed = cancellationSchema.safeParse(payload);
    if (!parsed.success) { this.fail('malformed_cancellation'); return false; }
    for (const id of parsed.data.ids) this.lifecycle.cancel(id);
    return true;
  }

  dispatch(payload: unknown): Promise<void> {
    if (this.closed) return Promise.resolve();
    const parsed = callsSchema.safeParse(payload);
    if (!parsed.success) { this.fail('malformed_call'); return Promise.resolve(); }
    // Validate the entire batch before allowing its first action to start.
    const calls: Array<z.infer<typeof callSchema> & { arguments: unknown; binding: GeminiToolBinding }> = [];
    try {
      for (const call of parsed.data.functionCalls) {
        const binding = this.bindings.get(call.name);
        if (!binding) { this.fail('unknown_tool'); return Promise.resolve(); }
        if (JSON.stringify(call.args).length > 8192) throw new Error('Invalid call');
        const args = binding.arguments.safeParse(call.args);
        if (!args.success) throw new Error('Invalid arguments');
        calls.push({ ...call, arguments: structuredClone(args.data), binding });
      }
    } catch { this.fail('invalid_arguments'); return Promise.resolve(); }
    if (this.queuedCalls + calls.length > 256) { this.fail('queue_limit'); return Promise.resolve(); }
    this.queuedCalls += calls.length;
    for (const call of calls) this.pending.add(call.id);
    this.tail = this.tail.then(async () => {
      for (const call of calls) {
        if (this.closed) break;
        const result = await this.lifecycle.run(call.id,
          signal => call.binding.execute(call.arguments, signal));
        this.queuedCalls -= 1;
        this.pending.delete(call.id);
        if (this.closed || result.status === 'cancelled' || result.status === 'duplicate') continue;
        if (result.status === 'closed' || result.status === 'invalid') { this.fail('lifecycle'); break; }
        if (!this.lifecycle.allowsResult(call.id)) continue;
        const response = result.status === 'completed' ? { result: result.value } : { error: 'Tool failed; do not retry automatically.' };
        try {
          const message = JSON.stringify({ toolResponse: { functionResponses: [{
            id: call.id, name: call.name, response,
          }] } });
          if (message.length > 32768 || result.status === 'completed' && result.value === undefined) {
            throw new Error('Invalid tool output');
          }
          this.send(message);
        } catch { this.fail('result_delivery'); break; } // Delivery uncertainty must never replay execution.
      }
    });
    return this.tail;
  }
}
