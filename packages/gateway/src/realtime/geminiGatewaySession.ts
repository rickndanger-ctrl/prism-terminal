import { GeminiBridgeProcess, type GeminiBridgeEvent } from './geminiBridgeProcess.js';
import { GeminiLiveConnection, type GeminiLiveEvent, type GeminiLiveOptions } from './geminiLiveConnection.js';
import { GeminiResponseGate, type GatedGeminiOutput } from './geminiResponseGate.js';
import { GeminiSpeechTurnBuffer, type GeminiCapturedSpeech } from './geminiSpeechTurnBuffer.js';
import { z } from 'zod';

const cancelResponseSchema = z.object({ type: z.literal('gemini.cancelResponse'), turnId: z.uuid() }).strict();

type Bridge = Pick<GeminiBridgeProcess, 'answer' | 'sendPCM' | 'sendControl' | 'clearAudio' | 'close'>;
type Connection = Pick<GeminiLiveConnection, 'sendText' | 'beginActivity' | 'sendPCM' | 'endActivity' | 'cancelPendingTools' | 'dismissResponse' | 'close'>;
export type GeminiSessionEvent = Exclude<GeminiLiveEvent, { type: 'audio' } | { type: 'closed' }>
  | { type: 'activityStarted'; turnId: string }
  | { type: 'activityEnded'; turnId: string; reason: 'manual' | 'silence' | 'limit' }
  | { type: 'closed'; reason: 'local' | 'bridge' | 'provider' | 'protocol' };
export interface GeminiSessionOptions {
  connection: Omit<GeminiLiveOptions, 'onEvent'>;
  pythonExecutable: string;
  entrypoint?: string;
  /** Local WebRTC VAD in the supervised child; no phone capture-engine change. */
  automaticSpeech?: boolean;
  /** Optional host evaluator receives audio from this exact captured turn.
   * Must honor signal; output still needs a current-turn attention decision. */
  onCapturedSpeech?(speech: GeminiCapturedSpeech): Promise<void>;
  onEvent(event: GeminiSessionEvent): void;
  /** Untrusted control data, delivered only to the host's explicit policy handler.
   * Nothing in this class interprets a message as permission to run a command. */
  onControl(message: string): void;
  bridgeFactory?: (onEvent: (event: GeminiBridgeEvent) => void) => Bridge;
  connectionFactory?: (options: GeminiLiveOptions) => Connection;
}

/** Composes one provider and one WebRTC child. The authenticated host owns
 * capture boundaries; speech responses default to a hold until decideResponse.
 * sendText and deferResponse:false are for already-authorized direct requests.
 * Idle PCM is dropped, not silently uploaded; this is not a wake-word detector.
 * Close is terminal and never restarts a task. Phone control events use Gemini's
 * native namespace, not a partial imitation of OpenAI's response protocol.
 */
export class GeminiGatewaySession {
  private bridge?: Bridge;
  private connection?: Connection;
  private started = false;
  private closed = false;
  private providerReady = false;
  private controlReady = false;
  private answered = false;
  private ready = false;
  private active = false;
  private awaitingReply = false;
  private discardInterruptedCompletion = false;
  private dismissWhenSpeechEnds = false;
  private turnId?: string;
  private readonly responseGate: GeminiResponseGate;
  private readonly speechTurns = new GeminiSpeechTurnBuffer();
  private setup?: { resolve(): void; reject(error: Error): void };

  constructor(private readonly options: GeminiSessionOptions) {
    this.responseGate = new GeminiResponseGate({
      release: (_id, event) => this.releaseOutput(event),
      denied: id => {
        if (id !== this.turnId || this.closed) return;
        this.awaitingReply = false;
        this.speechTurns.cancel();
        this.connection?.cancelPendingTools();
        if (this.active) this.dismissWhenSpeechEnds = true;
        else this.dismissProviderResponse();
        this.control({ type: 'gemini.responseSuppressed', turnId: id });
      },
    });
  }

