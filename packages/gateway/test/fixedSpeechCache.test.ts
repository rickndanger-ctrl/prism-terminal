import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIXED_SPEECH_CACHE_LIMITS, LocalSpeechService, type SpeechInput } from '../src/voice/speech.js';
import { registerVoiceRoutes } from '../src/routes/voice.js';
import { executePad, PAD_APPS } from '../src/routes/commandPad.js';
import { closeFrontmostComputerWindow, focusComputerApp } from '../src/computer/codexComputer.js';
import { writeTextEditDraft } from '../src/computer/textEditDraft.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFile: vi.fn(),
}));
vi.mock('../src/computer/codexComputer.js', () => ({ closeFrontmostComputerWindow: vi.fn(), focusComputerApp: vi.fn() }));
vi.mock('../src/computer/textEditDraft.js', () => ({ writeTextEditDraft: vi.fn() }));

type Request = SpeechInput & { id: string };
const input: SpeechInput = { text: 'Calculator is frontmost.', voice: 'af_heart' };
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

function wav(size = 48): Buffer {
  const audio = Buffer.alloc(size);
  audio.write('RIFF'); audio.writeUInt32LE(size - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(size - 44, 40);
  return audio;
}

// In-memory protocol fixture: no model, subprocess, filesystem audio or network.
function fixture(reply: (request: Request, count: number) => Buffer | Error | undefined = () => wav()) {
  const requests: Request[] = [];
  const kills = vi.fn();
  const spawnWorker = vi.fn(() => {
    const events = new EventEmitter(), stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const child = Object.assign(events, { stdin, stdout, stderr, kill: () => { kills(); events.emit('exit', 0, null); return true; } });
    let pending = '';
    stdin.on('data', (data: Buffer) => {
      pending += data.toString();
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        const request = JSON.parse(pending.slice(0, end)) as Request;
        pending = pending.slice(end + 1); requests.push(request);
        const audio = reply(request, requests.length);
        if (audio === undefined) continue;
        stdout.write(JSON.stringify(audio instanceof Error ? { id: request.id, error: 'fixture failure' }
          : { id: request.id, format: 'wav', sampleRate: 24000, audioBase64: audio.toString('base64') }) + '\n');
      }
    });
    queueMicrotask(() => stdout.write(JSON.stringify({ type: 'ready', provider: 'kokoro', voices: ['af_heart', 'am_michael'], sampleRate: 24000 }) + '\n'));
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const service = new LocalSpeechService({ pythonPath: '/fixture/python', workerPath: '/fixture/worker', spawnWorker });
  closes.push(() => service.close());
  return { service, requests, spawnWorker, kills };
}

describe('bounded nonpersonal result speech cache', () => {
  it('reuses successful fixed audio and owns copies of stored and returned buffers', async () => {
    const f = fixture();
    const first = await f.service.synthesize(input);
    first.fill(0);
    const second = await f.service.synthesize(input);
    expect(second.toString('ascii', 0, 4)).toBe('RIFF');
    second.fill(0);
    expect((await f.service.synthesize(input)).toString('ascii', 0, 4)).toBe('RIFF');
    expect(f.requests).toHaveLength(1); expect(f.spawnWorker).toHaveBeenCalledTimes(1);
  });

  it('keys exact text, voice and speed while treating omitted speed as one', async () => {
    const f = fixture();
    await f.service.synthesize(input);
    await f.service.synthesize({ ...input, speed: 1 });
    await f.service.synthesize({ ...input, voice: 'am_michael' });
    await f.service.synthesize({ ...input, speed: 1.1 });
    await f.service.synthesize({ ...input, text: 'Finder is frontmost.' });
    for (const { text, voice, speed } of f.requests.slice()) await f.service.synthesize({ text, voice, speed });
    expect(f.requests).toHaveLength(4);
  });

  it.each(['A private draft says hello.', 'Calculator is frontmost. Also a personal note.', 'Done.',
    'Closed the window in Notes. Also a personal note.',
    'Closed the window in Notes: a private document.',
    'Search handed to the default browser. Page results have not been verified. Query: private notes.',
    'Verified the text in a new unsaved TextEdit document. Nothing was sent. Draft: private notes.'])(
    'never caches nonallowlisted speech: %s', async text => {
      const f = fixture();
      await f.service.synthesize({ ...input, text }); await f.service.synthesize({ ...input, text });
      expect(f.requests).toHaveLength(2);
    });

  it.each([
    'Safari is frontmost.', 'Minimized the window.', 'Restored the window.', 'Maximized the window.',
    'Moved the window to the left half.', 'Moved the window to the right half.',
    'Went back a page.', 'Went forward a page.', 'Opened a new browser tab.',
    'Switched to the next tab.', 'Switched to the previous tab.', 'Closed the current tab.',
    'Focused the browser address bar.', 'Opened the address in the current tab. Page loading is not verified.',
    'Requested a page reload. Page loading is not verified.',
    'Typed into the focused field. I did not press Enter or Send.',
  ])('caches the exact bounded desktop summary without rewriting its claim: %s', async text => {
    const f = fixture();
    await f.service.synthesize({ ...input, text }); await f.service.synthesize({ ...input, text });
    expect(f.requests).toHaveLength(1); expect(f.requests[0]?.text).toBe(text);
  });

  it.each(PAD_APPS)('caches actual open/close executor summaries only after execution: %s', async app => {
    const f = fixture();
    const focus = vi.mocked(focusComputerApp).mockReset().mockResolvedValue({ ok: true, value: { app, frontmost: true } });
    const close = vi.mocked(closeFrontmostComputerWindow).mockReset().mockResolvedValue({ ok: true,
      value: { app, windowTitle: 'private title fixture', closed: true, needsUserDecision: false } });
    const summaries = [
      await executePad({ requestId: 'fixture-open', action: 'open', value: app }),
      await executePad({ requestId: 'fixture-close', action: 'close', value: '' }),
    ];
    expect(f.requests).toHaveLength(0); // No eager synthesis or side-effect replay.
    for (const text of summaries) {
      await f.service.synthesize({ ...input, text }); await f.service.synthesize({ ...input, text });
    }
    expect(f.requests.map(request => request.text)).toEqual(summaries);
    expect(f.requests.every(request => !request.text.includes('private title fixture'))).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  });

  it('caches the actual search handoff without caching its query or claiming loaded results', async () => {
    const f = fixture(), search = vi.mocked(execFile).mockReset();
    const pending = executePad({ requestId: 'fixture-search', action: 'search', value: 'private query fixture' });
    const call = search.mock.calls.at(-1)! as unknown as [string, string[], object, (error: Error | null) => void];
    call[3](null);
    const text = await pending;
    expect(text).toBe('Search handed to the default browser. Page results have not been verified.');
    expect(f.requests).toHaveLength(0);
    await f.service.synthesize({ ...input, text }); await f.service.synthesize({ ...input, text });
    expect(f.requests).toHaveLength(1); expect(f.requests[0]?.text).toBe(text);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('caches the actual explicit TextEdit summary without caching the dictated document', async () => {
    const f = fixture();
    const write = vi.mocked(writeTextEditDraft).mockReset().mockResolvedValue({ ok: true,
      value: { verified: true } });
    const text = await executePad({ requestId: 'fixture-type', action: 'type', value: 'private draft fixture' });
    expect(text).toBe('Verified the text in a new unsaved TextEdit document. Nothing was sent.');
    expect(f.requests).toHaveLength(0);
    await f.service.synthesize({ ...input, text }); await f.service.synthesize({ ...input, text });
    expect(f.requests).toHaveLength(1); expect(f.requests[0]?.text).toBe(text);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('does not cache an actual close result for an unknown or personalized app name', async () => {
    const f = fixture();
    vi.mocked(closeFrontmostComputerWindow).mockReset().mockResolvedValue({ ok: true,
      value: { app: 'Private Client Notes', closed: true, needsUserDecision: false } });
    const text = await executePad({ requestId: 'fixture-unknown', action: 'close', value: '' });
    expect(text).toBe('Closed the window in Private Client Notes.');
    await f.service.synthesize({ ...input, text }); await f.service.synthesize({ ...input, text });
    expect(f.requests).toHaveLength(2);
  });

  it('does not cache a failed synthesis', async () => {
    const f = fixture((_request, count) => count === 1 ? new Error('failure') : wav());
    await expect(f.service.synthesize(input)).rejects.toMatchObject({ statusCode: 503 });
    await f.service.synthesize(input); await f.service.synthesize(input);
    expect(f.requests).toHaveLength(2);
  });

  it('does not cache invalid RIFF data', async () => {
    const f = fixture((_request, count) => count === 1 ? Buffer.alloc(48) : wav());
    await expect(f.service.synthesize(input)).rejects.toMatchObject({ statusCode: 503 });
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 6000);
    await f.service.synthesize(input); await f.service.synthesize(input);
    expect(f.requests).toHaveLength(2);
  });

  it('honors aborted and immediately cancelled cache hits without starting work', async () => {
    const f = fixture(); await f.service.synthesize(input);
    const already = new AbortController(); already.abort();
    await expect(f.service.synthesize(input, already.signal)).rejects.toMatchObject({ statusCode: 499 });
    const immediate = new AbortController();
    const pending = f.service.synthesize(input, immediate.signal); immediate.abort();
    await expect(pending).rejects.toMatchObject({ statusCode: 499 });
    expect(f.requests).toHaveLength(1); expect(f.kills).not.toHaveBeenCalled();
  });

  it('does not cache a cancelled allowlisted synthesis', async () => {
    const f = fixture((_request, count) => count === 1 ? undefined : wav());
    const controller = new AbortController();
    const pending = f.service.synthesize(input, controller.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    controller.abort(); expect(await pending).toMatchObject({ statusCode: 499 });
    await f.service.synthesize(input); await f.service.synthesize(input);
    expect(f.requests).toHaveLength(2); expect(f.spawnWorker).toHaveBeenCalledTimes(2);
  });

  it('never serves cached audio after close, including a close before delivery', async () => {
    const f = fixture(); await f.service.synthesize(input);
    const pending = f.service.synthesize(input).catch((error: unknown) => error);
    await f.service.close();
    expect(await pending).toMatchObject({ statusCode: 503 });
    await expect(f.service.synthesize(input)).rejects.toMatchObject({ statusCode: 503 });
    expect(f.requests).toHaveLength(1);
  });

  it('still requires absolute configured paths', async () => {
    const spawnWorker = vi.fn();
    const service = new LocalSpeechService({ pythonPath: 'python', workerPath: '/worker', spawnWorker });
    closes.push(() => service.close());
    await expect(service.synthesize(input)).rejects.toMatchObject({ statusCode: 503 });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it('a cache hit neither queues behind nor cancels another active synthesis', async () => {
    const f = fixture(request => request.text === 'hang' ? undefined : wav());
    await f.service.synthesize(input);
    const controller = new AbortController();
    const active = f.service.synthesize({ ...input, text: 'hang' }, controller.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect((await f.service.synthesize(input)).toString('ascii', 0, 4)).toBe('RIFF');
    expect(f.requests).toHaveLength(2); expect(f.kills).not.toHaveBeenCalled();
    controller.abort(); expect(await active).toMatchObject({ statusCode: 499 });
  });

  it('evicts least recently used entries at the entry limit', async () => {
    const f = fixture();
    const variants = Array.from({ length: FIXED_SPEECH_CACHE_LIMITS.entries + 1 }, (_, i) => ({ ...input, speed: 0.85 + i / 1000 }));
    for (const item of variants.slice(0, -1)) await f.service.synthesize(item);
    await f.service.synthesize(variants[0]!); // Keep the oldest-inserted one hot.
    await f.service.synthesize(variants.at(-1)!);
    expect(f.requests).toHaveLength(FIXED_SPEECH_CACHE_LIMITS.entries + 1);
    await f.service.synthesize(variants[0]!);
    expect(f.requests).toHaveLength(FIXED_SPEECH_CACHE_LIMITS.entries + 1);
    await f.service.synthesize(variants[1]!);
    expect(f.requests).toHaveLength(FIXED_SPEECH_CACHE_LIMITS.entries + 2);
  });

  it('evicts at the byte bound before the entry bound', async () => {
    const bytes = 500_000, f = fixture(() => wav(bytes));
    const count = Math.floor(FIXED_SPEECH_CACHE_LIMITS.bytes / bytes) + 1;
    expect(count).toBeLessThan(FIXED_SPEECH_CACHE_LIMITS.entries);
    for (let i = 0; i < count; i++) await f.service.synthesize({ ...input, speed: 0.85 + i / 1000 });
    await f.service.synthesize({ ...input, speed: 0.85 });
    expect(f.requests).toHaveLength(count + 1);
  });

  it('does not cache oversized audio even for an allowlisted phrase', async () => {
    const f = fixture(() => wav(FIXED_SPEECH_CACHE_LIMITS.entryBytes + 1));
    await f.service.synthesize(input); await f.service.synthesize(input);
    expect(f.requests).toHaveLength(2);
  });

  it('retains HTTP no-store for both fresh and cached audio', async () => {
    const f = fixture(), server = Fastify(); registerVoiceRoutes(server, f.service);
    closes.push(() => server.close());
    for (let i = 0; i < 2; i++) {
      const response = await server.inject({ method: 'POST', url: '/v1/voice/speech', payload: input });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(response.rawPayload.toString('ascii', 0, 4)).toBe('RIFF');
    }
    expect(f.requests).toHaveLength(1);
  });
});
