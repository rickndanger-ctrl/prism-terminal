import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import { openDb, type Db } from '../src/db/schema.js';
import {
  createOpenAiRealtimeIssuer,
  OPENAI_API_KEY_ENV,
  realtimeIssuerFromEnv,
  REALTIME_CREDENTIALS_PATH,
  RealtimeCredentialSchema,
  type RealtimeCredential,
  type RealtimeCredentialIssuer,
} from '../src/realtime/credentials.js';
import { buildServer } from '../src/server.js';

const TEST_TOKEN = 'realtime-test-token';
const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN}` };

const servers = new Set<ReturnType<typeof buildServer>>();
const dbs = new Set<Db>();
let originalToken: string | undefined;
let originalKey: string | undefined;

beforeEach(() => {
  originalToken = process.env[GATEWAY_TOKEN_ENV];
  originalKey = process.env[OPENAI_API_KEY_ENV];
  process.env[GATEWAY_TOKEN_ENV] = TEST_TOKEN;
  // Never let a real key in the environment reach these tests.
  delete process.env[OPENAI_API_KEY_ENV];
});

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => server.close()));
  servers.clear();
  for (const db of dbs) {
    db.close();
  }
  dbs.clear();
  restore(GATEWAY_TOKEN_ENV, originalToken);
  restore(OPENAI_API_KEY_ENV, originalKey);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function makeServer(
  issuer: RealtimeCredentialIssuer | undefined,
): ReturnType<typeof buildServer> {
  const db = openDb(':memory:');
  dbs.add(db);
  const server = buildServer(
    issuer === undefined
      ? { db }
      : { db, realtimeCredentialIssuer: issuer },
  );
  servers.add(server);
  return server;
}

const CREDENTIAL: RealtimeCredential = {
  value: 'ephemeral-secret-123',
  expiresAt: '2026-07-16T12:00:00.000Z',
  model: 'gpt-realtime',
  sessionId: 'sess_abc',
};

describe('POST /v1/realtime/credentials', () => {
  it('returns 401 without a token', async () => {
    const server = makeServer(async () => ({ ok: true, value: CREDENTIAL }));

    const response = await server.inject({
      method: 'POST',
      url: REALTIME_CREDENTIALS_PATH,
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });

  it('issues a short-lived credential from the injected issuer', async () => {
    let received: unknown;
    const server = makeServer(async (request) => {
      received = request;
      return { ok: true, value: CREDENTIAL };
    });

    const response = await server.inject({
      method: 'POST',
      url: REALTIME_CREDENTIALS_PATH,
      headers: AUTH_HEADERS,
      payload: { model: 'gpt-realtime' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(RealtimeCredentialSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual(CREDENTIAL);
    expect(received).toEqual({ model: 'gpt-realtime' });
  });

  it('accepts a body with no model (server picks the default)', async () => {
    const server = makeServer(async () => ({ ok: true, value: CREDENTIAL }));

    const response = await server.inject({
      method: 'POST',
      url: REALTIME_CREDENTIALS_PATH,
      headers: AUTH_HEADERS,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects an unknown field with 400', async () => {
    const server = makeServer(async () => ({ ok: true, value: CREDENTIAL }));

    const response = await server.inject({
      method: 'POST',
      url: REALTIME_CREDENTIALS_PATH,
      headers: AUTH_HEADERS,
      payload: { model: 'gpt-realtime', apiKey: 'leak-attempt' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('fails closed with 503 when no issuer is configured', async () => {
    const server = makeServer(undefined);

    const response = await server.inject({
      method: 'POST',
      url: REALTIME_CREDENTIALS_PATH,
      headers: AUTH_HEADERS,
      payload: {},
    });

    expect(response.statusCode).toBe(503);
  });

  it('returns 503 (not a 500) when the issuer fails, leaking no detail', async () => {
    const server = makeServer(async () => ({
      ok: false,
      error: { code: 'REALTIME_ISSUER_REJECTED', message: 'upstream 429 rate limited' },
    }));

    const response = await server.inject({
      method: 'POST',
      url: REALTIME_CREDENTIALS_PATH,
      headers: AUTH_HEADERS,
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('429');
    expect(response.body).not.toContain('upstream');
  });

  it('serves concurrent credential requests independently', async () => {
    let counter = 0;
    const server = makeServer(async () => {
      counter += 1;
      return {
        ok: true,
        value: { ...CREDENTIAL, value: `ephemeral-${counter}` },
      };
    });

    const responses = await Promise.all(
      Array.from({ length: 5 }, async () =>
        server.inject({
          method: 'POST',
          url: REALTIME_CREDENTIALS_PATH,
          headers: AUTH_HEADERS,
          payload: {},
        }),
      ),
    );

    const values = responses.map((response) => {
      expect(response.statusCode).toBe(200);
      return (response.json() as { value: string }).value;
    });
    // Each caller got its own credential; none were dropped or duplicated.
    expect(new Set(values).size).toBe(5);
  });
});

describe('createOpenAiRealtimeIssuer', () => {
  function stubFetch(
    impl: (url: string, init: RequestInit) => Response | Promise<Response>,
  ): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) =>
      impl(String(input), init ?? {})) as unknown as typeof fetch;
  }

  it('calls POST /v1/realtime/client_secrets and returns the ephemeral secret; the key never returns to the caller', async () => {
    let sentUrl: string | undefined;
    let sentAuth: string | undefined;
    let sentBody: unknown;
    const issuer = createOpenAiRealtimeIssuer({
      apiKey: 'sk-long-lived-SECRET',
      fetchImpl: stubFetch((url, init) => {
        sentUrl = url;
        sentAuth = (init.headers as Record<string, string>).authorization;
        sentBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            value: 'ek_ephemeral',
            expires_at: 1_784_000_000,
            session: { id: 'sess_xyz', type: 'realtime', model: 'gpt-realtime' },
          }),
          { status: 200 },
        );
      }),
    });

    const result = await issuer({ model: 'gpt-realtime' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The official endpoint, and the session config in the request body.
    expect(sentUrl).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(sentBody).toEqual({ session: { type: 'realtime', model: 'gpt-realtime' } });
    // The long-lived key went upstream, never into the returned credential.
    expect(sentAuth).toBe('Bearer sk-long-lived-SECRET');
    expect(result.value.value).toBe('ek_ephemeral');
    expect(result.value.sessionId).toBe('sess_xyz');
    // 1_784_000_000 unix seconds, converted to ISO.
    expect(result.value.expiresAt).toBe(
      new Date(1_784_000_000 * 1000).toISOString(),
    );
    expect(JSON.stringify(result.value)).not.toContain('sk-long-lived-SECRET');
  });

  it('maps a non-2xx upstream to a rejected result without the upstream body', async () => {
    const issuer = createOpenAiRealtimeIssuer({
      apiKey: 'sk-x',
      fetchImpl: stubFetch(() => new Response('quota exceeded', { status: 429 })),
    });

    const result = await issuer({});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REALTIME_ISSUER_REJECTED');
    expect(result.error.message).not.toContain('quota');
  });

  it('rejects a malformed upstream response', async () => {
    const issuer = createOpenAiRealtimeIssuer({
      apiKey: 'sk-x',
      fetchImpl: stubFetch(
        () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
      ),
    });

    const result = await issuer({});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REALTIME_ISSUER_BAD_RESPONSE');
  });

  it('surfaces a network failure as unreachable', async () => {
    const issuer = createOpenAiRealtimeIssuer({
      apiKey: 'sk-x',
      fetchImpl: stubFetch(() => {
        throw new Error('ECONNREFUSED');
      }),
    });

    const result = await issuer({});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REALTIME_ISSUER_UNREACHABLE');
  });

  it('maps an upstream 401 (bad long-lived key) to rejected, leaking nothing', async () => {
    const issuer = createOpenAiRealtimeIssuer({
      apiKey: 'sk-wrong',
      fetchImpl: stubFetch(
        () => new Response('{"error":{"message":"invalid api key"}}', { status: 401 }),
      ),
    });

    const result = await issuer({});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REALTIME_ISSUER_REJECTED');
    expect(result.error.message).not.toContain('invalid');
    expect(result.error.message).not.toContain('sk-wrong');
  });

  it('maps an upstream 500 to rejected', async () => {
    const issuer = createOpenAiRealtimeIssuer({
      apiKey: 'sk-x',
      fetchImpl: stubFetch(() => new Response('oops', { status: 500 })),
    });
    const result = await issuer({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REALTIME_ISSUER_REJECTED');
  });

  it('rejects a 200 that omits the secret value', async () => {
    const issuer = createOpenAiRealtimeIssuer({
      apiKey: 'sk-x',
      fetchImpl: stubFetch(
        () => new Response(JSON.stringify({ session: { id: 'sess' } }), { status: 200 }),
      ),
    });
    const result = await issuer({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REALTIME_ISSUER_BAD_RESPONSE');
  });

  it('rejects an empty secret value', async () => {
    const issuer = createOpenAiRealtimeIssuer({
      apiKey: 'sk-x',
      fetchImpl: stubFetch(
        () =>
          new Response(
            JSON.stringify({ value: '', expires_at: 1_784_000_000 }),
            { status: 200 },
          ),
      ),
    });
    const result = await issuer({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REALTIME_ISSUER_BAD_RESPONSE');
  });

  it('rejects a non-positive expires_at', async () => {
    const issuer = createOpenAiRealtimeIssuer({
      apiKey: 'sk-x',
      fetchImpl: stubFetch(
        () =>
          new Response(
            JSON.stringify({ value: 'ek', expires_at: 0 }),
            { status: 200 },
          ),
      ),
    });
    const result = await issuer({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REALTIME_ISSUER_BAD_RESPONSE');
  });

  it('resolves the model from the response session, or the request when absent', async () => {
    const issuer = createOpenAiRealtimeIssuer({
      apiKey: 'sk-x',
      fetchImpl: stubFetch(
        () =>
          new Response(
            // No session.model echoed back — fall back to the requested model.
            JSON.stringify({ value: 'ek', expires_at: 1_784_000_000 }),
            { status: 200 },
          ),
      ),
    });
    const result = await issuer({ model: 'gpt-realtime-2.1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe('gpt-realtime-2.1');
  });

  it('falls back to the default model and sends it in the session body', async () => {
    let sentModel: unknown;
    const issuer = createOpenAiRealtimeIssuer({
      apiKey: 'sk-x',
      defaultModel: 'gpt-realtime-default',
      fetchImpl: stubFetch((_url, init) => {
        const body = JSON.parse(String(init.body)) as { session: { model: string } };
        sentModel = body.session.model;
        return new Response(
          JSON.stringify({
            value: 'ek',
            expires_at: 1_784_000_000,
            session: { model: 'gpt-realtime-default' },
          }),
          { status: 200 },
        );
      }),
    });

    const result = await issuer({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sentModel).toBe('gpt-realtime-default');
    expect(result.value.model).toBe('gpt-realtime-default');
  });
});

describe('realtimeIssuerFromEnv', () => {
  it('is undefined when no key is set (route then fails closed)', () => {
    expect(realtimeIssuerFromEnv({})).toBeUndefined();
    expect(realtimeIssuerFromEnv({ [OPENAI_API_KEY_ENV]: '' })).toBeUndefined();
  });

  it('builds an issuer when the key is present', () => {
    expect(
      realtimeIssuerFromEnv({ [OPENAI_API_KEY_ENV]: 'sk-present' }),
    ).toBeTypeOf('function');
  });
});
