export interface GeminiCapturedSpeech {
  turnId: string;
  pcm: Buffer;
  sampleRate: 16000;
  signal: AbortSignal;
}

/** Opt-in, RAM-only ownership of one actual speech turn. No transcription,
 * persistence, provider calls, or authorization. New speech cancels old work. */
export class GeminiSpeechTurnBuffer {
  private turn?: { id: string; chunks: Buffer[]; bytes: number; ended: boolean; abort: AbortController };

  begin(id: string): void {
    this.cancel();
    this.turn = { id, chunks: [], bytes: 0, ended: false, abort: new AbortController() };
  }

  append(id: string, pcm: Buffer): boolean {
    const turn = this.turn;
    if (!turn || turn.id !== id || turn.ended || turn.abort.signal.aborted) return false;
    if (!pcm.length || pcm.length % 2 || pcm.length > 32000 || turn.bytes + pcm.length > 1_920_000) {
      this.cancel(); return false;
    }
    turn.chunks.push(Buffer.from(pcm));
    turn.bytes += pcm.length;
    return true;
  }

  end(id: string): GeminiCapturedSpeech | undefined {
    const turn = this.turn;
    if (!turn || turn.id !== id || turn.ended || !turn.bytes) return undefined;
    turn.ended = true;
    const pcm = Buffer.concat(turn.chunks, turn.bytes);
    turn.chunks = []; turn.bytes = 0;
    return { turnId: id, pcm, sampleRate: 16000, signal: turn.abort.signal };
  }

  cancel(): void {
    const turn = this.turn;
    this.turn = undefined;
    if (!turn) return;
    turn.chunks = []; turn.bytes = 0;
    turn.abort.abort();
  }
}
