import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '@codex-lens/shared';
import { execFile } from 'node:child_process';
import { parseTextEditDraft, writeTextEditDraft, TEXTEDIT_DRAFT_SCRIPT } from '../src/computer/textEditDraft.js';
import { createCodexAssistantTaskWorker } from '../src/assistant/codexTaskWorker.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFile: vi.fn(),
}));

describe('explicit new TextEdit dictation', () => {
  it('preserves literal text, punctuation, and newlines', () => {
    expect(parseTextEditDraft('Type in a new TextEdit document: Hello.\nSecond line!'))
      .toBe('Hello.\nSecond line!');
  });
  it.each(['type hello', 'type into Terminal: ls', 'append to TextEdit: hello',
    'do not type in a new TextEdit document: hello', 'type in a new TextEdit document:'])(
    'does not reinterpret %s', instruction => expect(parseTextEditDraft(instruction)).toBeUndefined());
  it('passes literal dictated content only as argv to the fixed native draft script', async () => {
    vi.mocked(execFile).mockClear();
    const text = 'hello; $(do-not-run) "quoted"\nsecond line';
    const result = writeTextEditDraft(text);
    const invocation = vi.mocked(execFile).mock.calls[0] as unknown as [
      string, string[], Record<string, unknown>, (error: Error | null, stdout: string) => void,
    ];
    expect(invocation.slice(0, 3)).toEqual(['/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', TEXTEDIT_DRAFT_SCRIPT, text], { shell: false, timeout: 8000, maxBuffer: 4096 }]);
    expect(TEXTEDIT_DRAFT_SCRIPT).not.toContain(text);
    invocation[3](null, 'verified\n');
    expect(await result).toEqual(ok({ verified: true }));
    expect(execFile).toHaveBeenCalledOnce();
  });
  it('uses no model and never retries an uncertain write', async () => {
    const writeDraft = vi.fn().mockResolvedValueOnce(ok({ verified: true }))
      .mockResolvedValueOnce(err('DRAFT_UNVERIFIED', 'uncertain'));
    const startClient = vi.fn();
    const worker = createCodexAssistantTaskWorker({ writeDraft, startClient });
    const input = { taskId: 'draft-test', instruction: 'Type in a new TextEdit document: Hello',
      scope: 'mac' as const, workingDirectory: '/tmp', authorization: 'single_utterance' as const };
    const first = await worker(input);
    expect(first.ok).toBe(true);
    expect(await worker(input)).toMatchObject({ ok: false, error: { code: 'DRAFT_UNVERIFIED' } });
    expect(startClient).not.toHaveBeenCalled();
    expect(writeDraft).toHaveBeenCalledTimes(2);
  });
});
