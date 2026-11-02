import { execFile } from 'node:child_process';
import { err, ok, type Result } from '@codex-lens/shared';

// Text travels as argv, never executable source. This creates only a new,
// unsaved document; it never types into a terminal or sends a message.
export const TEXTEDIT_DRAFT_SCRIPT = `function run(argv) {
  var app = Application('com.apple.TextEdit');
  var doc = app.Document({text: argv[0]});
  app.documents.push(doc);
  app.activate();
  if (String(doc.text()) !== argv[0]) throw new Error('Text verification failed');
  return 'verified';
}`;

export function parseTextEditDraft(instruction: string): string | undefined {
  const match = /^type in a new textedit document:\s*([\s\S]+)$/iu.exec(instruction.trim());
  const text = match?.[1];
  return text !== undefined && text.length <= 8000 && !text.includes('\0') ? text : undefined;
}

export type TextEditDraftWriter = (text: string) => Promise<Result<{ verified: true }>>;

export const writeTextEditDraft: TextEditDraftWriter = async (text) => {
  if (!text || text.length > 8000 || text.includes('\0')) {
    return err('DRAFT_INVALID', 'The dictated text is empty or too long.');
  }
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', TEXTEDIT_DRAFT_SCRIPT, text],
      { shell: false, timeout: 8000, maxBuffer: 4096 }, (error, stdout) => {
        if (error || stdout.trim() !== 'verified') {
          resolve(err('DRAFT_UNVERIFIED', 'TextEdit may contain a new draft, but its text was not verified. Do not retry automatically.'));
        } else {
          resolve(ok({ verified: true }));
        }
      });
  });
};
