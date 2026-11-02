import { describe, expect, it, vi } from 'vitest';
import { evaluateGeminiAudioAttention } from '../src/realtime/geminiAudioAttention.js';

const speech = () => ({ turnId: 'host-owned-id', pcm: Buffer.from([1, 0, 2, 0]), sampleRate: 16000 as const, signal: new AbortController().signal });
const payload = (value: unknown) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } });

describe('Gemini bounded audio attention', () => {
  it('sends a WAV to a fixed Google endpoint and assigns host identity locally', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => {
      const body = JSON.parse(options!.body as string);
      expect(body).not.toHaveProperty('tools'); expect(body.store).toBe(false);
      expect(options!.redirect).toBe('error');
      expect(body.contents[0].parts[0].text).toContain('a request explicitly addressed to a different person is background');
      expect(body.contents[0].parts[0].text).toContain('Do not require a wake word');
      const audio = Buffer.from(body.contents[0].parts[2].inlineData.data, 'base64');
      expect(audio.toString('ascii', 0, 4)).toBe('RIFF');
      expect(audio.readUInt32LE(24)).toBe(16000);
      expect(audio.subarray(44)).toEqual(speech().pcm);
      return Response.json(payload({ transcript: 'Codex, what time is it?', attention: 'addressed' }));
    });
    const result = await evaluateGeminiAudioAttention({ apiKey: 'test', speech: speech(), fetchImpl });
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(result.turnId).toBe('host-owned-id'); expect(result.attention).toBe('addressed');
    expect(result.usage).toEqual({ promptTokenCount: 100, candidatesTokenCount: 20 });
  });

  it('rejects malformed, invented identity, blank addressed speech, and noncompleted output', async () => {
    for (const value of [
      payload({ transcript: '', attention: 'addressed' }),
      payload({ transcript: 'hello', attention: 'addressed', turnId: 'invented' }),
      payload({ transcript: 'hello', attention: 'yes' }),
      { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] },
    ]) {
      await expect(evaluateGeminiAudioAttention({ apiKey: 'test', speech: speech(),
        fetchImpl: async () => Response.json(value) })).rejects.toThrow('Attention evaluation failed');
    }
  });

  it('does not call Google for a cancelled capture', async () => {
    const abort = new AbortController(); abort.abort(); const fetchImpl = vi.fn<typeof fetch>();
    await expect(evaluateGeminiAudioAttention({ apiKey: 'test', speech: { ...speech(), signal: abort.signal }, fetchImpl }))
      .rejects.toThrow('cancelled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores provider thought annotations instead of treating them as the decision', async () => {
    const result = await evaluateGeminiAudioAttention({ apiKey: 'test', speech: speech(), fetchImpl: async () => Response.json({
      candidates: [{ finishReason: 'STOP', content: { parts: [
        { text: 'internal analysis is not JSON', thought: true },
        { text: JSON.stringify({ transcript: 'Hey Alex', attention: 'background' }), thoughtSignature: 'opaque-provider-metadata' },
      ] } }],
    }) });
    expect(result.attention).toBe('background');
    expect(JSON.stringify(result)).not.toContain('opaque-provider-metadata');
  });

  it('bounds replies and does not expose upstream errors or credentials', async () => {
    for (const response of [new Response('secret', { status: 401 }), new Response('x'.repeat(65537))]) {
      await expect(evaluateGeminiAudioAttention({ apiKey: 'private-key', speech: speech(),
        fetchImpl: async () => response })).rejects.toThrow('Attention evaluation failed');
    }
  });
});
