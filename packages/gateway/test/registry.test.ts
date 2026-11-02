import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../src/db/schema.js';
import {
  getProjectById,
  loadRegistry,
  seedRegistry,
} from '../src/registry/registry.js';

const dbs = new Set<Db>();

function open(): Db {
  const db = openDb(':memory:');
  dbs.add(db);
  return db;
}

function mustSucceed<T>(result: { ok: true; value: T } | { ok: false }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('Expected successful Result');
  }
  return result.value;
}

afterEach(() => {
  for (const db of dbs) {
    db.close();
  }
  dbs.clear();
});

describe('registry', () => {
  it('seeds and loads exactly one safe sample project', () => {
    const db = open();

    mustSucceed(seedRegistry(db));
    const projects = mustSucceed(loadRegistry(db));

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: 'sample-project',
      allowedCommands: ['echo', 'node --version'],
      allowWorkspaceWrite: true,
      allowDependencyInstall: false,
      allowCommit: false,
      allowPush: false,
      allowDeploy: false,
    });
    expect(projects[0]?.path).toBe(
      realpathSync.native(
        fileURLToPath(new URL('../fixtures/sample-project/', import.meta.url)),
      ),
    );
  });

  it('is idempotent when seeded twice', () => {
    const db = open();

    mustSucceed(seedRegistry(db));
    mustSucceed(seedRegistry(db));

    expect(mustSucceed(loadRegistry(db))).toHaveLength(1);
  });

  it('gets a validated project by id and returns an error when absent', () => {
    const db = open();
    mustSucceed(seedRegistry(db));

    expect(mustSucceed(getProjectById(db, 'sample-project')).id).toBe(
      'sample-project',
    );

    const missing = getProjectById(db, 'missing');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('PROJECT_NOT_FOUND');
    }
  });

  it('returns a Result error for an invalid stored project', () => {
    const db = open();
    mustSucceed(seedRegistry(db));
    db.prepare(
      `UPDATE projects SET allow_workspace_write = 2 WHERE id = 'sample-project'`,
    ).run();

    const result = getProjectById(db, 'sample-project');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_STORED_PROJECT');
    }
  });
});