  async answer(sdp: string): Promise<string> {
    if (this.started || this.closed) throw new Error('Session already started or closed');
    this.started = true;
    const providerSetup = new Promise<void>((resolve, reject) => { this.setup = { resolve, reject }; });
    // Observe rejection immediately, even if constructing the other component fails.
    void providerSetup.catch(() => {});
    try {
      this.bridge = this.options.bridgeFactory?.(event => this.fromBridge(event)) ?? new GeminiBridgeProcess({
        pythonExecutable: this.options.pythonExecutable, entrypoint: this.options.entrypoint,
        detectSpeech: this.options.automaticSpeech,
        onEvent: event => this.fromBridge(event),
      });
      this.connection = (this.options.connectionFactory ?? (config => new GeminiLiveConnection(config)))({
        ...this.options.connection,
        bindings: new Map([...(this.options.connection.bindings ?? new Map())].map(([name, binding]) => [name, {
          ...binding,
          execute: async (args: unknown, signal: AbortSignal) => {
            const id = this.turnId;
            if (this.closed || this.discardInterruptedCompletion || !this.awaitingReply || this.active || !id) throw new Error('No authorized response turn');
            if (!await this.responseGate.waitForPermission(id, signal) || !this.responseGate.allows(id)
                || this.closed || this.discardInterruptedCompletion || !this.awaitingReply || this.active) throw new Error('No authorized response turn');
            signal.throwIfAborted();
            return binding.execute(args, signal);
          },
        }])),
        onEvent: event => this.fromProvider(event),
      });
      const [answer] = await Promise.all([this.bridge.answer(sdp), providerSetup]);
      if (this.closed) throw new Error('Session closed during setup');
      this.answered = true; this.announceReady();
      return answer;
    } catch {
      this.finish('protocol');
      throw new Error('Gemini session could not start');
    }
  }

  beginActivity(options: { deferResponse?: boolean } = {}): string {
    this.requireReady();
    if (this.active) throw new Error('Activity already started');
    this.connection!.cancelPendingTools();
    this.awaitingReply = false;
    this.clearAudio();
    this.turnId = this.responseGate.begin();
    if (this.options.onCapturedSpeech) this.speechTurns.begin(this.turnId);
    // Quiet by default. Only an already-authorized host request may bypass the hold.
    if (options.deferResponse === false) this.responseGate.decide(this.turnId, true);
    this.active = true;
    this.dismissWhenSpeechEnds = false;
    try { this.connection!.beginActivity(); }
    catch { this.finish('provider'); throw new Error('Gemini activity failed'); }
    this.control({ type: 'gemini.activityStarted', turnId: this.turnId });
    this.options.onEvent({ type: 'activityStarted', turnId: this.turnId });
    return this.turnId;
  }

  /** Called only by the authenticated host's attention policy, not model tools. */
  decideResponse(turnId: string, allow: boolean): boolean {
    if (this.closed) return false;
    return this.responseGate.decide(turnId, allow);
  }

  endActivity(reason: 'manual' | 'silence' | 'limit' = 'manual'): void {
    this.requireReady();
    if (!this.active) throw new Error('No active speech turn');
    this.active = false; this.awaitingReply = true;
    if (this.turnId) this.responseGate.armDeadline(this.turnId);
    try { this.connection!.endActivity(); }
    catch { this.finish('provider'); throw new Error('Gemini activity failed'); }
    this.control({ type: 'gemini.activityEnded', turnId: this.turnId, reason });
    if (this.dismissWhenSpeechEnds) {
      this.dismissWhenSpeechEnds = false;
      this.awaitingReply = false;
      this.dismissProviderResponse();
    }
    if (reason === 'limit' && this.turnId) this.decideResponse(this.turnId, false);
    if (this.turnId) this.options.onEvent({ type: 'activityEnded', turnId: this.turnId, reason });
    if (reason !== 'limit' && this.turnId && this.options.onCapturedSpeech) {
      const captured = this.speechTurns.end(this.turnId);
      if (captured) {
        void Promise.resolve().then(async () => {
          if (!captured.signal.aborted) await this.options.onCapturedSpeech!(captured);
        }).catch(() => {
          if (!captured.signal.aborted) this.decideResponse(captured.turnId, false);
        });
      }
    }
  }

  sendText(text: string): void {
    this.requireReady();
    if (this.active) throw new Error('Cannot interleave text and active speech');
    this.speechTurns.cancel();
    this.connection!.cancelPendingTools(); this.clearAudio();
    this.turnId = this.responseGate.begin();
    this.responseGate.decide(this.turnId, true);
    this.awaitingReply = true;
    try { this.connection!.sendText(text); }
    catch { this.finish('provider'); throw new Error('Gemini text turn failed'); }
  }

  close(): void { this.finish('local'); }

  /** Trusted host relay only, never a raw phone/model command endpoint. */
  sendPhoneToolMessage(message: object): void {
    this.requireReady();
    if (Buffer.byteLength(JSON.stringify(message)) > 32768) throw new Error('Phone tool message limit');
    this.control(message);
  }

  private dismissProviderResponse(): void {
    try { this.connection?.dismissResponse(); }
    catch { this.finish('provider'); }
  }

  private requireReady(): void {
    if (!this.ready || this.closed) throw new Error('Gemini session is not ready');
  }

