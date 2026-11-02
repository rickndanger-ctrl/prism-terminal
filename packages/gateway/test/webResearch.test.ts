import { describe, expect, it, vi } from 'vitest';

import { createOpenAiWebResearcher } from '../src/web/research.js';

describe('OpenAI web research', () => {
  it('uses web_search without storage and returns cited sources', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload.store).toBe(false);
      expect(payload.tools).toEqual([{ type: 'web_search', search_context_size: 'low' }]);
      return new Response(JSON.stringify({
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'A concise current answer.',
            annotations: [{
              type: 'url_citation',
              title: 'Official source',
              url: 'https://example.com/official',
            }],
          }],
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const research = createOpenAiWebResearcher({ apiKey: 'sk-test', fetchImpl });
    const result = await research('What is current?');

    expect(result).toEqual({ ok: true, value: {
      answer: 'A concise current answer.',
      sources: [{ title: 'Official source', url: 'https://example.com/official' }],
      searched: true,
    } });
  });
});
