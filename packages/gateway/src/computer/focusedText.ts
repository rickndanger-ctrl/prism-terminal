import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export function validFocusedText(text: string): boolean {
  // eslint-disable-next-line no-control-regex -- control bytes must never become Enter or Send
  return !!text.trim() && text.length <= 8000 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text);
}
export async function insertFocusedText(text: string): Promise<string> {
  if (!validFocusedText(text)) return 'Nothing typed. Dictation must be one line without control characters.';
  return new Promise(resolveResult => {
    const child = spawn(resolve('dist/native/focused-text'), [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (summary: string) => {
      if (settled) return; settled = true; clearTimeout(timer); resolveResult(summary);
    };
    const timer = setTimeout(() => {
      child.kill(); finish('Typing could not be verified. Check the field before retrying; nothing was sent or submitted by the helper.');
    }, 5000);
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString('utf8');
      if (output.length > 512) { child.kill(); finish('Typing outcome unknown. Check the field before retrying.'); }
    });
    child.on('error', () => finish('Focused typing is unavailable. Nothing was typed.'));
    child.on('close', code => {
      const status = output.trim();
      if (code === 0 && status === 'INSERTED') finish('Typed into the focused field. I did not press Enter or Send.');
      else if (['NO_EDITABLE_FIELD', 'UNSUPPORTED_FIELD'].includes(status)) finish('Nothing typed. Place the cursor in a supported editable field with no text selected, then ask again.');
      else if (status === 'UNSAFE_FIELD') finish('Nothing typed. Password and terminal fields are blocked.');
      else if (status === 'FOCUS_CHANGED') finish('Nothing typed. The focused field changed.');
      else if (status === 'ACCESSIBILITY_REQUIRED') finish('Nothing typed. The Mac typing helper needs Accessibility permission.');
      else finish('Typing could not be verified. Check the field before retrying.');
    });
    child.stdin.end(JSON.stringify({ text }));
  });
}