  private fromBridge(event: GeminiBridgeEvent): void {
    if (this.closed) return;
    try {
      if (event.type === 'closed' || event.type === 'state' && ['failed', 'closed'].includes(event.state)) {
        this.finish('bridge');
      } else if (event.type === 'state' && event.state === 'controlReady') {
        this.controlReady = true; this.announceReady();
      } else if (event.type === 'inputAudio') {
        if (this.active && this.providerReady) {
          if (this.options.onCapturedSpeech && this.turnId) this.speechTurns.append(this.turnId, event.pcm);
          this.connection!.sendPCM(event.pcm);
        }
      } else if (event.type === 'activityStart' && this.options.automaticSpeech && this.ready) {
        this.beginActivity();
      } else if (event.type === 'activityEnd' && this.options.automaticSpeech && this.active) {
        this.endActivity(event.reason);
      } else if (event.type === 'control') {
        if (Buffer.byteLength(event.message) <= 1024) {
          let cancellation;
          try { cancellation = cancelResponseSchema.safeParse(JSON.parse(event.message)); } catch { /* normal control validation follows */ }
          if (cancellation?.success) {
            const id = cancellation.data.turnId;
            if (this.ready && !this.active && id === this.turnId && this.responseGate.allows(id)) {
              this.responseGate.invalidate(); this.awaitingReply = false;
              this.speechTurns.cancel(); this.connection?.cancelPendingTools();
              this.clearAudio(); this.dismissProviderResponse();
            }
            return;
          }
        }
        this.options.onControl(event.message);
      }
    } catch { this.finish('protocol'); }
  }

  private fromProvider(event: GeminiLiveEvent): void {
    if (this.closed) return;
    try {
      if (event.type === 'ready') {
        this.providerReady = true; this.setup?.resolve(); this.setup = undefined;
        this.announceReady();
      } else if (event.type === 'closed') {
        this.finish('provider');
      } else if (event.type === 'clearAudio') {
        // Google's interrupted turn completes after its interruption notice.
        // It may arrive after the new activity ended; do not mistake that old
        // completion for the new answer and silence the new response.
        this.discardInterruptedCompletion = true;
        this.clearAudio();
      } else if (event.type === 'audio') {
        if (!this.discardInterruptedCompletion && this.awaitingReply && !this.active && this.ready && this.turnId) this.responseGate.push(this.turnId, { type: 'audio', pcm: event.pcm });
      } else if (event.type === 'inputTranscript') {
        this.control({ type: 'gemini.inputTranscript', text: event.text, turnId: this.turnId });
        this.options.onEvent(event);
      } else if (event.type === 'turnComplete' && this.discardInterruptedCompletion) {
        this.discardInterruptedCompletion = false;
      } else if (!this.discardInterruptedCompletion && this.awaitingReply && !this.active) {
        if (this.turnId) this.responseGate.push(this.turnId, event.type === 'outputTranscript'
          ? { type: 'outputTranscript', text: event.text } : { type: 'turnComplete' });
      }
    } catch { this.finish('protocol'); }
  }

  private releaseOutput(event: GatedGeminiOutput): void {
    if (this.closed) return;
    if (event.type === 'audio') {
      this.bridge!.sendPCM(event.pcm);
    } else {
      if (event.type === 'turnComplete') this.awaitingReply = false;
      this.control(event.type === 'outputTranscript'
        ? { type: 'gemini.outputTranscript', text: event.text, turnId: this.turnId }
        : { type: 'gemini.turnComplete', turnId: this.turnId });
      this.options.onEvent(event);
    }
  }

  private announceReady(): void {
    if (this.closed || this.ready || !this.answered || !this.providerReady || !this.controlReady) return;
    this.ready = true;
    this.control({ type: 'gemini.ready' });
    this.options.onEvent({ type: 'ready' });
  }

  private control(message: object): void {
    if (this.controlReady && this.answered && !this.closed) this.bridge!.sendControl(JSON.stringify(message));
  }

  private clearAudio(): void {
    if (this.answered && !this.closed) this.bridge!.clearAudio();
    this.control({ type: 'gemini.clearAudio' });
    this.options.onEvent({ type: 'clearAudio' });
  }

  private finish(reason: Extract<GeminiSessionEvent, { type: 'closed' }>['reason']): void {
    if (this.closed) return;
    this.closed = true; this.active = false; this.awaitingReply = false;
    this.responseGate.invalidate();
    this.speechTurns.cancel();
    this.setup?.reject(new Error('Gemini setup closed')); this.setup = undefined;
    try { this.connection?.close(); } catch { /* close both components */ }
    try { this.bridge?.close(); } catch { /* terminal */ }
    try { this.options.onEvent({ type: 'clearAudio' }); } catch { /* still report closure */ }
    try { this.options.onEvent({ type: 'closed', reason }); } catch { /* terminal */ }
  }
}
