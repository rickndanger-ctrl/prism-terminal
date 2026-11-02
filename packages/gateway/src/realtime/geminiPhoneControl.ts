import { z } from 'zod';
import type { GeminiGatewaySession } from './geminiGatewaySession.js';

const controlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('gemini.decideResponse'), turnId: z.uuid(), allow: z.boolean() }).strict(),
  z.object({ type: z.literal('gemini.stop') }).strict(),
]);

/** Only for the authenticated peer's data channel, never model output or a
 * transcription string. Capture/VAD, prompts, tools, paths, and provider keys
 * cannot be configured by this protocol. Invalid/stale controls have no effect.
 */
export function handleGeminiPhoneControl(
  session: Pick<GeminiGatewaySession, 'decideResponse' | 'close'>, raw: string,
): boolean {
  if (Buffer.byteLength(raw) > 1024) return false;
  let parsed;
  try { parsed = controlSchema.safeParse(JSON.parse(raw)); } catch { return false; }
  if (!parsed.success) return false;
  if (parsed.data.type === 'gemini.stop') { session.close(); return true; }
  return session.decideResponse(parsed.data.turnId, parsed.data.allow);
}
