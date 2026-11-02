import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { GEMINI_LIVE_MODEL, GeminiSessionPool } from '../src/realtime/geminiSessionPool.js';

beforeEach(() => { vi.stubEnv('CODEX_LENS_GATEWAY_TOKEN', 'gemini-route-test'); });
afterEach(() => { vi.unstubAllEnvs(); });
const headers = { authorization: 'Bearer gemini-route-test', 'content-type': 'application/sdp' };
const offer = { method: 'POST' as const, url: '/v1/realtime/gemini/calls', headers, payload: 'v=0\r\n' };
function poolFixture() {
  const close = vi.fn();
  const factory = vi.fn(() => ({ answer: async () => 'v=0\r\ns=synthetic\r\n', close }));
  const pool = new GeminiSessionPool(factory);
  return { close, factory, pool };
}

describe('authenticated Gemini signaling', () => {
  it('is disabled by default and does not send Gemini requests to the OpenAI issuer', async () => {
    const issuer = vi.fn(); const server = buildServer({ realtimeCredentialIssuer: issuer });
    try {
      expect((await server.inject(offer)).statusCode).toBe(503);
      const credentials = await server.inject({ method: 'POST', url: '/v1/realtime/credentials',
        headers: { authorization: headers.authorization }, payload: { model: GEMINI_LIVE_MODEL } });
      expect(credentials.statusCode).toBe(503); expect(issuer).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('authenticates both starting and stopping before touching the runtime', async () => {
    const s = poolFixture(); const server = buildServer({ geminiSessions: s.pool });
    try {
      expect((await server.inject({ ...offer, headers: { 'content-type': 'application/sdp' } })).statusCode).toBe(401);
      expect((await server.inject({ method: 'DELETE', url: '/v1/realtime/gemini/calls/00000000-0000-4000-8000-000000000000' })).statusCode).toBe(401);
      expect(s.factory).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('returns only a gateway placeholder for credentials, never a provider secret', async () => {
    const s = poolFixture(); const server = buildServer({ geminiSessions: s.pool });
    try {
      const response = await server.inject({ method: 'POST', url: '/v1/realtime/credentials',
        headers: { authorization: headers.authorization }, payload: { model: GEMINI_LIVE_MODEL } });
      expect(response.statusCode).toBe(200);
      expect(response.json().value).toBe('gateway-owned-gemini-session');
      expect(response.json().model).toBe(GEMINI_LIVE_MODEL);
      expect(s.factory).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('returns SDP and a stop URL, enforces capacity, and makes deletion idempotent', async () => {
    const s = poolFixture(); const server = buildServer({ geminiSessions: s.pool });
    try {
      const response = await server.inject(offer);
      expect(response.statusCode).toBe(201); expect(response.body).toBe('v=0\r\ns=synthetic\r\n');
      expect(response.headers['cache-control']).toBe('no-store');
      const location = String(response.headers.location);
      expect(location).toMatch(/^\/v1\/realtime\/gemini\/calls\/[0-9a-f-]{36}$/);
      expect((await server.inject(offer)).statusCode).toBe(429);
      for (let repeat = 0; repeat < 2; repeat++) {
        expect((await server.inject({ method: 'DELETE', url: location, headers })).statusCode).toBe(204);
      }
      expect(s.close).toHaveBeenCalledOnce(); expect(s.pool.activeCount).toBe(0);
    } finally { await server.close(); }
  });

  it('rejects malformed and oversized offers without starting provider work', async () => {
    const s = poolFixture(); const server = buildServer({ geminiSessions: s.pool });
    try {
      expect((await server.inject({ ...offer, payload: 'invalid' })).statusCode).toBe(400);
      expect((await server.inject({ ...offer, payload: 'v=0' + 'x'.repeat(131072) })).statusCode).toBe(413);
      expect(s.factory).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('closes active sessions on gateway shutdown', async () => {
    const s = poolFixture(); const server = buildServer({ geminiSessions: s.pool });
    await server.inject(offer); await server.close();
    expect(s.close).toHaveBeenCalledOnce(); expect(s.pool.activeCount).toBe(0);
  });

  it('does not expose provider errors or retain a failed session slot', async () => {
    const close = vi.fn();
    const pool = new GeminiSessionPool(() => ({
      answer: async () => { throw new Error('private-provider-detail-and-key'); }, close,
    }));
    const server = buildServer({ geminiSessions: pool });
    try {
      const response = await server.inject(offer);
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('private-provider-detail-and-key');
      expect(close).toHaveBeenCalledOnce(); expect(pool.activeCount).toBe(0);
    } finally { await server.close(); }
  });
});
