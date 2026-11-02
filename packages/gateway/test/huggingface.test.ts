import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';

beforeEach(() => {
  vi.stubEnv('CODEX_LENS_GATEWAY_TOKEN', 'hf-test');
  vi.stubEnv('CODEX_LENS_HF_ENABLED', '1');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('rejects malformed offers and does not contact a disabled backend', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const server = buildServer();
  const request = {method:'POST' as const,url:'/v1/realtime/huggingface/calls',headers:{authorization:'Bearer hf-test','content-type':'application/sdp'},payload:'invalid'};
  try {
    expect((await server.inject(request)).statusCode).toBe(400);
    vi.stubEnv('CODEX_LENS_HF_ENABLED','0');
    expect((await server.inject({...request,payload:'v=0\r\n'})).statusCode).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await server.close(); }
});

it('fails safely on upstream failure without leaking details', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private server detail')));
  const server = buildServer();
  try {
    const result = await server.inject({method:'POST',url:'/v1/realtime/huggingface/calls',headers:{authorization:'Bearer hf-test','content-type':'application/sdp'},payload:'v=0\r\n'});
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain('private server detail');
  } finally { await server.close(); }
});

it('rejects unauthenticated signaling without contacting HF', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const server = buildServer();
  try {
    const result = await server.inject({method:'POST',url:'/v1/realtime/huggingface/calls',headers:{'content-type':'application/sdp'},payload:'v=0\r\n'});
    expect(result.statusCode).toBe(401); expect(fetcher).not.toHaveBeenCalled();
  } finally { await server.close(); }
});

it('proxies only the fixed local SDP endpoint and never forwards credentials', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('v=0\r\ns=HF\r\n',{status:201})); vi.stubGlobal('fetch', fetcher);
  const server = buildServer();
  try {
    const result = await server.inject({method:'POST',url:'/v1/realtime/huggingface/calls',headers:{authorization:'Bearer hf-test','content-type':'application/sdp'},payload:'v=0\r\n'});
    expect(result.statusCode).toBe(201);
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8765/v1/realtime/calls');
    expect(fetcher.mock.calls[0]?.[1].headers).toEqual({'content-type':'application/sdp'});
  } finally { await server.close(); }
});

it('fails closed when disabled and returns no OpenAI key for HF credentials', async () => {
  const server = buildServer();
  try {
    const request = {method:'POST' as const,url:'/v1/realtime/credentials',headers:{authorization:'Bearer hf-test'},payload:{model:'huggingface'}};
    const enabled = await server.inject(request);
    expect(enabled.statusCode).toBe(200); expect(enabled.json().value).toBe('gateway-owned-hf-session');
    vi.stubEnv('CODEX_LENS_HF_ENABLED','0');
    expect((await server.inject(request)).statusCode).toBe(503);
  } finally { await server.close(); }
});
