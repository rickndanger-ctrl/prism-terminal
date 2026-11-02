import { err, ok, type Result } from '@codex-lens/shared';
import { fileURLToPath } from 'node:url';

import type { Db } from '../db/schema.js';
import { canonicalizePath } from './pathSafety.js';
import {
  parseRegistryRecord,
  type RegistryRecord,
} from './projectRegistry.js';

interface ProjectRow {
  id: unknown;
  display_name: unknown;
  path: unknown;
  allowed_commands: unknown;
  allow_workspace_write: unknown;
  allow_dependency_install: unknown;
  allow_commit: unknown;
  allow_push: unknown;
  allow_deploy: unknown;
}

const PROJECT_COLUMNS = `
  id,
  display_name,
  path,
  allowed_commands,
  allow_workspace_write,
  allow_dependency_install,
  allow_commit,
  allow_push,
  allow_deploy
`;

const SAMPLE_PROJECT_ID = 'sample-project';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseAllowedCommands(value: unknown): Result<unknown> {
  if (typeof value !== 'string') {
    return err('INVALID_STORED_PROJECT', 'allowed_commands must be stored as JSON');
  }

  try {
    return ok(JSON.parse(value));
  } catch {
    return err('INVALID_STORED_PROJECT', 'allowed_commands contains invalid JSON');
  }
}

function sqliteBoolean(value: unknown): unknown {
  if (value === 0) {
    return false;
  }
  if (value === 1) {
    return true;
  }
  return value;
}

function rowToProject(row: ProjectRow): Result<RegistryRecord> {
  const allowedCommands = parseAllowedCommands(row.allowed_commands);
  if (!allowedCommands.ok) {
    return allowedCommands;
  }

  const parsed = parseRegistryRecord({
    id: row.id,
    displayName: row.display_name,
    path: row.path,
    allowedCommands: allowedCommands.value,
    allowWorkspaceWrite: sqliteBoolean(row.allow_workspace_write),
    allowDependencyInstall: sqliteBoolean(row.allow_dependency_install),
    allowCommit: sqliteBoolean(row.allow_commit),
    allowPush: sqliteBoolean(row.allow_push),
    allowDeploy: sqliteBoolean(row.allow_deploy),
  });
  if (!parsed.ok) {
    return err('INVALID_STORED_PROJECT', parsed.error.message);
  }

  return parsed;
}

export function loadRegistry(db: Db): Result<RegistryRecord[]> {
  try {
    const rows = db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY id ASC`)
      .all() as ProjectRow[];

    const projects: RegistryRecord[] = [];
    for (const row of rows) {
      const project = rowToProject(row);
      if (!project.ok) {
        return project;
      }
      projects.push(project.value);
    }

    return ok(projects);
  } catch (error) {
    return err('REGISTRY_READ_FAILED', errorMessage(error));
  }
}

export function getProjectById(db: Db, id: string): Result<RegistryRecord> {
  if (id.trim().length === 0) {
    return err('INVALID_PROJECT_ID', 'Project id must not be empty');
  }

  try {
    const row = db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`)
      .get(id) as ProjectRow | undefined;

    if (row === undefined) {
      return err('PROJECT_NOT_FOUND', `Project not found: "${id}"`);
    }

    return rowToProject(row);
  } catch (error) {
    return err('REGISTRY_READ_FAILED', errorMessage(error));
  }
}

export function seedRegistry(db: Db): Result<RegistryRecord> {
  let sampleProjectPath: string;
  try {
    sampleProjectPath = canonicalizePath(
      fileURLToPath(new URL('../../fixtures/sample-project/', import.meta.url)),
    );
  } catch (error) {
    return err('REGISTRY_SEED_FAILED', errorMessage(error));
  }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO projects (
        id,
        display_name,
        path,
        allowed_commands,
        allow_workspace_write,
        allow_dependency_install,
        allow_commit,
        allow_push,
        allow_deploy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      SAMPLE_PROJECT_ID,
      'Sample Project',
      sampleProjectPath,
      JSON.stringify(['echo', 'node --version']),
      1,
      0,
      0,
      0,
      0,
    );
  } catch (error) {
    return err('REGISTRY_SEED_FAILED', errorMessage(error));
  }

  return getProjectById(db, SAMPLE_PROJECT_ID);
}
