import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RepoRegistryEntry {
  id: string;
  path: string;
  editable: boolean;
}

export const SAMPLE_REPO_ID = 'sample-project';
export const CODEX_LENS_REPO_ID = 'codex-lens';

export const CODEX_LENS_REPO_ROOT = path.resolve(
  fileURLToPath(new URL('../../../', import.meta.url)),
);

export const SAMPLE_REPO_ROOT = path.resolve(
  fileURLToPath(new URL('../fixtures/sample-project/', import.meta.url)),
);

export const REPO_REGISTRY: readonly Readonly<RepoRegistryEntry>[] =
  Object.freeze([
    Object.freeze({
      id: SAMPLE_REPO_ID,
      path: SAMPLE_REPO_ROOT,
      editable: true,
    }),
    Object.freeze({
      id: CODEX_LENS_REPO_ID,
      path: CODEX_LENS_REPO_ROOT,
      editable: false,
    }),
  ]);
