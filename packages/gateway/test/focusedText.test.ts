import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { insertFocusedText, validFocusedText } from '../src/computer/focusedText.js';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
describe('focused literal typing', () => {
  it.each(['', ' ', 'a\nb', 'a\rb', 'a\tb', '\u001b', '\u007f', '\u2028', 'x'.repeat(8001)])('rejects controls or invalid text', text => {
    expect(validFocusedText(text)).toBe(false);
  });
  it('allows literal commands and punctuation as text, never as keystrokes', () => {
    expect(validFocusedText('hello; $(echo literal) and press send')).toBe(true);
  });
  it('sends text only through stdin to a fixed helper, never retries', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    let input = ''; child.stdin.on('data', data => { input += String(data); });
    const pending = insertFocusedText('hello');
    const call = vi.mocked(spawn).mock.calls.at(-1)!;
    expect(String(call[0])).toMatch(/dist\/native\/focused-text$/u);
    expect(call[1]).toEqual([]); expect(call[2]).toMatchObject({ shell: false });
    expect(JSON.parse(input)).toEqual({ text: 'hello' });
    child.stdout.write('INSERTED\n'); child.emit('close', 0);
    expect(await pending).toContain('did not press Enter or Send');
  });
  it('native implementation has no keyboard/clipboard/action fallback', async () => {
    const source = await readFile(new URL('../../../native/FocusedText.swift', import.meta.url), 'utf8');
    expect(source).not.toMatch(/CGEvent\(|AXUIElementPerformAction|NSPasteboard|keyCode|keystroke/u);
    expect(source).toContain('kAXSelectedTextAttribute');
    expect(source).toContain('range.length == 0');
    expect(source).toContain('AXProtectedContent');
    expect(source).toContain('CFEqual(current, target)');
  });
});
