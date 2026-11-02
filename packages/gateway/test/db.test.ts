import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../src/db/schema.js';

const dbs = new Set<Db>();
const tempDirs = new Set<string>();

function open(path: string): Db {
  const db = openDb(path);
  dbs.add(db);
  return db;
}

function tableNames(db: Db): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

afterEach(() => {
  for (const db of dbs) {
    db.close();
  }
  dbs.clear();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('openDb', () => {
  it('creates the projects, tasks, and events tables on open', () => {
    const db = open(':memory:');

    const names = tableNames(db);
    expect(names).toContain('projects');
    expect(names).toContain('tasks');
    expect(names).toContain('events');
  });

  it('enforces a UNIQUE constraint on tasks.idempotency_key', () => {
    const db = open(':memory:');

    const insert = db.prepare(
      `INSERT INTO tasks (id, project_id, state, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('t1', 'p1', 'queued', 'key-1', 'now', 'now');
    expect(() => insert.run('t2', 'p1', 'queued', 'key-1', 'now', 'now')).toThrow(/UNIQUE/);
  });

  it('creates an index on events (task_id, seq)', () => {
    const db = open(':memory:');

    const indexes = db
      .prepare(`SELECT name FROM pragma_index_list('events')`)
      .all() as Array<{ name: string }>;
    const indexed = indexes.some((index) => {
      const columns = db
        .prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`)
        .all(index.name) as Array<{ name: string }>;
      return columns.length === 2 && columns[0]?.name === 'task_id' && columns[1]?.name === 'seq';
    });
    expect(indexed).toBe(true);
  });

  it('is idempotent when the schema already exists', () => {
    // :memory: databases are private per connection, so exercise idempotency
    // against a shared on-disk file opened twice.
    const dir = mkdtempSync(join(tmpdir(), 'gateway-db-test-'));
    tempDirs.add(dir);
    const path = join(dir, 'gateway.sqlite');

    const a = open(path);
    a.prepare(
      `INSERT INTO projects (id, display_name, path, allowed_commands, allow_workspace_write,
        allow_dependency_install, allow_commit, allow_push, allow_deploy)
       VALUES ('p1', 'Demo', '/tmp/demo', '[]', 1, 0, 0, 0, 0)`,
    ).run();

    const b = open(path);
    const names = tableNames(b);
    expect(names).toContain('projects');
    expect(names).toContain('tasks');
    expect(names).toContain('events');

    const row = b.prepare(`SELECT display_name FROM projects WHERE id = 'p1'`).get() as {
      display_name: string;
    };
    expect(row.display_name).toBe('Demo');
  });
});
