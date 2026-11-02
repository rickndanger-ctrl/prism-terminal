import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SAMPLE_REPO_ROOT } from '../src/registryConfig.js';
import { runTests } from '../src/test-runner.js';

const SAMPLE_TEST_COMMAND = 'npm test';
// Real `npm test` child processes, so the default 5s vitest budget is too tight.
const RUN_TIMEOUT_MS = 120_000;

const stagedRoots = new Set<string>();

const FIXED_CALCULATOR = `export function add(left, right) {
  return left + right;
}

export function multiply(left, right) {
  return left * right;
}
`;

/**
 * Copies the ticket 0 fixture to a temp directory so a run can never mutate
 * the checked-in sample repo.
 */
async function stageSample(options: { fixed: boolean }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-lens-test-runner-'));
  stagedRoots.add(root);
  await cp(SAMPLE_REPO_ROOT, root, { recursive: true });

  if (options.fixed) {
    await writeFile(path.join(root, 'src', 'calculator.js'), FIXED_CALCULATOR);
  }

  return root;
}

afterEach(async () => {
  await Promise.all(
    [...stagedRoots].map(async (root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  stagedRoots.clear();
});

describe('runTests against the sample repo fixture', () => {
  it(
    'reports failure for the buggy fixture',
    async () => {
      const root = await stageSample({ fixed: false });

      const result = await runTests({ root }, SAMPLE_TEST_COMMAND);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.success).toBe(false);
      expect(result.value.exitCode).toBe(1);
      expect(result.value.counts).toMatchObject({
        total: 2,
        passed: 1,
        failed: 1,
      });
      expect(result.value.stdout).toContain(
        'addition returns the sum of both numbers',
      );
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'reports success once the fixture bug is fixed',
    async () => {
      const root = await stageSample({ fixed: true });

      const result = await runTests({ root }, SAMPLE_TEST_COMMAND);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.success).toBe(true);
      expect(result.value.exitCode).toBe(0);
      expect(result.value.counts).toMatchObject({
        total: 2,
        passed: 2,
        failed: 0,
      });
      expect(result.value.command).toBe(SAMPLE_TEST_COMMAND);
      expect(result.value.durationMs).toBeGreaterThan(0);
    },
    RUN_TIMEOUT_MS,
  );
});

describe('runTests guards', () => {
  it('rejects a command outside the sandbox allowlist', async () => {
    const result = await runTests(
      { root: SAMPLE_REPO_ROOT, allowedCommands: ['npm test'] },
      'rm -rf /',
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('COMMAND_NOT_ALLOWED');
  });

  it('rejects an empty command', async () => {
    const result = await runTests({ root: SAMPLE_REPO_ROOT }, '   ');

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('INVALID_TEST_COMMAND');
  });

  it('rejects a sandbox root that does not exist', async () => {
    const result = await runTests(
      { root: path.join(tmpdir(), 'codex-lens-missing-sandbox') },
      SAMPLE_TEST_COMMAND,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('INVALID_SANDBOX_ROOT');
  });

  it(
    'reports unparsable output rather than guessing counts',
    async () => {
      const result = await runTests(
        { root: SAMPLE_REPO_ROOT },
        `${process.execPath} --version`,
      );

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.code).toBe('TEST_OUTPUT_UNPARSABLE');
    },
    RUN_TIMEOUT_MS,
  );
});
