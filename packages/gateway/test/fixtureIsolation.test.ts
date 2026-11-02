import { execFile } from 'node:child_process';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { configDefaults } from 'vitest/config';
import { describe, expect, it } from 'vitest';

import { SAMPLE_REPO_ROOT } from '../src/registryConfig.js';

const run = promisify(execFile);

const GATEWAY_TEST_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Vitest's own default globs — the ones the config-less root run collects by. */
const VITEST_INCLUDE = [...configDefaults.include];

interface ExecFileFailure {
  code?: number;
  stdout?: string;
}

/**
 * The sample fixture ships a deliberately failing test, and the root `npm run
 * verify` must stay green. Those two facts only coexist because the fixture
 * names its test file `test/calculator.js` rather than `test/calculator.test.js`,
 * so Vitest's include globs never match it.
 *
 * That is a naming convention holding up a build invariant, which is exactly
 * the kind of thing a later rename breaks silently: the fixture would start
 * failing the whole workspace, and the only clue would be a red root verify.
 * Both halves are pinned here — the fixture is still broken on purpose, and
 * root verify still cannot see it.
 */
describe('sample fixture isolation from root verify', () => {
  it('exposes no file that vitest would collect', () => {
    const collected = globSync(VITEST_INCLUDE, { cwd: SAMPLE_REPO_ROOT });

    expect(collected).toEqual([]);
  });

  it('is not vacuously isolated: the same globs do collect this suite', () => {
    // Without this, a broken glob or a renamed default would make the check
    // above pass by matching nothing anywhere.
    const collected = globSync(VITEST_INCLUDE, { cwd: GATEWAY_TEST_ROOT });

    expect(collected).toContain('fixtureIsolation.test.ts');
  });

  it('still fails on its own, so the slice has a real bug to fix', async () => {
    const failure = await run(
      'node',
      ['--test', '--test-reporter=tap', 'test/calculator.js'],
      { cwd: SAMPLE_REPO_ROOT },
    ).then(
      () => undefined,
      (error: ExecFileFailure) => error,
    );

    expect(failure?.code).toBe(1);
    expect(failure?.stdout).toContain('# pass 1');
    expect(failure?.stdout).toContain('# fail 1');
  });
});
