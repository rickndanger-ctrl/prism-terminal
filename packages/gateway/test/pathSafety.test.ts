import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertCommandAllowed,
  canonicalizePath,
  resolveWorkingDir,
} from '../src/registry/pathSafety.js';
import type { RegistryRecord } from '../src/registry/projectRegistry.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function projectAt(projectPath: string): RegistryRecord {
  return {
    id: 'project-1',
    displayName: 'Project One',
    path: projectPath,
    allowedCommands: ['npm test'],
    allowWorkspaceWrite: false,
    allowDependencyInstall: false,
    allowCommit: false,
    allowPush: false,
    allowDeploy: false,
  };
}

describe('path safety', () => {
  it('allows a valid path within the project root', async () => {
    const root = await makeTempDirectory('codex-lens-root-');
    const child = path.join(root, 'packages', 'gateway');
    await mkdir(child, { recursive: true });

    expect(resolveWorkingDir(projectAt(root), 'packages/gateway')).toEqual({
      ok: true,
      value: canonicalizePath(child),
    });
  });

  it('rejects ../ traversal outside the project root', async () => {
    const parent = await makeTempDirectory('codex-lens-parent-');
    const root = path.join(parent, 'workspace', 'project');
    const outside = path.join(parent, 'etc');
    await mkdir(root, { recursive: true });
    await mkdir(outside);

    const result = resolveWorkingDir(projectAt(root), '../../etc');

    expect(result.ok).toBe(false);
  });

  it('rejects a symlink that escapes the project root', async () => {
    const parent = await makeTempDirectory('codex-lens-symlink-');
    const root = path.join(parent, 'project');
    const outside = path.join(parent, 'outside');
    const escape = path.join(root, 'escape');
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, escape, 'dir');

    const result = resolveWorkingDir(projectAt(root), 'escape');

    expect(result.ok).toBe(false);
  });

  it('rejects a command not in allowedCommands', () => {
    expect(assertCommandAllowed('npm install', ['npm test'])).toEqual({
      ok: false,
      error: {
        code: 'COMMAND_NOT_ALLOWED',
        message: 'Command is not allowed: "npm install"',
      },
    });
  });

  it('allows a command in allowedCommands', () => {
    expect(assertCommandAllowed('npm test', ['npm test'])).toEqual({
      ok: true,
      value: undefined,
    });
  });
});
