import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assertEditableTarget, resolveRepo } from '../src/registry.js';
import {
  CODEX_LENS_REPO_ROOT,
  REPO_REGISTRY,
  SAMPLE_REPO_ID,
  SAMPLE_REPO_ROOT,
} from '../src/registryConfig.js';

const canonicalSampleRoot = realpathSync.native(
  fileURLToPath(new URL('../fixtures/sample-project/', import.meta.url)),
);

describe('resolveRepo', () => {
  it('resolves a registered repo to an absolute path and editable flag', () => {
    const result = resolveRepo(SAMPLE_REPO_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(SAMPLE_REPO_ID);
      expect(result.value.editable).toBe(true);
      expect(path.isAbsolute(result.value.path)).toBe(true);
      expect(result.value.path).toBe(SAMPLE_REPO_ROOT);
    }
  });

  it('rejects an unknown repo id', () => {
    const result = resolveRepo('not-a-registered-repo');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNKNOWN_REPO');
    }
  });

  it('rejects an empty repo id without throwing', () => {
    expect(() => resolveRepo('')).not.toThrow();

    const result = resolveRepo('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_REPO_ID');
    }
  });
});

describe('assertEditableTarget', () => {
  it('accepts the registered editable sample repo root', () => {
    const result = assertEditableTarget(SAMPLE_REPO_ROOT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(canonicalSampleRoot);
    }
  });

  it('accepts a path inside the registered editable sample repo', () => {
    const result = assertEditableTarget(
      path.join(SAMPLE_REPO_ROOT, 'README.md'),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(path.join(canonicalSampleRoot, 'README.md'));
    }
  });

  it('rejects the codex-lens repo root', () => {
    const result = assertEditableTarget(CODEX_LENS_REPO_ROOT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CODEX_LENS_ROOT_FORBIDDEN');
    }
  });

  it('rejects a path that escapes the registered root via ".."', () => {
    const result = assertEditableTarget(`${SAMPLE_REPO_ROOT}/../..`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PATH_TRAVERSAL_REJECTED');
    }
  });

  it('rejects a ".." traversal that resolves back to the codex-lens root', () => {
    const relativeDepth = path
      .relative(CODEX_LENS_REPO_ROOT, SAMPLE_REPO_ROOT)
      .split(path.sep).length;
    const traversal = `${SAMPLE_REPO_ROOT}${`${path.sep}..`.repeat(relativeDepth)}`;

    const result = assertEditableTarget(traversal);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CODEX_LENS_ROOT_FORBIDDEN');
    }
  });

  it('rejects a path outside every registered editable repo', () => {
    const result = assertEditableTarget(path.dirname(CODEX_LENS_REPO_ROOT));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TARGET_NOT_EDITABLE');
    }
  });

  it('rejects a non-existent path without throwing', () => {
    const missing = path.join(SAMPLE_REPO_ROOT, 'does-not-exist', 'file.txt');

    expect(() => assertEditableTarget(missing)).not.toThrow();

    const result = assertEditableTarget(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TARGET_PATH');
    }
  });

  it('rejects an empty target path without throwing', () => {
    const result = assertEditableTarget('');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TARGET_PATH');
    }
  });
});

describe('registry injection resistance', () => {
  const rogueEntry = { id: 'rogue', path: '/', editable: true };

  it('freezes the configured allowlist against adding entries', () => {
    expect(Object.isFrozen(REPO_REGISTRY)).toBe(true);
    expect(() =>
      (REPO_REGISTRY as unknown as (typeof rogueEntry)[]).push(rogueEntry),
    ).toThrow(TypeError);
  });

  it('freezes each entry against flipping the editable flag', () => {
    for (const entry of REPO_REGISTRY) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
    const codexLens = REPO_REGISTRY.find((entry) => !entry.editable);
    expect(codexLens).toBeDefined();
    expect(() => {
      (codexLens as unknown as { editable: boolean }).editable = true;
    }).toThrow(TypeError);
  });

  it('ignores a caller-supplied registry argument (legacy signature)', () => {
    const injectedRegistry = [rogueEntry];
    const arbitraryTarget = realpathSync.native(os.tmpdir());

    const targetResult = (
      assertEditableTarget as unknown as (
        targetPath: string,
        registry?: unknown,
      ) => ReturnType<typeof assertEditableTarget>
    )(arbitraryTarget, injectedRegistry);

    expect(targetResult.ok).toBe(false);
    if (!targetResult.ok) {
      expect(targetResult.error.code).toBe('TARGET_NOT_EDITABLE');
    }

    const repoResult = (
      resolveRepo as unknown as (
        id: string,
        registry?: unknown,
      ) => ReturnType<typeof resolveRepo>
    )('rogue', injectedRegistry);

    expect(repoResult.ok).toBe(false);
    if (!repoResult.ok) {
      expect(repoResult.error.code).toBe('UNKNOWN_REPO');
    }
  });

  it('never authorizes paths outside the configured allowlist', () => {
    const result = assertEditableTarget(os.homedir());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TARGET_NOT_EDITABLE');
    }
  });
});
