import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const VOICES = ['af_heart', 'am_michael'] as const;
export const SpeechInputSchema = z.object({
  text: z.string().trim().min(1).max(2_000),
  voice: z.enum(VOICES),
  speed: z.number().min(0.85).max(1.15).optional(),
}).strict();
export type SpeechInput = z.infer<typeof SpeechInputSchema>;
export interface VoiceStatus {
  ready: boolean;
  provider: 'kokoro';
  voices: typeof VOICES;
  state: 'disabled' | 'warming' | 'ready' | 'unavailable';
  message?: string;
}
export class SpeechError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
interface Worker {
  child: ChildProcessWithoutNullStreams;
  ready: boolean;
  readiness: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: SpeechError) => void;
  exited: Promise<void>;
  startupTimer?: NodeJS.Timeout;
  buffer: string;
}
interface Job {
  id: string;
  input: SpeechInput;
  promise: Promise<Buffer>;
  resolve: (audio: Buffer) => void;
  reject: (error: SpeechError) => void;
  settled: boolean;
  timer?: NodeJS.Timeout;
  unlisten: () => void;
}
export interface SpeechOptions {
  pythonPath?: string;
  workerPath?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxPendingRequests?: number;
  /** Tests use a tiny stdio fixture, never a model or external service. */
  spawnWorker?: (pythonPath: string, workerPath: string) => ChildProcessWithoutNullStreams;
}
const unavailable = () => new SpeechError(503, 'Local voice is unavailable. Text chat is still available.');
const MAX_AUDIO_BYTES = 20_000_000;
const MAX_LINE_BYTES = 28_000_000;
const FIXED_SPEECH_CACHE_VERSION = 1;
export const FIXED_SPEECH_CACHE_LIMITS = Object.freeze({ entries: 32, bytes: 8 * 1024 * 1024, entryBytes: 512 * 1024 });
// Explicit nonpersonal phrases only. No free-form dictation, URLs, window titles
// or model replies are admitted. This caches audio, never execution evidence.
const FIXED_SPEECH_APPS = ['Visual Studio Code', 'Claude', 'System Settings', 'ChatGPT', 'Cursor', 'Google Chrome', 'Safari',
  'Messages', 'FaceTime', 'Notes', 'Finder', 'Calculator', 'TextEdit'] as const;
const FIXED_SPEECH_PHRASES = new Set([
  ...FIXED_SPEECH_APPS.flatMap(app => [`${app} is frontmost.`, `Closed the window in ${app}.`]),
  'Typed into the focused field. I did not press Enter or Send.',
  'Verified the text in a new unsaved TextEdit document. Nothing was sent.',
  'Search handed to the default browser. Page results have not been verified.',
  'Minimized the window.', 'Restored the window.', 'Maximized the window.',
  'Moved the window to the left half.', 'Moved the window to the right half.',
  'Went back a page.', 'Went forward a page.', 'Opened a new browser tab.',
  'Switched to the next tab.', 'Switched to the previous tab.', 'Closed the current tab.',
  'Focused the browser address bar.',
  'Opened the address in the current tab. Page loading is not verified.',
  'Requested a page reload. Page loading is not verified.',
]);

function fixedSpeechKey(input: SpeechInput): string | undefined {
  if (!FIXED_SPEECH_PHRASES.has(input.text)) return undefined;
  return JSON.stringify([FIXED_SPEECH_CACHE_VERSION, input.voice, input.speed ?? 1, input.text]);
}

/** One local CPU worker, one inference at a time, with a bounded waiting queue. */
export class LocalSpeechService {
  private worker?: Worker;
  private retiring?: Promise<void>;
  private active?: Job;
  private queue: Job[] = [];
  private pumping = false;
  private closed = false;
  private retryAfter = 0;
  private failed = false;
  private readonly fixedSpeechCache = new Map<string, Buffer>();
  private fixedSpeechCacheBytes = 0;
  constructor(private readonly options: SpeechOptions = {}) {}

  private configured(): boolean {
    return !!this.options.pythonPath && isAbsolute(this.options.pythonPath)
      && !!this.options.workerPath && isAbsolute(this.options.workerPath);
  }
  status(): VoiceStatus {
    const base = { ready: false, provider: 'kokoro' as const, voices: VOICES };
    if (!this.configured()) return { ...base, state: 'disabled', message: 'Local voice has not been configured on this Mac.' };
    if (this.closed) return { ...base, state: 'unavailable', message: unavailable().message };
    if (!this.worker && Date.now() >= this.retryAfter) void this.ensureWorker().catch(() => {});
    if (this.worker?.ready) return { ...base, ready: true, state: 'ready' };
    return this.failed
      ? { ...base, state: 'unavailable', message: unavailable().message }
      : { ...base, state: 'warming', message: 'Loading the local voice.' };
  }

