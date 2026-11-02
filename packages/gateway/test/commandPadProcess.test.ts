import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { ClefPad } from '../src/computer/clefPad.js';
import { executePad } from '../src/routes/commandPad.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
describe('fixed command pad process boundaries', () => {
  it('passes search text as URL data, not shell source', async () => {
    const pending = executePad({ requestId: 'test', action: 'search', value: 'hello & x=$(no); #world' });
    const args = vi.mocked(execFile).mock.calls.at(-1)! as unknown as [string, string[], object, (error: Error | null) => void];
    expect(args[0]).toBe('/usr/bin/open');
    expect(args[2]).toMatchObject({ shell: false, timeout: 8000 });
    const url = new URL(args[1][0]!);
    expect(url.origin).toBe('https://www.google.com');
    expect(url.searchParams.get('q')).toBe('hello & x=$(no); #world');
    args[3](null); expect(await pending).toContain('not been verified');
  });
  it('uses fixed SSH argv and bounded JSON for text, then correlates the choice', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    let sent = ''; child.stdin.on('data', data => { sent += String(data); });
    const pad = new ClefPad({ sshHost: 'test-mac', remoteCommand: 'python3 /opt/clef/adapter.py' }), text = 'open Calculator; $(payload)';
    const pending = pad.classify(text);
    const call = vi.mocked(spawn).mock.calls.at(-1)!;
    expect(call[0]).toBe('/usr/bin/ssh'); expect(call[1]).not.toContain(text);
    expect(call[2]).toMatchObject({ shell: false });
    child.stdout.write('{"type":"ready"}\n');
    const request = JSON.parse(sent) as { id: string; text: string };
    expect(request.text).toBe(text);
    child.stdout.write(JSON.stringify({ id: request.id, action: 'open' }) + '\n');
    expect(await pending).toBe('open'); pad.close(); expect(child.kill).toHaveBeenCalled();
  });
  it('handles negation without starting the model', async () => {
    vi.mocked(spawn).mockClear();
    expect(await new ClefPad().classify('Do not close anything')).toBe('ask');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('does not contact a machine when the optional Clef adapter is unconfigured', async () => {
    vi.mocked(spawn).mockClear();
    await expect(new ClefPad({}).classify('open Calculator')).rejects.toThrow('not configured');
    expect(spawn).not.toHaveBeenCalled();
  });
});
