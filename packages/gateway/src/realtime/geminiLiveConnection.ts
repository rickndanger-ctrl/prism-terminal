import { z } from 'zod';
import { GeminiToolDispatcher, type GeminiToolBinding, type GeminiToolFailure } from './geminiToolDispatcher.js';

const endpoint = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const model = 'gemini-3.1-flash-live-preview';
const textSchema = z.object({ text: z.string().max(32768).optional() });
const contentSchema = z.object({
  interrupted: z.boolean().optional(), turnComplete: z.boolean().optional(),
  inputTranscription: textSchema.optional(), outputTranscription: textSchema.optional(),
  modelTurn: z.object({ parts: z.array(z.object({
    thought: z.boolean().optional(),
    inlineData: z.object({ mimeType: z.string(), data: z.string().max(1_000_000) }).optional(),
  })).max(128) }).optional(),
});

export type GeminiLiveEvent =
  | { type: 'ready' | 'clearAudio' | 'turnComplete' }
  | { type: 'audio'; pcm: Buffer; sampleRate: 24000 }
  | { type: 'inputTranscript' | 'outputTranscript'; text: string }
  | { type: 'closed'; reason: 'local' | 'network' | 'protocol' | 'timeout' | 'backpressure' | 'tool'; toolFailure?: GeminiToolFailure };

export interface GeminiWireHandlers {
  open(): void;
  message(data: unknown): void;
  failed(): void;
}
export interface GeminiWire {
  send(message: string): void;
  close(): void;
  bufferedBytes(): number;
}
export type GeminiWireFactory = (url: string, handlers: GeminiWireHandlers) => GeminiWire;

/** The URL contains a secret. Neither the wire adapter nor its caller may log it. */
const nativeWire: GeminiWireFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', handlers.open);
  socket.addEventListener('message', event => handlers.message(event.data));
  socket.addEventListener('error', handlers.failed);
  socket.addEventListener('close', handlers.failed);
  return { send: message => socket.send(message), close: () => socket.close(),
    bufferedBytes: () => socket.bufferedAmount };
};

export interface GeminiLiveOptions {
  apiKey: string;
  instruction: string;
  /** Declarations and bindings are host-owned, never taken from speech/model output. */
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  bindings?: ReadonlyMap<string, GeminiToolBinding>;
  onEvent(event: GeminiLiveEvent): void;
  wireFactory?: GeminiWireFactory;
}

/** One Google session with idle-only provider-requested socket handoff. Preserves ordered audio events while tool
 * execution runs independently, so cancellation cannot queue behind a slow tool.
 * This is a transport, not the addressed-speech gate or WebRTC/audio-device owner.
 * Host bindings must authorize each action. Host playback must honor clearAudio.
 */
export class GeminiLiveConnection {
  private wire?: GeminiWire;
  private readonly dispatcher: GeminiToolDispatcher;
  private setupTimer?: ReturnType<typeof setTimeout>;
  private state: 'connecting' | 'resuming' | 'parked' | 'ready' | 'closed' = 'connecting';
  private idleTimer?: ReturnType<typeof setTimeout>;
  private hasSessionContent = false;
  private activity = false;
  private awaitingResponse = false;
  private resumeHandle?: string;
  private handoffRequested = false;
  private wireGeneration = 0;
  private queuedMessages: string[] = [];
  private queuedBytes = 0;
  private openWire?: (handle?: string) => void;
  private setupSent = false;
  private readonly onEvent: GeminiLiveOptions['onEvent'];

