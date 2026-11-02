import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

describe('demo run-flow script', () => {
  let dataDirectory: string;

  beforeEach(() => {
    dataDirectory = mkdtempSync(join(tmpdir(), 'codex-lens-demo-test-'));
  });

  afterEach(() => {
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  it('walks the flow to an approved plan and exits 0', () => {
    const stdout = execFileSync('npm', ['run', 'demo', '--silent'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CODEX_LENS_DATA_DIR: dataDirectory },
    });

    expect(stdout).toContain('1. Conversation: ready for planning');
    expect(stdout).toContain('2. Engineering Plan: ready for approval');
    expect(stdout).toContain('3. Engineering approval: approved');
    expect(stdout).toContain('4. Execution Plan: ready for approval');
    expect(stdout).toContain('5. Execution approval: approved');
    expect(stdout).toContain('6. Codex task: queued');
    expect(stdout.trim().endsWith('DEMO COMPLETE')).toBe(true);
  });
});