  synthesize(input: SpeechInput, signal?: AbortSignal): Promise<Buffer> {
    const parsed = SpeechInputSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new SpeechError(400, 'Invalid speech request.'));
    if (this.closed || !this.configured()) return Promise.reject(unavailable());
    if (signal?.aborted) return Promise.reject(new SpeechError(499, 'Speech request cancelled.'));
    const cacheKey = fixedSpeechKey(parsed.data);
    const cached = cacheKey === undefined ? undefined : this.fixedSpeechCache.get(cacheKey);
    if (cacheKey !== undefined && cached !== undefined) {
      this.fixedSpeechCache.delete(cacheKey);
      this.fixedSpeechCache.set(cacheKey, cached);
      // Do not enqueue or disturb active synthesis. Recheck cancellation at
      // delivery so an immediate Stop still wins even for an in-memory hit.
      return Promise.resolve().then(() => {
        if (this.closed || !this.configured()) throw unavailable();
        if (signal?.aborted) throw new SpeechError(499, 'Speech request cancelled.');
        return Buffer.from(cached);
      });
    }
    if (this.queue.length + (this.active ? 1 : 0) >= (this.options.maxPendingRequests ?? 3)) {
      return Promise.reject(new SpeechError(429, 'Local voice is busy. Try again shortly.'));
    }
    let resolve!: Job['resolve'], reject!: Job['reject'];
    const promise = new Promise<Buffer>((yes, no) => { resolve = yes; reject = no; });
    const job: Job = { id: randomUUID(), input: parsed.data, promise, resolve, reject, settled: false, unlisten: () => {} };
    const cancel = (error: SpeechError): void => {
      this.finish(job, error);
      if (this.active === job && this.worker) void this.retire(this.worker);
      else this.queue = this.queue.filter((entry) => entry !== job);
    };
    const abort = () => cancel(new SpeechError(499, 'Speech request cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    job.unlisten = () => signal?.removeEventListener('abort', abort);
    job.timer = setTimeout(() => cancel(new SpeechError(504, 'Local speech took too long. Try a shorter reply.')), this.options.requestTimeoutMs ?? 45_000);
    job.timer.unref();
    this.queue.push(job);
    void this.pump();
    return promise;
  }

  private finish(job: Job, result: Buffer | SpeechError): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.unlisten();
    if (result instanceof SpeechError) job.reject(result);
    else {
      this.rememberFixedSpeech(job.input, result);
      job.resolve(result);
    }
  }
  private rememberFixedSpeech(input: SpeechInput, audio: Buffer): void {
    const key = fixedSpeechKey(input);
    if (key === undefined || this.closed || audio.length < 44 || audio.length > FIXED_SPEECH_CACHE_LIMITS.entryBytes
        || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return;
    const old = this.fixedSpeechCache.get(key);
    if (old) { this.fixedSpeechCache.delete(key); this.fixedSpeechCacheBytes -= old.length; }
    while (this.fixedSpeechCache.size >= FIXED_SPEECH_CACHE_LIMITS.entries
        || this.fixedSpeechCacheBytes + audio.length > FIXED_SPEECH_CACHE_LIMITS.bytes) {
      const oldest = this.fixedSpeechCache.keys().next().value;
      if (oldest === undefined) break;
      this.fixedSpeechCacheBytes -= this.fixedSpeechCache.get(oldest)!.length;
      this.fixedSpeechCache.delete(oldest);
    }
    this.fixedSpeechCache.set(key, Buffer.from(audio));
    this.fixedSpeechCacheBytes += audio.length;
  }
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.queue.length) {
        const job = this.queue.shift()!;
        if (job.settled) continue;
        this.active = job;
        // Install the rejection observer before startup/IO can reject this job.
        const finished = job.promise.catch(() => undefined);
        try {
          const worker = await this.ensureWorker();
          if (!job.settled) worker.child.stdin.write(JSON.stringify({ id: job.id, ...job.input, speed: job.input.speed ?? 1 }) + '\n', (error) => {
            if (error) this.failWorker(worker);
          });
        } catch { this.finish(job, unavailable()); }
        await finished;
        this.active = undefined;
      }
    } finally { this.pumping = false; }
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.retiring) await this.retiring;
    if (this.closed || !this.configured()) throw unavailable();
    if (!this.worker) {
      if (Date.now() < this.retryAfter) throw unavailable();
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.options.spawnWorker?.(this.options.pythonPath!, this.options.workerPath!) ?? spawn(this.options.pythonPath!, [this.options.workerPath!], {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          // The worker needs no API keys, gateway bearer or provider credentials.
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
            LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1', DO_NOT_TRACK: '1' },
        });
      } catch { this.failed = true; this.retryAfter = Date.now() + 5_000; throw unavailable(); }
      let resolveReady!: () => void, rejectReady!: (error: SpeechError) => void;
      const readiness = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      void readiness.catch(() => {});
      const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
      const worker: Worker = { child, readiness, resolveReady, rejectReady, exited, ready: false, buffer: '' };
      this.worker = worker;
      this.failed = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.receive(worker, chunk));
      child.stderr.on('data', () => {}); // Drain; never log transcripts or dependency errors.
      child.stdin.on('error', () => this.failWorker(worker));
      child.on('error', () => this.failWorker(worker));
      child.on('exit', () => this.failWorker(worker));
      worker.startupTimer = setTimeout(() => this.failWorker(worker), this.options.startupTimeoutMs ?? 120_000);
      worker.startupTimer.unref();
    }
    const worker = this.worker;
    await worker.readiness;
    if (this.worker !== worker || this.closed) throw unavailable();
    return worker;
  }

  private receive(worker: Worker, chunk: string): void {
    if (this.worker !== worker) return;
    worker.buffer += chunk;
    if (Buffer.byteLength(worker.buffer) > MAX_LINE_BYTES) { this.failWorker(worker); return; }
    for (;;) {
      const end = worker.buffer.indexOf('\n');
      if (end === -1) return;
      const line = worker.buffer.slice(0, end);
      worker.buffer = worker.buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (!worker.ready) {
          if (value.type !== 'ready' || value.provider !== 'kokoro' || value.sampleRate !== 24_000
              || !Array.isArray(value.voices) || !VOICES.every((voice) => (value.voices as unknown[]).includes(voice))) throw new Error('protocol');
          worker.ready = true;
          clearTimeout(worker.startupTimer);
          worker.resolveReady();
          continue;
        }
        const job = this.active;
        if (!job || job.settled || value.id !== job.id) throw new Error('ownership');
        if ('error' in value) { this.finish(job, unavailable()); continue; }
        if (value.format !== 'wav' || value.sampleRate !== 24_000 || typeof value.audioBase64 !== 'string'
            || value.audioBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.audioBase64)) throw new Error('audio');
        const audio = Buffer.from(value.audioBase64, 'base64');
        if (audio.length < 44 || audio.length > MAX_AUDIO_BYTES || audio.toString('ascii', 0, 4) !== 'RIFF'
            || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('audio');
        this.finish(job, audio);
      } catch { this.failWorker(worker); return; }
    }
  }

  private failWorker(worker: Worker): void {
    if (this.worker !== worker) return;
    this.failed = true;
    this.retryAfter = Date.now() + 5_000;
    if (this.active) this.finish(this.active, unavailable());
    void this.retire(worker);
  }
  private retire(worker: Worker): Promise<void> {
    if (this.worker !== worker) return this.retiring ?? Promise.resolve();
    this.worker = undefined;
    clearTimeout(worker.startupTimer);
    worker.rejectReady(unavailable());
    worker.child.kill('SIGTERM');
    this.retiring = (async () => {
      const force = setTimeout(() => worker.child.kill('SIGKILL'), 250);
      force.unref();
      await worker.exited;
      clearTimeout(force);
    })().finally(() => { this.retiring = undefined; });
    return this.retiring;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.fixedSpeechCache.clear(); this.fixedSpeechCacheBytes = 0;
    for (const job of this.queue.splice(0)) this.finish(job, unavailable());
    if (this.active) this.finish(this.active, unavailable());
    if (this.worker) await this.retire(this.worker);
    await this.retiring;
  }
}

export function localSpeechFromEnv(): LocalSpeechService {
  return new LocalSpeechService({ pythonPath: process.env.CODEX_LENS_VOICE_PYTHON, workerPath: process.env.CODEX_LENS_VOICE_WORKER });
}
