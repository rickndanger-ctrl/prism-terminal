import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  captureDiff,
  disposeSandbox,
  prepareSandbox,
  rollback,
  writeFileInSandbox,
  type SandboxHandle,
} from '../src/sandbox.js';
import {
  CODEX_LENS_REPO_ID,
  SAMPLE_REPO_ID,
  SAMPLE_REPO_ROOT,
} from '../src/registryConfig.js';

const TIMEOUT_MS = 60_000;

const live = new Set<SandboxHandle>();

async function prepare(
  repoId: string = SAMPLE_REPO_ID,
): Promise<SandboxHandle> {
  const result = await prepareSandbox(repoId);
  expect(result.ok, `prepareSandbox(${repoId}) failed`).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  live.add(result.value);
  return result.value;
}

afterEach(async () => {
  await Promise.all([...live].map(async (sandbox) => disposeSandbox(sandbox)));
  live.clear();
});

describe('prepareSandbox', () => {
  it(
    'copies the sample repo into an isolated tmp working copy',
    async () => {
      const sandbox = await prepare();

      expect(path.isAbsolute(sandbox.root)).toBe(true);
      expect(sandbox.repoId).toBe(SAMPLE_REPO_ID);
      expect(sandbox.baselineCommit).toMatch(/^[0-9a-f]{7,64}$/);

      // The copy is somewhere else entirely, not inside the real repo.
      expect(sandbox.root.startsWith(SAMPLE_REPO_ROOT)).toBe(false);
      expect(path.relative(SAMPLE_REPO_ROOT, sandbox.root)).toMatch(/^\.\./);

      const copied = await readFile(
        path.join(sandbox.root, 'src', 'calculator.js'),
        'utf8',
      );
      const original = await readFile(
        path.join(SAMPLE_REPO_ROOT, 'src', 'calculator.js'),
        'utf8',
      );
      expect(copied).toBe(original);
    },
    TIMEOUT_MS,
  );

  it(
    'gives the copy its own git history rather than the source repo history',
    async () => {
      const sandbox = await prepare();

      expect(existsSync(path.join(sandbox.root, '.git'))).toBe(true);

      const diff = await captureDiff(sandbox);
      expect(diff.ok).toBe(true);
      if (diff.ok) {
        expect(diff.value).toBe('');
      }
    },
    TIMEOUT_MS,
  );

  it(
    'refuses to sandbox a repo that is not an editable target',
    async () => {
      const result = await prepareSandbox(CODEX_LENS_REPO_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('CODEX_LENS_ROOT_FORBIDDEN');
      }
    },
    TIMEOUT_MS,
  );

  it('rejects an unknown repo id', async () => {
    const result = await prepareSandbox('not-a-registered-repo');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNKNOWN_REPO');
    }
  });

  it(
    'neutralizes inherited git repository-routing variables',
    async () => {
      const redirect = await mkdtemp(
        path.join(os.tmpdir(), 'codex-lens-git-env-'),
      );
      const gitDir = path.join(redirect, 'redirected.git');
      const previousGitDir = process.env.GIT_DIR;
      const previousGitWorkTree = process.env.GIT_WORK_TREE;

      try {
        process.env.GIT_DIR = gitDir;
        process.env.GIT_WORK_TREE = redirect;

        const result = await prepareSandbox(SAMPLE_REPO_ID);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        live.add(result.value);

        expect(existsSync(path.join(result.value.root, '.git'))).toBe(true);
        expect(existsSync(gitDir)).toBe(false);
      } finally {
        if (previousGitDir === undefined) {
          delete process.env.GIT_DIR;
        } else {
          process.env.GIT_DIR = previousGitDir;
        }
        if (previousGitWorkTree === undefined) {
          delete process.env.GIT_WORK_TREE;
        } else {
          process.env.GIT_WORK_TREE = previousGitWorkTree;
        }
        await rm(redirect, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});

describe('captureDiff and rollback', () => {
  it(
    'reports a non-empty diff for a change and rolls it back',
    async () => {
      const sandbox = await prepare();
      const relPath = path.join('src', 'calculator.js');
      const target = path.join(sandbox.root, relPath);
      const before = await readFile(target, 'utf8');

      const written = await writeFileInSandbox(
        sandbox,
        relPath,
        `${before}\n// changed by the sandbox test\n`,
      );
      expect(written.ok).toBe(true);

      const diff = await captureDiff(sandbox);
      expect(diff.ok).toBe(true);
      if (!diff.ok) {
        return;
      }
      expect(diff.value.length).toBeGreaterThan(0);
      expect(diff.value).toContain('src/calculator.js');
      expect(diff.value).toContain('+// changed by the sandbox test');

      const restored = await rollback(sandbox);
      expect(restored.ok).toBe(true);

      expect(await readFile(target, 'utf8')).toBe(before);

      const after = await captureDiff(sandbox);
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.value).toBe('');
      }
    },
    TIMEOUT_MS,
  );

  it(
    'shows a newly created file in the diff and removes it on rollback',
    async () => {
      const sandbox = await prepare();
      const relPath = path.join('src', 'added', 'new-module.js');

      const written = await writeFileInSandbox(
        sandbox,
        relPath,
        'export const added = true;\n',
      );
      expect(written.ok).toBe(true);
      expect(existsSync(path.join(sandbox.root, relPath))).toBe(true);

      const diff = await captureDiff(sandbox);
      expect(diff.ok).toBe(true);
      if (diff.ok) {
        expect(diff.value).toContain('src/added/new-module.js');
        expect(diff.value).toContain('+export const added = true;');
      }

      const restored = await rollback(sandbox);
      expect(restored.ok).toBe(true);
      expect(existsSync(path.join(sandbox.root, relPath))).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'never writes through to the real sample repo',
    async () => {
      const sandbox = await prepare();
      const relPath = path.join('src', 'calculator.js');
      const sourceFile = path.join(SAMPLE_REPO_ROOT, relPath);
      const sourceBefore = await readFile(sourceFile, 'utf8');

      const written = await writeFileInSandbox(
        sandbox,
        relPath,
        '// only in the sandbox\n',
      );
      expect(written.ok).toBe(true);
      if (written.ok) {
        expect(written.value.startsWith(sandbox.root)).toBe(true);
      }

      expect(await readFile(sourceFile, 'utf8')).toBe(sourceBefore);
    },
    TIMEOUT_MS,
  );

  it(
    'rejects a handle whose baseline is not a git object name',
    async () => {
      const sandbox = await prepare();
      const tampered: SandboxHandle = {
        ...sandbox,
        baselineCommit: '--output=/tmp/pwned',
      };

      const diff = await captureDiff(tampered);
      expect(diff.ok).toBe(false);
      if (!diff.ok) {
        expect(diff.error.code).toBe('INVALID_SANDBOX_BASELINE');
      }

      const restored = await rollback(tampered);
      expect(restored.ok).toBe(false);
      if (!restored.ok) {
        expect(restored.error.code).toBe('INVALID_SANDBOX_BASELINE');
      }
    },
    TIMEOUT_MS,
  );

  it(
    'rejects a handle whose baseline is well-formed but not this sandbox',
    async () => {
      const sandbox = await prepare();
      const foreign = 'a'.repeat(40);
      expect(foreign).not.toBe(sandbox.baselineCommit);

      const tampered: SandboxHandle = { ...sandbox, baselineCommit: foreign };

      // Object-name shape alone is not enough: the baseline must be the one
      // this module recorded when it took the snapshot.
      const restored = await rollback(tampered);
      expect(restored.ok).toBe(false);
      if (!restored.ok) {
        expect(restored.error.code).toBe('SANDBOX_HANDLE_MISMATCH');
      }

      const diff = await captureDiff(tampered);
      expect(diff.ok).toBe(false);
      if (!diff.ok) {
        expect(diff.error.code).toBe('SANDBOX_HANDLE_MISMATCH');
      }
    },
    TIMEOUT_MS,
  );
});

/**
 * A handle is a plain object the caller can rewrite at will, and `root` is what
 * every operation acts on: the cwd of `git reset --hard` and `git clean -fd`,
 * and the argument to a recursive delete. These tests point a tampered handle
 * at a real directory holding real files and assert both that the call is
 * refused and — the part that matters — that the directory is untouched.
 */
describe('handle authentication', () => {
  async function decoyDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-lens-decoy-'));
    await writeFile(path.join(dir, 'precious.txt'), 'do not touch', 'utf8');
    decoys.add(dir);
    return dir;
  }

  const decoys = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...decoys].map(async (dir) => rm(dir, { recursive: true, force: true })),
    );
    decoys.clear();
  });

  it(
    'refuses to write through a handle whose root it did not mint',
    async () => {
      const sandbox = await prepare();
      const dir = await decoyDir();
      const tampered: SandboxHandle = { ...sandbox, root: dir };

      const result = await writeFileInSandbox(tampered, 'planted.txt', 'pwned');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNKNOWN_SANDBOX');
      }
      expect(existsSync(path.join(dir, 'planted.txt'))).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'refuses to diff a handle whose root it did not mint',
    async () => {
      const sandbox = await prepare();
      const tampered: SandboxHandle = { ...sandbox, root: await decoyDir() };

      const result = await captureDiff(tampered);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNKNOWN_SANDBOX');
      }
    },
    TIMEOUT_MS,
  );

  it(
    'refuses to reset and clean a directory it did not mint',
    async () => {
      const sandbox = await prepare();
      const dir = await decoyDir();
      const tampered: SandboxHandle = { ...sandbox, root: dir };

      const result = await rollback(tampered);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNKNOWN_SANDBOX');
      }
      expect(await readFile(path.join(dir, 'precious.txt'), 'utf8')).toBe(
        'do not touch',
      );
    },
    TIMEOUT_MS,
  );

  it(
    'refuses to recursively delete a directory it did not mint',
    async () => {
      const sandbox = await prepare();
      const dir = await decoyDir();
      const tampered: SandboxHandle = { ...sandbox, root: dir };

      const result = await disposeSandbox(tampered);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNKNOWN_SANDBOX');
      }
      expect(existsSync(dir)).toBe(true);
      expect(await readFile(path.join(dir, 'precious.txt'), 'utf8')).toBe(
        'do not touch',
      );
    },
    TIMEOUT_MS,
  );

  it(
    'refuses to reuse a handle after the sandbox has been disposed',
    async () => {
      const sandbox = await prepareSandbox(SAMPLE_REPO_ID);
      expect(sandbox.ok).toBe(true);
      if (!sandbox.ok) {
        return;
      }

      expect((await disposeSandbox(sandbox.value)).ok).toBe(true);

      const result = await writeFileInSandbox(sandbox.value, 'x.txt', 'again');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The root is gone, so it cannot even be resolved to be looked up.
        expect(result.error.code).toBe('INVALID_SANDBOX_ROOT');
      }
    },
    TIMEOUT_MS,
  );
});

