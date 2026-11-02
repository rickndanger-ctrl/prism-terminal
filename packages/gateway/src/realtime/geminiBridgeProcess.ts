import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('answer'), sdp: z.string().startsWith('v=0').max(131072) }).strict(),
  z.object({ type: z.literal('inputAudio'), pcm: z.string().max(42668) }).strict(),
  z.object({ type: z.literal('control'), message: z.string().max(65536) }).strict(),
  z.object({ type: z.literal('state'), state: z.enum(['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed', 'controlReady']) }).strict(),
  z.object({ type: z.literal('closed') }).strict(),
  z.object({ type: z.literal('activityStart') }).strict(),
  z.object({ type: z.literal('activityEnd'), reason: z.enum(['silence', 'limit']) }).strict(),
]);
export type GeminiBridgeEvent =
  | { type: 'inputAudio'; pcm: Buffer }
  | { type: 'control'; message: string }
  | { type: 'state'; state: string }
  | { type: 'activityStart' }
  | { type: 'activityEnd'; reason: 'silence' | 'limit' }
  | { type: 'closed'; reason: 'local' | 'exit' | 'protocol' | 'timeout' | 'backpressure' | 'spawn' };

/** Host configuration only. Never construct this from model/phone-selected paths.
 * One child per authenticated session; no shell, inherited API keys, or retries.
 */
export class GeminiBridgeProcess {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: { resolve(sdp: string): void; reject(error: Error): void };
  private buffer = '';
  private closed = false;
  private started = false;
  private answered = false;
  private offerTimer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: {
    pythonExecutable: string;
    entrypoint?: string;
    detectSpeech?: boolean;
    onEvent(event: GeminiBridgeEvent): void;
  }) {
    if (!isAbsolute(options.pythonExecutable) || options.entrypoint && !isAbsolute(options.entrypoint)) {
      throw new Error('Bridge runtime paths must be absolute');
    }
  }

  answer(sdp: string): Promise<string> {
    if (this.closed || this.started || !sdp.startsWith('v=0') || Buffer.byteLength(sdp) > 131072) {
      return Promise.reject(new Error('Invalid or duplicate bridge offer'));
    }
    this.started = true;
    const result = new Promise<string>((resolve, reject) => { this.pending = { resolve, reject }; });
    this.offerTimer = setTimeout(() => this.finish('timeout'), 20_000);
    this.offerTimer.unref();
    try {
      const entrypoint = this.options.entrypoint ?? fileURLToPath(new URL('../../python/gemini_bridge_process.py', import.meta.url));
      this.child = spawn(this.options.pythonExecutable, ['-B', entrypoint], {
        shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONNOUSERSITE: '1' },
      });
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
      this.child.stderr.resume(); // Drain but never expose third-party diagnostics/SDP.
      this.child.stdin.on('error', () => this.finish('exit'));
      this.child.on('error', () => this.finish('spawn'));
      this.child.on('exit', () => {
        clearTimeout(this.killTimer);
        this.finish('exit');
      });
      this.send({ type: 'offer', sdp, ...(this.options.detectSpeech ? { detectSpeech: true } : {}) });
    } catch { this.finish('spawn'); }
    return result;
  }

  sendPCM(pcm: Buffer): void {
    if (!this.answered || !pcm.length || pcm.length % 2 || pcm.length > 96000) throw new Error('Invalid bridge output PCM');
    this.send({ type: 'outputAudio', pcm: pcm.toString('base64') });
  }
  sendControl(message: string): void {
    if (!this.answered || Buffer.byteLength(message) > 65536) throw new Error('Invalid bridge control message');
    this.send({ type: 'control', message });
  }
  clearAudio(): void { if (this.answered && !this.closed) this.send({ type: 'clearAudio' }); }
  close(): void { this.finish('local'); }

  private send(command: object): void {
    if (this.closed || !this.child || this.child.stdin.destroyed) throw new Error('Bridge closed');
    const line = JSON.stringify(command) + '\n';
    if (this.child.stdin.writableLength + Buffer.byteLength(line) > 262144) {
      this.finish('backpressure'); throw new Error('Bridge backpressure');
    }
    this.child.stdin.write(line);
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    try {
      for (let newline = this.buffer.indexOf('\n'); newline !== -1; newline = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 262144) throw new Error('Frame limit');
        const event = frameSchema.parse(JSON.parse(line));
        if (event.type === 'answer') {
          if (!this.pending || this.answered) throw new Error('Unexpected answer');
          this.answered = true; clearTimeout(this.offerTimer);
          this.pending.resolve(event.sdp); this.pending = undefined;
        } else if (event.type === 'inputAudio') {
          if (!this.answered || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.pcm)) throw new Error('Invalid PCM');
          const pcm = Buffer.from(event.pcm, 'base64');
          if (!pcm.length || pcm.length % 2 || pcm.length > 32000) throw new Error('Invalid PCM');
          this.options.onEvent({ type: 'inputAudio', pcm });
        } else if (event.type === 'closed') {
          this.finish('exit');
        } else {
          if (event.type === 'control' && Buffer.byteLength(event.message) > 65536) throw new Error('Control limit');
          this.options.onEvent(event);
        }
        if (this.closed) return;
      }
      if (Buffer.byteLength(this.buffer) > 262144) throw new Error('Frame limit');
    } catch { this.finish('protocol'); }
  }

  private finish(reason: Extract<GeminiBridgeEvent, { type: 'closed' }>['reason']): void {
    if (this.closed) return;
    this.closed = true; this.buffer = ''; clearTimeout(this.offerTimer);
    this.pending?.reject(new Error(`Gemini bridge ${reason}`)); this.pending = undefined;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.stdin.end('{"type":"close"}\n'); } catch { /* kill deadline still applies */ }
      this.killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2000);
      this.killTimer.unref();
    }
    try { this.options.onEvent({ type: 'closed', reason }); } catch { /* terminal */ }
  }
}
