import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolve installed CLI layouts without depending on a LaunchAgent's short PATH. */
export function resolveCodexExecutable(options: {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  isExecutable?: (path: string) => boolean;
} = {}): string {
  const explicit = (options.env ?? process.env).CODEX_APP_SERVER_CMD?.trim();
  if (explicit) return explicit;
  const isExecutable = options.isExecutable ?? ((path: string) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  return [
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    join(options.homeDirectory ?? homedir(), '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ].find(isExecutable) ?? 'codex';
}
