import { describe, expect, it } from 'vitest';
import { resolveCodexExecutable } from '../src/codex/executable.js';

describe('Codex executable resolution', () => {
  it('respects an explicit command without silently substituting another installation', () => {
    expect(resolveCodexExecutable({ env: { CODEX_APP_SERVER_CMD: '/custom/codex' },
      isExecutable: () => false })).toBe('/custom/codex');
  });
  it('finds the managed CLI when an app bundle is absent and launchd PATH is short', () => {
    expect(resolveCodexExecutable({ env: { PATH: '/usr/bin:/bin' }, homeDirectory: '/home/lens',
      isExecutable: path => path === '/home/lens/.local/bin/codex' })).toBe('/home/lens/.local/bin/codex');
  });
  it('prefers the current installed app bundle when both app layouts exist', () => {
    expect(resolveCodexExecutable({ env: {}, isExecutable: path => path.startsWith('/Applications/') }))
      .toBe('/Applications/Codex.app/Contents/Resources/codex');
  });
  it('retains PATH lookup as the final fallback for other installations', () => {
    expect(resolveCodexExecutable({ env: {}, isExecutable: () => false })).toBe('codex');
  });
});
