import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { err, ok } from '@codex-lens/shared';

import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import { OPENAI_API_KEY_ENV } from '../src/realtime/credentials.js';
import {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_MODEL,
  type ReasoningAnswerer,
} from '../src/reasoning/answer.js';
import { REASONING_ANSWER_PATH } from '../src/routes/reasoning.js';
import { buildServer } from '../src/server.js';

const TOKEN = 'reasoning-route-test-token';
const servers = new Set<ReturnType<typeof buildServer>>();
let originalToken: string | undefined;
let originalOpenAiKey: string | undefined;

beforeEach(() => {
  originalToken = process.env[GATEWAY_TOKEN_ENV];
  originalOpenAiKey = process.env[OPENAI_API_KEY_ENV];
  process.env[GATEWAY_TOKEN_ENV] = TOKEN;
  delete process.env[OPENAI_API_KEY_ENV];
});

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => server.close()));
  servers.clear();
  restore(GATEWAY_TOKEN_ENV, originalToken);
  restore(OPENAI_API_KEY_ENV, originalOpenAiKey);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function makeServer(answerer?: ReasoningAnswerer): ReturnType<typeof buildServer> {
  const server = buildServer(
    answerer === undefined ? {} : { reasoningAnswerer: answerer },
  );
  servers.add(server);
  return server;
}

describe(`POST ${REASONING_ANSWER_PATH}`, () => {
  it('requires gateway authentication', async () => {
    const server = makeServer(async () => ok({
      answer: 'No.',
      model: DEFAULT_REASONING_MODEL,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    }));

    const response = await server.inject({
      method: 'POST',
      url: REASONING_ANSWER_PATH,
      payload: { question: 'Is this authenticated?' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns the exact Luna medium contract and trims the question', async () => {
    const answerer = vi.fn(async () => ok({
      answer: 'A concise reasoning answer.',
      model: DEFAULT_REASONING_MODEL,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    }));
    const server = makeServer(answerer);

    const response = await server.inject({
      method: 'POST',
      url: REASONING_ANSWER_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { question: '  Why does this happen?  ' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      answer: 'A concise reasoning answer.',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
    });
    expect(answerer).toHaveBeenCalledWith('Why does this happen?');
  });

  it('strictly rejects unknown fields and invalid question lengths', async () => {
    const answerer = vi.fn(async () => ok({
      answer: 'Unused.',
      model: DEFAULT_REASONING_MODEL,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    }));
    const server = makeServer(answerer);
    const request = async (payload: Record<string, unknown>) => server.inject({
      method: 'POST',
      url: REASONING_ANSWER_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload,
    });

    expect((await request({ question: 'Why?', useBrowser: true })).statusCode).toBe(400);
    expect((await request({ question: ' ' })).statusCode).toBe(400);
    expect((await request({ question: 'x'.repeat(1_001) })).statusCode).toBe(400);
    expect(answerer).not.toHaveBeenCalled();
  });

  it('maps missing configuration and all service failures to a generic 503', async () => {
    const unconfigured = makeServer();
    const unavailable = await unconfigured.inject({
      method: 'POST',
      url: REASONING_ANSWER_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { question: 'Why is this unavailable?' },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Reasoning is temporarily unavailable.',
    });

    const failed = makeServer(async () => err(
      'REASONING_REJECTED',
      'private upstream details and status 429',
    ));
    const rejected = await failed.inject({
      method: 'POST',
      url: REASONING_ANSWER_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { question: 'Why was this rejected?' },
    });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.body).not.toContain('private upstream');
    expect(rejected.body).not.toContain('429');
  });
});
