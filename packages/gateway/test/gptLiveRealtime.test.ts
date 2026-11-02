import { err, ok, type Result } from '@codex-lens/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createGptLiveSessionStarter,
  GPT_LIVE_CALLS_PATH,
  GPT_LIVE_GATEWAY_CREDENTIAL,
  GPT_LIVE_MODEL,
  gptLiveSessionStarterFromEnv,
  type GptLiveAnswer,
  type GptLiveSessionStarter,
} from '../src/realtime/gptLive.js';
import { buildServer } from '../src/server.js';

beforeEach(() => {
  vi.stubEnv('CODEX_LENS_GATEWAY_TOKEN', 'gpt-live-route-test');
  // Never let a real key in the environment reach these tests.
  vi.stubEnv('OPENAI_API_KEY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const authorization = 'Bearer gpt-live-route-test';
const offer = {
  method: 'POST' as const,
  url: GPT_LIVE_CALLS_PATH,
  headers: { authorization, 'content-type': 'application/sdp' },
  payload: 'v=0\r\no=phone\r\n',
};
const ANSWER = 'v=0\r\ns=gpt-live\r\n';

function starterFixture(
  result: Result<GptLiveAnswer> = ok({ sessionId: 'live_123', sdp: ANSWER }),
) {
  return vi.fn<GptLiveSessionStarter>(async () => result);
}

function credentialRequest() {
  return {
    method: 'POST' as const,
    url: '/v1/realtime/credentials',
    headers: { authorization },
    payload: { model: GPT_LIVE_MODEL },
  };
}

describe('GPT Live signaling', () => {
  it('fails closed without a key and never falls through to the Realtime issuer', async () => {
    const issuer = vi.fn();
    const server = buildServer({ realtimeCredentialIssuer: issuer });
    try {
      expect((await server.inject(offer)).statusCode).toBe(503);
      expect((await server.inject(credentialRequest())).statusCode).toBe(503);
      expect(issuer).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('authenticates before starting a provider session', async () => {
    const starter = starterFixture();
    const server = buildServer({ gptLiveSessionStarter: starter });
    try {
      const response = await server.inject({
        ...offer,
        headers: { 'content-type': 'application/sdp' },
      });
      expect(response.statusCode).toBe(401);
      expect(starter).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('returns only a gateway placeholder credential, never a provider secret', async () => {
    const starter = starterFixture();
    const issuer = vi.fn();
    const server = buildServer({ gptLiveSessionStarter: starter, realtimeCredentialIssuer: issuer });
    try {
      const response = await server.inject(credentialRequest());
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        value: GPT_LIVE_GATEWAY_CREDENTIAL,
        model: GPT_LIVE_MODEL,
      });
      expect(starter).not.toHaveBeenCalled();
      expect(issuer).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('exchanges the SDP offer for the provider answer without caching', async () => {
    const starter = starterFixture();
    const server = buildServer({ gptLiveSessionStarter: starter });
    try {
      const response = await server.inject(offer);
      expect(response.statusCode).toBe(201);
      expect(response.body).toBe(ANSWER);
      expect(response.headers['content-type']).toContain('application/sdp');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(starter).toHaveBeenCalledOnce();
      expect(starter.mock.calls[0]?.[0]).toBe(offer.payload);
    } finally {
      await server.close();
    }
  });

  it('rejects malformed and oversized offers without starting provider work', async () => {
    const starter = starterFixture();
    const server = buildServer({ gptLiveSessionStarter: starter });
    try {
      expect((await server.inject({ ...offer, payload: 'invalid' })).statusCode).toBe(400);
      expect(
        (await server.inject({ ...offer, payload: 'v=0' + 'x'.repeat(131072) })).statusCode,
      ).toBe(413);
      expect(starter).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('hides provider failures behind a generic 503', async () => {
    const starter = starterFixture(err('GPT_LIVE_REJECTED', 'status 403: secret-detail'));
    const server = buildServer({ gptLiveSessionStarter: starter });
    try {
      const response = await server.inject(offer);
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('secret-detail');
      expect(response.body).not.toContain('403');
    } finally {
      await server.close();
    }
  });
});

describe('createGptLiveSessionStarter', () => {
  it('creates a gpt-live-1 WebRTC session with only the bounded phone tools', async () => {
    let sentUrl = '';
    let sentInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sentUrl = String(url);
      sentInit = init;
      return new Response(
        JSON.stringify({
          session: { id: 'live_123', model: GPT_LIVE_MODEL },
          transport: { type: 'webrtc', sdp: ANSWER },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const starter = createGptLiveSessionStarter({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await starter(offer.payload);

    expect(result).toEqual({ ok: true, value: { sessionId: 'live_123', sdp: ANSWER } });
    expect(sentUrl).toBe('https://api.openai.com/v1/live/sessions');
    expect(new Headers(sentInit?.headers).get('authorization')).toBe('Bearer sk-test');
    const body = JSON.parse(String(sentInit?.body)) as {
      session: {
        model: string;
        delegation: {
          type: string;
          responses: { tools: { type: string; name?: string }[]; parallel_tool_calls: boolean };
        };
      };
      transport: { type: string; sdp: string };
    };
    expect(body.session.model).toBe(GPT_LIVE_MODEL);
    expect(body.transport).toEqual({ type: 'webrtc', sdp: offer.payload });
    expect(body.session.delegation.type).toBe('responses');
    expect(body.session.delegation.responses.parallel_tool_calls).toBe(false);
    expect(body.session.delegation.responses.tools.map((tool) => tool.name ?? tool.type)).toEqual([
      'web_search',
      'get_current_time',
      'get_assistant_task_status',
      'capture_glasses_view',
      'inspect_mac_app',
      'inspect_codex_project',
      'get_frontmost_mac_app',
      'reason_question',
      'research_web',
      'prepare_assistant_task',
      'start_prepared_assistant_task',
      'cancel_assistant_task',
    ]);
  });

  it('reports a rejected session without leaking the upstream body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"secret upstream detail"}}', { status: 403 }),
    );
    const result = await createGptLiveSessionStarter({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })(offer.payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('GPT_LIVE_REJECTED');
      expect(result.error.message).not.toContain('secret');
    }
  });

  it('rejects a response without a WebRTC answer', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'not-sdp' } }),
          { status: 200 },
        ),
    );
    const result = await createGptLiveSessionStarter({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })(offer.payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('GPT_LIVE_BAD_RESPONSE');
  });

  it('does not call OpenAI without a key', async () => {
    const fetchImpl = vi.fn();
    const result = await createGptLiveSessionStarter({
      apiKey: '  ',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })(offer.payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('GPT_LIVE_KEY_MISSING');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is absent unless OPENAI_API_KEY is configured', () => {
    expect(gptLiveSessionStarterFromEnv({})).toBeUndefined();
    expect(gptLiveSessionStarterFromEnv({ OPENAI_API_KEY: ' ' })).toBeUndefined();
    expect(gptLiveSessionStarterFromEnv({ OPENAI_API_KEY: 'sk-test' })).toBeTypeOf('function');
  });
});
