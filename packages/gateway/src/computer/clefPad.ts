import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const PAD_ACTIONS = ['open', 'close', 'type', 'search', 'ask'] as const;
export type PadAction = typeof PAD_ACTIONS[number];
export function needsPadClarification(text: string): boolean {
  return /\b(?:not|never|don't|don’t|stop|cancel|if|maybe|hypothetically|send|delete|remove|purchase|buy)\b|["“”]/iu.test(text);
}

// On-demand encrypted local-Mac transport. No cloud model, shell-supplied user
// input, daemon listener, or interaction with the voice worker.
export class ClefPad {
  constructor(private readonly options: { sshHost?: string; remoteCommand?: string } = {
    sshHost: process.env.CODEX_LENS_CLEF_SSH_HOST,
    remoteCommand: process.env.CODEX_LENS_CLEF_REMOTE_COMMAND,
  }) {}
  private child?: ChildProcessWithoutNullStreams;
  private pending?: { id: string; resolve: (action: PadAction) => void; reject: (error: Error) => void };
  private timer?: NodeJS.Timeout;
  private idle?: NodeJS.Timeout;
  private buffer = '';
  private ready = false;
  private text = '';
  async classify(text: string): Promise<PadAction> {
    if (this.pending) throw new Error('Clef is busy.');
    if (!text.trim() || text.length > 2000) throw new Error('Invalid Clef request.');
    // Clef's small decision head can miss negation. Block obvious ambiguous or
    // consequential intent before inference; suggestions still never execute.
    if (needsPadClarification(text)) return 'ask';
    // Optional integration: never contact a developer-specific machine by
    // default. Only administrator configuration selects the SSH destination
    // and fixed adapter command; user text remains bounded stdin JSON.
    const host = this.options.sshHost?.trim();
    const command = this.options.remoteCommand?.trim();
    if (!host || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/u.test(host)
        || !command || command.length > 4096 || /[\0\r\n]/u.test(command)) {
      throw new Error('Local Clef is not configured. Deterministic commands still work.');
    }
    clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      this.pending = { id: randomUUID(), resolve, reject };
      this.text = text;
      this.timer = setTimeout(() => this.close(), this.ready ? 15_000 : 120_000);
      if (this.child && this.ready) { this.send(); return; }
      const child = spawn('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', host, command],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stderr.resume(); // Never retain potentially sensitive model output.
      child.on('error', () => { if (this.child === child) this.close(); });
      child.on('exit', () => { if (this.child === child) this.close(); });
      child.stdout.on('data', (data: Buffer) => {
        if (this.child !== child) return;
        this.buffer += data.toString('utf8');
        if (this.buffer.length > 16384) { this.close(); return; }
        while (this.buffer.includes('\n')) {
          const end = this.buffer.indexOf('\n');
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
          try {
            const value = JSON.parse(line) as { type?: string; id?: string; action?: PadAction };
            if (value.type === 'ready' && !this.ready) { this.ready = true; this.send(); }
            else if (this.pending && value.id === this.pending.id && value.action && PAD_ACTIONS.includes(value.action)) {
              const pending = this.pending; this.pending = undefined; this.text = '';
              clearTimeout(this.timer); pending.resolve(value.action);
              this.idle = setTimeout(() => this.close(), 60_000); this.idle.unref();
            } else { this.close(); return; }
          } catch { this.close(); return; }
        }
      });
    });
  }
  private send(): void {
    if (this.pending) this.child?.stdin.write(JSON.stringify({ id: this.pending.id, text: this.text }) + '\n');
  }
  close(): void {
    clearTimeout(this.timer); clearTimeout(this.idle);
    const child = this.child; this.child = undefined; child?.stdin.end(); child?.kill();
    this.ready = false; this.buffer = ''; this.text = '';
    const pending = this.pending; this.pending = undefined;
    pending?.reject(new Error('Local Clef unavailable. The buttons still work; no action was run.'));
  }
}
