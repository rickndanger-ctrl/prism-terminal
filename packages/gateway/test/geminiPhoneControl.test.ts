import { describe, expect, it, vi } from 'vitest';
import { handleGeminiPhoneControl } from '../src/realtime/geminiPhoneControl.js';

const id = '5d09a69d-908c-46d7-a626-cb494bdc10db';
describe('Gemini phone control protocol', () => {
  it('accepts the exact Swift-encoded decision shape and preserves denial', () => {
    const session = { close: vi.fn(), decideResponse: vi.fn(() => true) };
    expect(handleGeminiPhoneControl(session, `{"allow":false,"turnId":"${id}","type":"gemini.decideResponse"}`)).toBe(true);
    expect(session.decideResponse).toHaveBeenCalledExactlyOnceWith(id, false);
    expect(session.close).not.toHaveBeenCalled();
  });
  it('has an immediate stop that does not need an attention grant', () => {
    const session = { close: vi.fn(), decideResponse: vi.fn() };
    expect(handleGeminiPhoneControl(session, '{"type":"gemini.stop"}')).toBe(true);
    expect(session.close).toHaveBeenCalledOnce(); expect(session.decideResponse).not.toHaveBeenCalled();
  });
  it('rejects model/tool/configuration input and malformed or oversized controls', () => {
    const session = { close: vi.fn(), decideResponse: vi.fn() };
    for (const raw of [
      '{"type":"gemini.stop","command":"anything"}', '{"type":"session.update"}',
      `{"type":"gemini.decideResponse","turnId":"${id}","allow":1}`,
      '{"type":"gemini.decideResponse","turnId":"invalid","allow":true}',
      '[]', 'not-json', 'x'.repeat(1025),
    ]) expect(handleGeminiPhoneControl(session, raw)).toBe(false);
    expect(session.close).not.toHaveBeenCalled(); expect(session.decideResponse).not.toHaveBeenCalled();
  });
  it('does not escalate or retry a stale decision', () => {
    const session = { close: vi.fn(), decideResponse: vi.fn(() => false) };
    expect(handleGeminiPhoneControl(session, JSON.stringify({ type: 'gemini.decideResponse', turnId: id, allow: true }))).toBe(false);
    expect(session.decideResponse).toHaveBeenCalledOnce(); expect(session.close).not.toHaveBeenCalled();
  });
});