  constructor(options: GeminiLiveOptions) {
    this.onEvent = options.onEvent;
    if (!options.apiKey.trim() || options.apiKey.length > 512 || options.instruction.length > 32768) {
      throw new Error('Invalid Gemini configuration');
    }
    const declarations = options.tools ?? [];
    const bindings = options.bindings ?? new Map();
    const names = declarations.map(tool => tool.name);
    if (names.length > 64 || new Set(names).size !== names.length ||
        names.some(name => !bindings.has(name)) || [...bindings.keys()].some(name => !names.includes(name))) {
      throw new Error('Gemini tool declarations and bindings must match');
    }
    // Copy setup inputs before asynchronous socket callbacks can observe mutations.
    const setup = { setup: { model: `models/${model}`,
      generationConfig: { responseModalities: ['AUDIO'] },
      // Provider-managed history compression avoids the uncompressed audio
      // context limit. Socket lifetime/resumption is a separate requirement.
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: {},
      inputAudioTranscription: {}, outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      systemInstruction: { parts: [{ text: options.instruction }] },
      ...(declarations.length ? { tools: [{ functionDeclarations: structuredClone(declarations) }] } : {}),
    } };
    this.dispatcher = new GeminiToolDispatcher(bindings, message => this.sendSerialized(message));
    const url = new URL(endpoint);
    url.searchParams.set('key', options.apiKey.trim());
    const wireFactory = options.wireFactory ?? nativeWire;
    this.openWire = handle => {
      const generation = ++this.wireGeneration;
      this.setupSent = false;
      this.setupTimer = setTimeout(() => this.finish('timeout'), 15_000);
      this.setupTimer.unref();
      try {
        this.wire = wireFactory(url.toString(), {
          open: () => {
            if (generation !== this.wireGeneration || !['connecting', 'resuming'].includes(this.state) || this.setupSent) return;
            this.setupSent = true;
            try { this.wire!.send(JSON.stringify({ setup: { ...setup.setup,
              sessionResumption: handle ? { handle } : {},
            } })); } catch { this.finish('network'); }
          },
          message: data => { if (generation === this.wireGeneration) this.receive(data); },
          failed: () => { if (generation === this.wireGeneration) this.finish('network'); },
        });
      } catch { this.finish('network'); }
    };
    this.openWire();
  }

  get isReady(): boolean { return this.state === 'ready' || this.state === 'resuming' || this.state === 'parked'; }

  /** Local interruption must not wait for the provider's cancellation notice. */
  cancelPendingTools(): void { this.dispatcher.stop(); }

  /** Host attention feedback, never a model tool or user-supplied prompt.
   * Update context without requesting a spoken response. This does not erase
   * prior content; host output/action gates remain authoritative. */
  dismissResponse(): void {
    this.requireReady();
    if (this.activity) throw new Error('Cannot dismiss active speech');
    this.dispatcher.stop();
    this.sendSerialized(JSON.stringify({ clientContent: {
      turns: [{ role: 'user', parts: [{ text: 'Host attention decision: the most recent spoken utterance was not an addressed request. Do not answer it or execute tasks from it, and do not carry its unanswered questions into later replies. Remain silent until a new addressed request. Preserve earlier addressed conversation context.' }] }],
      turnComplete: false,
    } }));
  }

  sendText(text: string): void {
    this.requireReady();
    if (this.activity || !text.trim() || text.length > 32768) throw new Error('Invalid Gemini text turn');
    this.sendSerialized(JSON.stringify({ realtimeInput: { text } }));
    this.awaitingResponse = true;
  }

  beginActivity(): void {
    this.requireReady();
    if (this.activity) throw new Error('Gemini activity already started');
    this.sendSerialized(JSON.stringify({ realtimeInput: { activityStart: {} } }));
    this.activity = true;
  }

  sendPCM(pcm: Uint8Array): void {
    this.requireReady();
    if (!this.activity || !pcm.length || pcm.length % 2 !== 0 || pcm.length > 32000) {
      throw new Error('Expected bounded 16-bit 16kHz PCM during an activity');
    }
    this.sendSerialized(JSON.stringify({ realtimeInput: { audio: {
      data: Buffer.from(pcm).toString('base64'), mimeType: 'audio/pcm;rate=16000',
    } } }));
  }

