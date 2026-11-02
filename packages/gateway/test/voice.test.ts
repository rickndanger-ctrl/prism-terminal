import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import { LocalSpeechService, type SpeechOptions } from '../src/voice/speech.js';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
const input = { text: 'Hello from the fixture.', voice: 'af_heart' as const };
const headers = { authorization: 'Bearer voice-test-token' };
function fixture(options: SpeechOptions = {}, start = '0') {
  const children: ChildProcessWithoutNullStreams[] = [];
  const spawnWorker = vi.fn((python: string, worker: string) => {
    const child = spawn(python, [worker], { stdio: ['pipe', 'pipe', 'pipe'], env: { VOICE_TEST_START: start } });
    children.push(child);
    vi.spyOn(child.stdin, 'write');
    return child;
  });
  const service = new LocalSpeechService({ pythonPath: process.execPath,
    workerPath: fileURLToPath(new URL('./fixtures/voice-worker.mjs', import.meta.url)), spawnWorker, ...options });
  closes.push(() => service.close());
  return { service, children, spawnWorker };
}
function serverFor(service: LocalSpeechService) {
  vi.stubEnv(GATEWAY_TOKEN_ENV, 'voice-test-token');
  const server = buildServer({ localSpeechService: service });
  closes.push(() => server.close());
  return server;
}
describe('local free voice gateway', () => {
  it('does not pass provider keys or the gateway token to the real child-process boundary', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'not-a-real-key');
    vi.stubEnv('HF_TOKEN', 'not-a-real-token');
    vi.stubEnv(GATEWAY_TOKEN_ENV, 'not-a-real-gateway-token');
    const service = new LocalSpeechService({ pythonPath: process.execPath,
      workerPath: fileURLToPath(new URL('./fixtures/voice-worker.mjs', import.meta.url)) });
    closes.push(() => service.close());
    expect(await service.synthesize({ ...input, text: 'environment-check' })).toBeInstanceOf(Buffer);
  });
  it('fails closed without absolute configured paths and never starts a worker', async () => {
    const spawnWorker = vi.fn();
    const service = new LocalSpeechService({ pythonPath: 'python', workerPath: '/worker.py', spawnWorker });
    expect(service.status()).toMatchObject({ ready: false, state: 'disabled', provider: 'kokoro' });
    await expect(service.synthesize(input)).rejects.toMatchObject({ statusCode: 503 });
    expect(spawnWorker).not.toHaveBeenCalled();
    await service.close();
  });
  it('authenticates both endpoints before starting or sending to the worker', async () => {
    const f = fixture(), server = serverFor(f.service);
    expect((await server.inject({ url: '/v1/voice/status' })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/v1/voice/speech', payload: input })).statusCode).toBe(401);
    expect(f.spawnWorker).not.toHaveBeenCalled();
  });
  it.each([
    { text: '', voice: 'af_heart' }, { text: '  ', voice: 'af_heart' },
    { text: 'x'.repeat(2001), voice: 'af_heart' }, { text: 'hello', voice: 'https://example.com/voice' },
    { text: 'hello', voice: 'af_heart', speed: 0.84 }, { text: 'hello', voice: 'af_heart', speed: 1.16 },
    { text: 'hello', voice: 'af_heart', speed: '1' }, { text: 'hello', voice: 'af_heart', command: 'sh' },
    { text: 'hello' },
  ])('rejects invalid or extensible client inputs: %j', async (payload) => {
    const f = fixture(), server = serverFor(f.service);
    const result = await server.inject({ method: 'POST', url: '/v1/voice/speech', headers, payload });
    expect(result.statusCode).toBe(400);
    expect(result.json().message).toBe('Invalid speech request.');
    expect(f.spawnWorker).not.toHaveBeenCalled();
  });
  it('reports nonblocking warmup and reuses one worker for valid binary WAV replies', async () => {
    const f = fixture({}, '75'), server = serverFor(f.service);
    expect((await server.inject({ url: '/v1/voice/status', headers })).json()).toMatchObject({ state: 'warming', ready: false });
    await vi.waitFor(() => expect(f.service.status()).toMatchObject({ state: 'ready', ready: true }));
    for (const voice of ['af_heart', 'am_michael']) {
      const response = await server.inject({ method: 'POST', url: '/v1/voice/speech', headers,
        payload: { text: '  Hello  ', voice, speed: 1.15 } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('audio/wav');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.rawPayload.toString('ascii', 0, 4)).toBe('RIFF');
      expect(response.rawPayload.readUInt32LE(24)).toBe(24000);
    }
    expect(f.spawnWorker).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(f.children[0]!.stdin.write).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(sent).toEqual([expect.objectContaining({ text: 'Hello', voice: 'af_heart', speed: 1.15 }), expect.objectContaining({ text: 'Hello', voice: 'am_michael', speed: 1.15 })]);
    expect(sent[0].id).not.toBe(sent[1].id);
    await server.close();
    expect(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null).toBe(true);
  });
  it('bounds the waiting queue; cancelling queued work does not kill another request', async () => {
    const f = fixture({ maxPendingRequests: 2 }), active = new AbortController(), queued = new AbortController();
    const first = f.service.synthesize({ ...input, text: 'hang' }, active.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.service.status().ready).toBe(true));
    const second = f.service.synthesize(input, queued.signal).catch((error: unknown) => error);
    await expect(f.service.synthesize(input)).rejects.toMatchObject({ statusCode: 429 });
    queued.abort();
    expect(await second).toMatchObject({ statusCode: 499 });
    expect(f.children[0]!.killed).toBe(false);
    active.abort();
    expect(await first).toMatchObject({ statusCode: 499 });
    expect(await f.service.synthesize(input)).toBeInstanceOf(Buffer);
    expect(f.spawnWorker).toHaveBeenCalledTimes(2);
  });
  it('times out an active request, reaps its process, and can serve the next request', async () => {
    // This starts real fixture subprocesses. Give a fresh process room to
    // launch on shared CI while still explicitly proving timeout/recovery.
    const f = fixture({ requestTimeoutMs: 1000 });
    await expect(f.service.synthesize({ ...input, text: 'hang' })).rejects.toMatchObject({ statusCode: 504 });
    expect(await f.service.synthesize(input)).toBeInstanceOf(Buffer);
    expect(f.spawnWorker).toHaveBeenCalledTimes(2);
    expect(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null).toBe(true);
  });
  it('bounds startup and reports unavailable without repeatedly spawning on status polls', async () => {
    const f = fixture({ startupTimeoutMs: 30 }, 'hang');
    expect(f.service.status().state).toBe('warming');
    await vi.waitFor(() => expect(f.service.status().state).toBe('unavailable'));
    expect(f.service.status().ready).toBe(false);
    expect(f.spawnWorker).toHaveBeenCalledTimes(1);
  });
  it.each(['error', 'bad-audio', 'wrong-owner', 'crash'])('redacts worker failure and never returns another request audio: %s', async (text) => {
    const f = fixture(), server = serverFor(f.service);
    const response = await server.inject({ method: 'POST', url: '/v1/voice/speech', headers, payload: { ...input, text } });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private-path');
    expect(response.body).not.toContain('audioBase64');
  });
  it('cancels active synthesis when the authenticated HTTP client disconnects', async () => {
    const f = fixture(), server = serverFor(f.service);
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = fetch(base + '/v1/voice/speech', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, text: 'hang' }), signal: controller.signal }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.children[0]?.stdin.write).toHaveBeenCalled());
    controller.abort();
    expect(await response).toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null).toBe(true));
  });
  it('shutdown rejects active and queued work and prevents future launches', async () => {
    const f = fixture();
    const first = f.service.synthesize({ ...input, text: 'hang' }).catch((error: unknown) => error);
    const second = f.service.synthesize(input).catch((error: unknown) => error);
    await f.service.close();
    expect(await first).toMatchObject({ statusCode: 503 });
    expect(await second).toMatchObject({ statusCode: 503 });
    await expect(f.service.synthesize(input)).rejects.toMatchObject({ statusCode: 503 });
    expect(f.service.status().state).toBe('unavailable');
  });
});
