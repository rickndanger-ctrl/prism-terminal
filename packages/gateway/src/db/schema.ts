import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gmail_write_intents (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  digest TEXT NOT NULL,
  account_binding TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('draft','send')),
  state TEXT NOT NULL CHECK(state IN ('prepared','submitting','accepted','uncertain','rejected','expired')),
  expires_at INTEGER NOT NULL,
  receipt_id TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  path TEXT,
  allowed_commands JSON,
  allow_workspace_write INTEGER,
  allow_dependency_install INTEGER,
  allow_commit INTEGER,
  allow_push INTEGER,
  allow_deploy INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  state TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS prepared_engineering_plans (
  engineering_plan_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  plan_json TEXT NOT NULL,
  approval_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prepared_execution_plans (
  execution_plan_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_runs (
  task_id TEXT PRIMARY KEY,
  execution_plan_id TEXT NOT NULL,
  execution_plan_digest TEXT NOT NULL,
  codex_thread_id TEXT,
  follow_up_message TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_intents (
  confirmation_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  recipient_display TEXT NOT NULL,
  masked_destination TEXT NOT NULL,
  service_type TEXT NOT NULL CHECK (service_type IN ('iMessage', 'SMS', 'RCS')),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'sending', 'accepted', 'uncertain', 'expired', 'rejected')),
  prepared_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_at TEXT,
  failure_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_message_intents_state_updated_at
  ON message_intents (state, updated_at);

CREATE TABLE IF NOT EXISTS assistant_tasks (
  task_id TEXT PRIMARY KEY,
  confirmation_id TEXT NOT NULL UNIQUE,
  digest TEXT NOT NULL,
  instruction TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'mac')),
  project_id TEXT,
  working_directory TEXT NOT NULL,
  project_policy_json TEXT,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'running', 'completed', 'blocked', 'failed', 'cancelled', 'expired')),
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  requires_explicit_confirmation INTEGER NOT NULL DEFAULT 1,
  prepared_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  thread_id TEXT,
  turn_id TEXT,
  summary TEXT,
  failure_code TEXT,
  reconciled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_assistant_tasks_state_updated_at
  ON assistant_tasks (state, updated_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  seq INTEGER,
  type TEXT,
  payload JSON,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_task_id_seq ON events (task_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_task_id_seq_unique ON events (task_id, seq);
`;

function ensureAssistantTaskColumns(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(assistant_tasks)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('visual_references_json')) {
    db.exec('ALTER TABLE assistant_tasks ADD COLUMN visual_references_json TEXT');
  }
  if (!names.has('project_policy_json')) {
    db.exec('ALTER TABLE assistant_tasks ADD COLUMN project_policy_json TEXT');
  }
  if (!names.has('reconciled_at')) {
    db.exec('ALTER TABLE assistant_tasks ADD COLUMN reconciled_at TEXT');
  }
  if (!names.has('requires_explicit_confirmation')) {
    // Existing prepared rows were created under the old always-confirm policy.
    // Default them to confirmed so an upgrade never silently widens authority.
    db.exec('ALTER TABLE assistant_tasks ADD COLUMN requires_explicit_confirmation INTEGER NOT NULL DEFAULT 1');
  }
}

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  ensureAssistantTaskColumns(db);
  return db;
}