  /** Google generates a response after this boundary. This is NOT an OpenAI
   * commit-without-response operation; callers must supply their attention policy. */
  endActivity(): void {
    this.requireReady();
    if (!this.activity) throw new Error('No Gemini activity to end');
    this.sendSerialized(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    this.activity = false;
    this.awaitingResponse = true;
  }

  /** Immediate local stop: discard playback and abort tools without waiting for
   * Google. A fresh connection is required; uncertain actions are never replayed. */
  close(): void { this.finish('local'); }

  private requireReady(): void {
    if (!this.isReady) throw new Error('Gemini connection is not ready');
  }

  private sendSerialized(message: string): void {
    if (this.state === 'closed' || !this.wire) throw new Error('Gemini connection closed');
    clearTimeout(this.idleTimer);
    if (this.state === 'parked') {
      const handle = this.resumeHandle;
      if (!handle && this.hasSessionContent) { this.finish('protocol'); throw new Error('Missing parked checkpoint'); }
      this.state = 'resuming';
      this.openWire?.(handle);
      if (this.state as string === 'closed') throw new Error('Gemini resume failed');
    }
    this.hasSessionContent = true;
    // A checkpoint from before new input/tool results cannot safely resume it.
    this.resumeHandle = undefined;
    if (this.state === 'resuming') {
      this.queuedBytes += Buffer.byteLength(message);
      if (this.queuedBytes > 262144 || this.queuedMessages.length >= 256) {
        this.finish('backpressure'); throw new Error('Gemini resume input limit');
      }
      this.queuedMessages.push(message);
      return;
    }
    if (this.wire.bufferedBytes() + Buffer.byteLength(message) > 1_048_576) {
      this.finish('backpressure'); throw new Error('Gemini connection backpressure');
    }
    try { this.wire.send(message); }
    catch { this.finish('network'); throw new Error('Gemini send failed'); }
  }

  private receive(raw: unknown): void {
    if (this.state === 'closed') return;
    try {
      const bytes = typeof raw === 'string' ? Buffer.from(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : null;
      if (!bytes || bytes.length > 1_048_576) throw new Error('Invalid frame');
      const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(bytes.toString('utf8')));
      if ('error' in parsed) throw new Error('Provider error'); // Never expose provider payloads/secrets.
      if ('setupComplete' in parsed) {
        if (!this.setupSent || !['connecting', 'resuming'].includes(this.state)) throw new Error('Unexpected setup');
        const resumed = this.state === 'resuming';
        this.state = 'ready'; clearTimeout(this.setupTimer);
        const queued = this.queuedMessages; this.queuedMessages = []; this.queuedBytes = 0;
        for (const message of queued) this.sendSerialized(message);
        if (!resumed) this.emit({ type: 'ready' });
        this.scheduleIdlePark();
      }
      if (this.state !== 'ready') throw new Error('Content before setup');
      // Validate content before dispatching any tool from the same frame.
      const content = parsed.serverContent === undefined ? undefined : contentSchema.parse(parsed.serverContent);
      // A token received before newly generated content may omit that answer.
      // Require a provider checkpoint after the last output/completion boundary.
      if (content) { this.hasSessionContent = true; this.resumeHandle = undefined; clearTimeout(this.idleTimer); }
      if (parsed.toolCallCancellation !== undefined && !this.dispatcher.cancel(parsed.toolCallCancellation)) {
        this.finish('tool'); return;
      }
      if (content?.interrupted) this.emit({ type: 'clearAudio' });
      if (content?.inputTranscription?.text) this.emit({ type: 'inputTranscript', text: content.inputTranscription.text });
      // Never enqueue stale audio carried on the interruption notice itself.
      if (!content?.interrupted) {
        for (const part of content?.modelTurn?.parts ?? []) {
          if (part.thought || !part.inlineData) continue;
          const { mimeType, data } = part.inlineData;
          if (mimeType !== 'audio/pcm;rate=24000' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
            throw new Error('Invalid PCM');
          }
          const pcm = Buffer.from(data, 'base64');
          if (!pcm.length || pcm.length % 2) throw new Error('Invalid PCM length');
          this.emit({ type: 'audio', pcm, sampleRate: 24000 });
        }
        if (content?.outputTranscription?.text) this.emit({ type: 'outputTranscript', text: content.outputTranscription.text });
      }
      if (content?.turnComplete) { this.awaitingResponse = false; this.emit({ type: 'turnComplete' }); }
      if (parsed.toolCall !== undefined && this.isReady) {
        void this.dispatcher.dispatch(parsed.toolCall).then(() => {
          if (this.dispatcher.isClosed) this.finish('tool');
          else this.tryHandoff();
        }).catch(() => this.finish('tool'));
        if (this.dispatcher.isClosed) this.finish('tool');
      }
      if (parsed.sessionResumptionUpdate !== undefined) {
        const update = z.object({ resumable: z.boolean(), newHandle: z.string().max(8192).optional() }).parse(parsed.sessionResumptionUpdate);
        this.resumeHandle = update.resumable && update.newHandle ? update.newHandle : undefined;
        this.scheduleIdlePark();
      }
      if (parsed.goAway !== undefined) {
        z.object({ timeLeft: z.string().regex(/^\d+(?:\.\d{1,9})?s$/) }).parse(parsed.goAway);
        this.handoffRequested = true;
      }
      this.tryHandoff();
    } catch { this.finish('protocol'); }
  }

  private tryHandoff(): void {
    if (this.state !== 'ready' || !this.handoffRequested || !this.resumeHandle ||
        this.activity || this.awaitingResponse || this.dispatcher.hasPendingCalls) return;
    const handle = this.resumeHandle;
    clearTimeout(this.idleTimer);
    this.resumeHandle = undefined; this.handoffRequested = false;
    this.state = 'resuming';
    ++this.wireGeneration; // Ignore late audio, tools, and close from the old socket.
    try { this.wire?.close(); } catch { /* the new socket owns the handoff */ }
    this.openWire?.(handle);
  }

  /** Keep the local glasses peer alive but release an unused provider socket.
   * No speech is uploaded to keep a session artificially active. The next new
   * input resumes this exact checkpoint; no prior input or result is replayed. */
  private scheduleIdlePark(): void {
    clearTimeout(this.idleTimer);
    if (this.state !== 'ready' || (!this.resumeHandle && this.hasSessionContent) || this.activity ||
        this.awaitingResponse || this.dispatcher.hasPendingCalls) return;
    this.idleTimer = setTimeout(() => {
      if (this.state !== 'ready' || (!this.resumeHandle && this.hasSessionContent) || this.activity ||
          this.awaitingResponse || this.dispatcher.hasPendingCalls) return;
      this.state = 'parked';
      ++this.wireGeneration;
      try { this.wire?.close(); } catch { /* checkpoint remains local */ }
    }, 60_000);
    this.idleTimer.unref();
  }

  private emit(event: GeminiLiveEvent): void {
    if (this.state !== 'closed') this.onEvent(event);
  }

  private finish(reason: Extract<GeminiLiveEvent, { type: 'closed' }>['reason']): void {
    if (this.state === 'closed') return;
    this.state = 'closed'; clearTimeout(this.setupTimer); clearTimeout(this.idleTimer); this.dispatcher.close();
    this.openWire = undefined; this.resumeHandle = undefined;
    this.queuedMessages = []; this.queuedBytes = 0;
    try { this.wire?.close(); } catch { /* close remains terminal */ }
    try { this.onEvent({ type: 'clearAudio' }); } catch { /* still report closure */ }
    try { this.onEvent({ type: 'closed', reason,
      ...(reason === 'tool' && this.dispatcher.failureReason ? { toolFailure: this.dispatcher.failureReason } : {}),
    }); } catch { /* never reopen or log payloads */ }
  }
}
