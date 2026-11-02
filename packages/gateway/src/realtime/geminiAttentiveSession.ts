import { evaluateGeminiAudioAttention } from './geminiAudioAttention.js';
import { GeminiGatewaySession, type GeminiSessionOptions } from './geminiGatewaySession.js';

type Session = Pick<GeminiGatewaySession, 'answer' | 'close' | 'decideResponse' | 'sendPhoneToolMessage'>;
type Evaluation = Awaited<ReturnType<typeof evaluateGeminiAudioAttention>>;

/** Production composition, opt-in only. No HTTP activation or model tool grants.
 * Uses exact captured audio; independent live transcripts never authorize speech.
 * Attention permits a response, not consequential actions or factual correctness. */
export function createGeminiAttentiveSession(options: Omit<GeminiSessionOptions, 'automaticSpeech' | 'onCapturedSpeech'> & {
  evaluate?: typeof evaluateGeminiAudioAttention;
  sessionFactory?: (config: GeminiSessionOptions) => Session;
  onAttention?(result: Evaluation): void;
  now?: () => number;
}): Session {
  const { evaluate = evaluateGeminiAudioAttention, sessionFactory = config => new GeminiGatewaySession(config),
    onAttention, now = Date.now, ...config } = options;
  let closed = false;
  let currentID: string | undefined;
  let accepted: { id: string; user: string; assistant: string } | undefined;
  let history: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  let lastAddressedAt = 0;
  const session: Session = sessionFactory({
    ...config,
    automaticSpeech: true,
    onCapturedSpeech: async speech => {
      if (closed || speech.signal.aborted || speech.turnId !== currentID) return;
      if (now() - lastAddressedAt > 90_000) history = [];
      const result = await evaluate({ apiKey: config.connection.apiKey, speech,
        recentAddressedTurns: history.map(turn => ({ ...turn })) });
      if (closed || speech.signal.aborted || speech.turnId !== currentID || result.turnId !== speech.turnId) return;
      const sourceMessage = { type: 'gemini.acceptedUtterance', turnId: speech.turnId, text: result.transcript };
      if (Buffer.byteLength(JSON.stringify(sourceMessage)) > 32768) {
        session.decideResponse(speech.turnId, false); return;
      }
      const allow = result.attention === 'addressed' && !!result.transcript.trim();
      // decideResponse can synchronously flush a whole buffered response.
      if (allow) accepted = { id: speech.turnId, user: result.transcript.slice(0, 1000), assistant: '' };
      const applied = session.decideResponse(speech.turnId, allow);
      if (!applied) { if (accepted?.id === speech.turnId) accepted = undefined; return; }
      if (allow) lastAddressedAt = now();
      if (allow) session.sendPhoneToolMessage(sourceMessage);
      onAttention?.(result);
    },
    onEvent: event => {
      if (event.type === 'activityStarted') { currentID = event.turnId; accepted = undefined; }
      if (event.type === 'outputTranscript' && accepted && accepted.id === currentID) {
        accepted.assistant = (accepted.assistant + event.text).slice(0, 1000);
      }
      if (event.type === 'turnComplete' && accepted && accepted.id === currentID) {
        history.push({ role: 'user', text: accepted.user }, { role: 'assistant', text: accepted.assistant });
        history = history.slice(-6);
        accepted = undefined;
      }
      if (event.type === 'closed') { closed = true; history = []; accepted = undefined; currentID = undefined; }
      config.onEvent(event);
    },
  });
  return { answer: sdp => session.answer(sdp), decideResponse: (id, allow) => session.decideResponse(id, allow),
    sendPhoneToolMessage: message => session.sendPhoneToolMessage(message),
    close: () => { closed = true; history = []; accepted = undefined; currentID = undefined; session.close(); } };
}