/**
 * The point of a sandbox is that every change it permits can be reviewed and
 * undone. A git-ignored write would break both halves of that: it is absent
 * from `captureDiff`, and it outlives the `git clean` that `rollback` runs.
 */
describe('writeFileInSandbox trackability', () => {
  it(
    'refuses a write to a path the sandbox git-ignores',
    async () => {
      const sandbox = await prepare();

      // Adding the rule is itself a normal, reviewable change.
      const ignoreFile = await writeFileInSandbox(
        sandbox,
        '.gitignore',
        '*.log\n',
      );
      expect(ignoreFile.ok).toBe(true);

      const result = await writeFileInSandbox(sandbox, 'debug.log', 'hidden');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_WRITE_NOT_TRACKABLE');
      }
      expect(existsSync(path.join(sandbox.root, 'debug.log'))).toBe(false);
    },
    TIMEOUT_MS,
  );

  /**
   * Ordering is the whole point of these two. Writing the file first makes it
   * permitted — nothing ignores it yet — and the `.gitignore` that ignores it
   * arrives only afterwards, which is itself a legitimate change. A permitted
   * write may not be retroactively hidden by a later one: git's own view of the
   * tree says it is ignored, so `add -A -N` would drop it from the diff and the
   * `-x`-less `clean` would let it outlive the rollback.
   */
  it(
    'keeps a permitted write in the diff after a later change ignores it',
    async () => {
      const sandbox = await prepare();

      expect(
        (await writeFileInSandbox(sandbox, 'notes.log', 'permitted\n')).ok,
      ).toBe(true);
      // Only now does the path become ignored.
      expect(
        (await writeFileInSandbox(sandbox, '.gitignore', '*.log\n')).ok,
      ).toBe(true);

      const diff = await captureDiff(sandbox);
      expect(diff.ok).toBe(true);
      if (diff.ok) {
        expect(diff.value).toContain('notes.log');
        expect(diff.value).toContain('+permitted');
        expect(diff.value).toContain('.gitignore');
      }
    },
    TIMEOUT_MS,
  );

  it(
    'rolls back a permitted write that a later change ignores',
    async () => {
      const sandbox = await prepare();

      expect(
        (await writeFileInSandbox(sandbox, 'notes.log', 'permitted\n')).ok,
      ).toBe(true);
      expect(
        (await writeFileInSandbox(sandbox, '.gitignore', '*.log\n')).ok,
      ).toBe(true);

      // No captureDiff first: rollback must stand on its own, since the
      // intent-to-add it stages is what would otherwise mask the leak.
      const restored = await rollback(sandbox);
      expect(restored.ok).toBe(true);

      expect(existsSync(path.join(sandbox.root, 'notes.log'))).toBe(false);
      expect(existsSync(path.join(sandbox.root, '.gitignore'))).toBe(false);

      const after = await captureDiff(sandbox);
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.value).toBe('');
      }
    },
    TIMEOUT_MS,
  );

  /**
   * The `-x` clean that reaches a retroactively-ignored write must reach only
   * the paths this module wrote. An ignored build artifact it never touched —
   * an installed node_modules being the case that matters — is not its to
   * delete, and a rollback that blew one away would be a nasty surprise.
   */
  it(
    'spares ignored artifacts it did not write when rolling back',
    async () => {
      const sandbox = await prepare();

      expect(
        (await writeFileInSandbox(sandbox, 'notes.log', 'permitted\n')).ok,
      ).toBe(true);
      expect(
        (await writeFileInSandbox(sandbox, '.gitignore', '*.log\nbuilt/\n')).ok,
      ).toBe(true);

      // Written behind the module's back, the way a build step would.
      const artifact = path.join(sandbox.root, 'built', 'bundle.js');
      await mkdir(path.dirname(artifact), { recursive: true });
      await writeFile(artifact, 'artifact', 'utf8');

      expect((await rollback(sandbox)).ok).toBe(true);

      expect(existsSync(path.join(sandbox.root, 'notes.log'))).toBe(false);
      expect(await readFile(artifact, 'utf8')).toBe('artifact');
    },
    TIMEOUT_MS,
  );

  it(
    'leaves nothing behind after a rollback of everything it permitted',
    async () => {
      const sandbox = await prepare();

      expect(
        (await writeFileInSandbox(sandbox, '.gitignore', '*.log\n')).ok,
      ).toBe(true);
      await writeFileInSandbox(sandbox, 'debug.log', 'hidden');

      const restored = await rollback(sandbox);
      expect(restored.ok).toBe(true);

      // Had the ignored write been permitted, `git clean -fd` would have left
      // it sitting in the tree with no diff to show for it.
      expect(existsSync(path.join(sandbox.root, '.gitignore'))).toBe(false);
      expect(existsSync(path.join(sandbox.root, 'debug.log'))).toBe(false);

      const after = await captureDiff(sandbox);
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.value).toBe('');
      }
    },
    TIMEOUT_MS,
  );

  /**
   * The git dir holds the baseline every diff is taken against and every
   * rollback resets to. A write that lands in it does not just escape review —
   * it edits the record used to detect the escape, so `config`, a hook, or a
   * ref could redirect or silently neuter both. The guard therefore has to hold
   * for every spelling of the same file, not just the obvious one.
   */
  it.each([
    ['the plain path', path.join('.git', 'hooks', 'pre-commit')],
    ['a "./"-prefixed path', './.git/config'],
    ['an uppercase variant', path.join('.GIT', 'hooks', 'pre-commit')],
    ['a mixed-case variant', path.join('.Git', 'config')],
    ['a redundant-separator path', '.git//config'],
    ['a nested git directory', path.join('src', '.git', 'config')],
  ])(
    'refuses a write into a git directory named by %s',
    async (_label, relPath) => {
      const sandbox = await prepare();

      const result = await writeFileInSandbox(sandbox, relPath, 'pwned');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_WRITE_NOT_TRACKABLE');
      }
    },
    TIMEOUT_MS,
  );

  /**
   * The case variants above resolve to the real `.git` only on a
   * case-insensitive filesystem; elsewhere they are merely ordinary paths that
   * happen to be spelled oddly. Asserting the sandbox git dir is intact pins
   * the consequence that actually matters on either kind of filesystem.
   */
  it(
    'leaves the sandbox git directory untouched by rejected writes',
    async () => {
      const sandbox = await prepare();
      const gitDir = path.join(sandbox.root, '.git');
      const configBefore = await readFile(path.join(gitDir, 'config'), 'utf8');

      for (const relPath of [
        './.git/config',
        path.join('.GIT', 'config'),
        path.join('.Git', 'hooks', 'pre-commit'),
        path.join('.git', 'hooks', 'pre-commit'),
      ]) {
        expect((await writeFileInSandbox(sandbox, relPath, 'pwned')).ok).toBe(
          false,
        );
      }

      expect(await readFile(path.join(gitDir, 'config'), 'utf8')).toBe(
        configBefore,
      );
      expect(existsSync(path.join(gitDir, 'hooks', 'pre-commit'))).toBe(false);
    },
    TIMEOUT_MS,
  );
});

