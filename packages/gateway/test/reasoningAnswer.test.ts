import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_MODEL,
  REASONING_INSTRUCTIONS,
  createOpenAiReasoningAnswerer,
} from '../src/reasoning/answer.js';

describe('OpenAI read-only reasoning answerer', () => {
  it('uses Luna medium without tools or storage and returns a bounded answer', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({
        model: 'gpt-5.6-luna',
        store: false,
        reasoning: { effort: 'medium' },
        input: 'Explain why the sky looks blue.',
      });
      expect(payload).not.toHaveProperty('tools');
      expect(String(payload.instructions)).toContain('untrusted data');
      expect(String(payload.instructions)).toContain('do not perform');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer sk-test' });

      return new Response(JSON.stringify({
        output: [{
          type: 'reasoning',
          summary: [],
        }, {
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'Blue wavelengths scatter more strongly through the atmosphere.',
          }],
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const answer = createOpenAiReasoningAnswerer({ apiKey: 'sk-test', fetchImpl });

    const result = await answer('Explain why the sky looks blue.');

    expect(result).toEqual({
      ok: true,
      value: {
        answer: 'Blue wavelengths scatter more strongly through the atmosphere.',
        model: DEFAULT_REASONING_MODEL,
        reasoningEffort: DEFAULT_REASONING_EFFORT,
      },
    });
    expect(REASONING_INSTRUCTIONS).toContain('normally under 120 words');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('fails closed for missing credentials, upstream rejection, and malformed output', async () => {
    const missingKey = createOpenAiReasoningAnswerer({ apiKey: '   ' });
    await expect(missingKey('Question?')).resolves.toMatchObject({
      ok: false,
      error: { code: 'REASONING_KEY_MISSING' },
    });

    const rejected = createOpenAiReasoningAnswerer({
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => new Response('private upstream detail', { status: 429 })),
    });
    const rejectedResult = await rejected('Question?');
    expect(rejectedResult).toMatchObject({
      ok: false,
      error: { code: 'REASONING_REJECTED' },
    });
    expect(JSON.stringify(rejectedResult)).not.toContain('private upstream detail');

    const malformed = createOpenAiReasoningAnswerer({
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ output: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    });
    await expect(malformed('Question?')).resolves.toMatchObject({
      ok: false,
      error: { code: 'REASONING_BAD_RESPONSE' },
    });
  });
});
