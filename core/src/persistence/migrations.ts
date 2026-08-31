import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  up(db: DatabaseSync): void;
}

export const DATABASE_VERSION = 1;

const V1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    identity_kind TEXT NOT NULL CHECK (identity_kind IN ('remote', 'root', 'path')),
    identity_value TEXT NOT NULL,
    remote TEXT,
    root_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    model_json TEXT,
    status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'completed', 'interrupted', 'cancelled', 'error')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX sessions_project_updated_idx ON sessions(project_id, updated_at DESC);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool', 'internal')),
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('streaming', 'complete', 'interrupted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, seq)
  ) STRICT;

  CREATE TABLE tool_calls (
    call_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    input_text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'awaiting_approval', 'running', 'success', 'failure', 'denied', 'interrupted')),
    result_json TEXT,
    error_text TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE (assistant_message_id, ordinal)
  ) STRICT;
  CREATE INDEX tool_calls_session_idx ON tool_calls(session_id);

  CREATE TABLE context_snapshots (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    baseline TEXT NOT NULL DEFAULT '',
    source_snapshot_json TEXT NOT NULL DEFAULT '{}',
    baseline_seq INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    summary_upto_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  ) STRICT;
`;

export const productionMigrations: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(V1_SCHEMA);
    },
  },
];