describe('writeFileInSandbox containment', () => {
  it(
    'rejects a write that escapes the sandbox root via ".."',
    async () => {
      const sandbox = await prepare();
      const escapee = path.resolve(sandbox.root, '..', 'escape.txt');

      const result = await writeFileInSandbox(
        sandbox,
        path.join('..', 'escape.txt'),
        'pwned',
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_ESCAPE_REJECTED');
      }
      expect(existsSync(escapee)).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'rejects a deep ".." chain that would land in a real directory',
    async () => {
      const sandbox = await prepare();

      const result = await writeFileInSandbox(
        sandbox,
        path.join('src', '..', '..', '..', 'escape.txt'),
        'pwned',
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_ESCAPE_REJECTED');
      }
    },
    TIMEOUT_MS,
  );

  it(
    'rejects an absolute write target',
    async () => {
      const sandbox = await prepare();
      const escapee = path.join(os.tmpdir(), 'codex-lens-absolute-escape.txt');

      const result = await writeFileInSandbox(sandbox, escapee, 'pwned');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_ESCAPE_REJECTED');
      }
      expect(existsSync(escapee)).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'rejects a write that a symlink would redirect out of the sandbox',
    async () => {
      const sandbox = await prepare();
      const outsideDir = path.dirname(sandbox.root);
      const outsideFile = path.join(outsideDir, 'symlink-escape.txt');
      await writeFile(outsideFile, 'original', 'utf8');

      await symlink(outsideFile, path.join(sandbox.root, 'link.txt'));

      const result = await writeFileInSandbox(sandbox, 'link.txt', 'pwned');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_ESCAPE_REJECTED');
      }
      expect(await readFile(outsideFile, 'utf8')).toBe('original');
    },
    TIMEOUT_MS,
  );

  it(
    'rejects a write through a symlinked directory',
    async () => {
      const sandbox = await prepare();
      const outsideDir = path.dirname(sandbox.root);

      await symlink(outsideDir, path.join(sandbox.root, 'outdir'));

      const result = await writeFileInSandbox(
        sandbox,
        path.join('outdir', 'symlinked-dir-escape.txt'),
        'pwned',
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_ESCAPE_REJECTED');
      }
      expect(
        existsSync(path.join(outsideDir, 'symlinked-dir-escape.txt')),
      ).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'rejects an empty relative path',
    async () => {
      const sandbox = await prepare();

      const result = await writeFileInSandbox(sandbox, '   ', 'pwned');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_SANDBOX_PATH');
      }
    },
    TIMEOUT_MS,
  );

  /**
   * A NUL is the one character that no syscall and no git argv can carry, and
   * it slips past every check phrased in terms of separators or "..". Reaching
   * `spawn` with one throws synchronously — not via the `error` event — so an
   * unguarded path turns a caller's `await` into an exception where the whole
   * module's contract is a Result. These pin the answer as a rejected value.
   */
  it.each([
    ['a trailing NUL', 'notes.txt\0'],
    ['a NUL before a path suffix', 'notes.txt\0.md'],
    ['a NUL in a directory segment', `src\0${path.sep}mod.js`],
  ])(
    'resolves to an error rather than throwing for %s',
    async (_label, relPath) => {
      const sandbox = await prepare();

      // `resolves` rather than a bare `await`: an unguarded NUL *rejects* the
      // promise, and that rejection is the regression itself, so the assertion
      // has to be able to tell it apart from an error Result.
      await expect(
        writeFileInSandbox(sandbox, relPath, 'pwned'),
      ).resolves.toMatchObject({ ok: false });

      const settled = await writeFileInSandbox(sandbox, relPath, 'pwned');
      expect(settled.ok).toBe(false);
      if (!settled.ok) {
        expect(settled.error.code).toBe('INVALID_SANDBOX_PATH');
      }
      // The truncation a NUL invites: nothing may land under the prefix either.
      expect(existsSync(path.join(sandbox.root, 'notes.txt'))).toBe(false);
      expect(existsSync(path.join(sandbox.root, 'src', 'mod.js'))).toBe(false);
    },
    TIMEOUT_MS,
  );

  /**
   * The rejection above lands before any git runs, so on its own it would leave
   * `spawnGit`'s own guard unexercised. A NUL in the *content* reaches
   * `writeFile` but never an argv, so this drives the whole write path — every
   * git call included — and pins that the ordinary case still resolves.
   */
  it(
    'writes content containing a NUL and still resolves to a Result',
    async () => {
      const sandbox = await prepare();

      const result = await writeFileInSandbox(sandbox, 'notes.txt', 'a\0b');

      expect(result.ok).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe('writeFileInSandbox editable-target policy', () => {
  /**
   * The physical write would land safely inside the sandbox, so only
   * `assertEditableTarget` can reject it. If that guard were dropped this write
   * would succeed, which is what makes this the test that it is really wired in
   * rather than the containment check standing in for it.
   */
  it(
    'refuses a write whose source repo is not an editable target',
    async () => {
      const sandbox = await prepare();
      const notEditable: SandboxHandle = {
        ...sandbox,
        repoId: CODEX_LENS_REPO_ID,
      };

      const result = await writeFileInSandbox(
        notEditable,
        'package.json',
        '{}',
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TARGET_NOT_EDITABLE');
      }
    },
    TIMEOUT_MS,
  );

  it(
    'ignores a tampered sourceRoot and authorizes against the repo id',
    async () => {
      const sandbox = await prepare();
      const tampered: SandboxHandle = { ...sandbox, sourceRoot: os.homedir() };

      // Authorization re-resolves the source from repoId, so the bogus
      // sourceRoot changes nothing and the legitimate write still succeeds.
      const result = await writeFileInSandbox(
        tampered,
        'README.md',
        '# sandboxed\n',
      );

      expect(result.ok).toBe(true);
    },
    TIMEOUT_MS,
  );
});
