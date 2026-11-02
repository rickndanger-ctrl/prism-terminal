import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { err, ok } from '@codex-lens/shared';

import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import { buildServer } from '../src/server.js';

const TOKEN = 'web-route-test-token';
let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env[GATEWAY_TOKEN_ENV];
  process.env[GATEWAY_TOKEN_ENV] = TOKEN;
});

afterEach(() => {
  if (originalToken === undefined) delete process.env[GATEWAY_TOKEN_ENV];
  else process.env[GATEWAY_TOKEN_ENV] = originalToken;
});

describe('POST /v1/web/research', () => {
  it('returns a bounded read-only researched answer', async () => {
    const researcher = vi.fn(async (question: string) => ok({
      answer: `Current answer for: ${question}`,
      sources: [{ title: 'Primary source', url: 'https://example.com/source' }],
      searched: true as const,
    }));
    const server = buildServer({ webResearcher: researcher });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/web/research',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { question: 'What happened today?' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      answer: 'Current answer for: What happened today?',
      sources: [{ title: 'Primary source', url: 'https://example.com/source' }],
      searched: true,
    });
    expect(researcher).toHaveBeenCalledWith('What happened today?');
    await server.close();
  });

  it('rejects extra fields and fails closed when research is unavailable', async () => {
    const server = buildServer({
      webResearcher: async () => err('WEB_DOWN', 'Live web research is unavailable.'),
    });
    const invalid = await server.inject({
      method: 'POST',
      url: '/v1/web/research',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { question: 'Search this', openBrowser: true },
    });
    expect(invalid.statusCode).toBe(400);

    const unavailable = await server.inject({
      method: 'POST',
      url: '/v1/web/research',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { question: 'Search this' },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      message: 'Live web research is unavailable.',
    });
    await server.close();
  });
});
