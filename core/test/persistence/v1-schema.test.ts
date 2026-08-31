import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "../../src/persistence/database.ts";

const temporaryDirectories: string[] = [];

async function openFixture(label: string) {
  const root = await mkdtemp(join(tmpdir(), `awacode-v1-contract-${label}-`));
  temporaryDirectories.push(root);
  return openDatabase({ env: { AWACODE_DATA_DIR: root } });
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

type SqlValue = string | number | null;

function insertRecord(db: DatabaseSync, table: string, record: Readonly<Record<string, SqlValue>>): void {
  const columns = Object.keys(record);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(record));
}

function isolated(db: DatabaseSync, operation: () => void): void {
  db.exec("SAVEPOINT v1_contract_case");
  try {
    operation();
  } finally {
    db.exec("ROLLBACK TO v1_contract_case");
    db.exec("RELEASE v1_contract_case");
  }
}

function assertInsertFails(db: DatabaseSync, operation: () => void, expected: RegExp): void {
  isolated(db, () => assert.throws(operation, expected));
}

function seedProject(db: DatabaseSync, id: string): void {
  insertRecord(db, "projects", {
    id,
    identity_kind: "path",
    identity_value: `D:\\${id}`,
    root_path: `D:\\${id}`,
    created_at: "created",
    updated_at: "updated",
  });
}

function seedSession(db: DatabaseSync, id: string, projectId: string): void {
  insertRecord(db, "sessions", {
    id,
    project_id: projectId,
    title: id,
    status: "idle",
    created_at: "created",
    updated_at: "updated",
  });
}

function seedMessage(db: DatabaseSync, id: string, sessionId: string, seq: number): void {
  insertRecord(db, "messages", {
    id,
    session_id: sessionId,
    seq,
    role: "assistant",
    kind: "text",
    payload_json: "{}",
    status: "complete",
    created_at: "created",
    updated_at: "updated",
  });
}

function tableInfo(db: DatabaseSync, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => ({
    name: String(row.name),
    type: String(row.type),
    notNull: Number(row.notnull),
    defaultValue: row.dflt_value === null ? null : String(row.dflt_value),
    primaryKey: Number(row.pk),
  }));
}

test("V1 exposes every exact column, PK, NOT NULL flag, default, and named index", async () => {
  const connection = await openFixture("metadata");
  try {
    assert.deepEqual(tableInfo(connection.db, "schema_migrations"), [
      { name: "version", type: "INTEGER", notNull: 0, defaultValue: null, primaryKey: 1 },
      { name: "applied_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
    ]);
    assert.deepEqual(tableInfo(connection.db, "projects"), [
      { name: "id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 1 },
      { name: "identity_kind", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "identity_value", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "remote", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
      { name: "root_path", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "created_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "updated_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
    ]);
    assert.deepEqual(tableInfo(connection.db, "sessions"), [
      { name: "id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 1 },
      { name: "project_id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "title", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "model_json", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
      { name: "status", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "created_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "updated_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
    ]);
    assert.deepEqual(tableInfo(connection.db, "messages"), [
      { name: "id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 1 },
      { name: "session_id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "seq", type: "INTEGER", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "role", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "kind", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "payload_json", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "status", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "created_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "updated_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
    ]);
    assert.deepEqual(tableInfo(connection.db, "tool_calls"), [
      { name: "call_id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 1 },
      { name: "session_id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "assistant_message_id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "ordinal", type: "INTEGER", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "tool_name", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "input_text", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "status", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "result_json", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
      { name: "error_text", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
      { name: "created_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
      { name: "started_at", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
      { name: "finished_at", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
    ]);
    assert.deepEqual(tableInfo(connection.db, "context_snapshots"), [
      { name: "session_id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 1 },
      { name: "baseline", type: "TEXT", notNull: 1, defaultValue: "''", primaryKey: 0 },
      { name: "source_snapshot_json", type: "TEXT", notNull: 1, defaultValue: "'{}'", primaryKey: 0 },
      { name: "baseline_seq", type: "INTEGER", notNull: 1, defaultValue: "0", primaryKey: 0 },
      { name: "summary", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
      { name: "summary_upto_seq", type: "INTEGER", notNull: 1, defaultValue: "0", primaryKey: 0 },
      { name: "updated_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
    ]);

    const sessionIndex = connection.db.prepare("PRAGMA index_xinfo(sessions_project_updated_idx)").all()
      .filter((row) => Number(row.key) === 1)
      .map((row) => ({ name: String(row.name), descending: Number(row.desc) }));
    const toolCallIndex = connection.db.prepare("PRAGMA index_xinfo(tool_calls_session_idx)").all()
      .filter((row) => Number(row.key) === 1)
      .map((row) => ({ name: String(row.name), descending: Number(row.desc) }));
    assert.deepEqual(sessionIndex, [
      { name: "project_id", descending: 0 },
      { name: "updated_at", descending: 1 },
    ]);
    assert.deepEqual(toolCallIndex, [{ name: "session_id", descending: 0 }]);
    assert.equal(
      connection.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get("sessions_project_updated_idx")?.count,
      1,
    );
    assert.equal(
      connection.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get("tool_calls_session_idx")?.count,
      1,
    );

    seedProject(connection.db, "defaults-project");
    seedSession(connection.db, "defaults-session", "defaults-project");
    insertRecord(connection.db, "context_snapshots", {
      session_id: "defaults-session",
      updated_at: "updated",
    });
    const defaults = connection.db.prepare(`
        SELECT baseline, source_snapshot_json, baseline_seq, summary, summary_upto_seq
        FROM context_snapshots WHERE session_id = 'defaults-session'
      `).get();
    assert.deepEqual(
      {
        baseline: String(defaults?.baseline),
        source_snapshot_json: String(defaults?.source_snapshot_json),
        baseline_seq: Number(defaults?.baseline_seq),
        summary: defaults?.summary ?? null,
        summary_upto_seq: Number(defaults?.summary_upto_seq),
      },
      { baseline: "", source_snapshot_json: "{}", baseline_seq: 0, summary: null, summary_upto_seq: 0 },
    );
  } finally {
    connection.close();
  }
});

test("V1 rejects null required fields, invalid checks, and every duplicate key", async () => {
  const connection = await openFixture("constraints");
  const db = connection.db;
  try {
    seedProject(db, "seed-project");
    seedSession(db, "seed-session", "seed-project");
    seedMessage(db, "seed-message", "seed-session", 1);
    insertRecord(db, "tool_calls", {
      call_id: "seed-call",
      session_id: "seed-session",
      assistant_message_id: "seed-message",
      ordinal: 0,
      tool_name: "read",
      input_text: "{}",
      status: "pending",
      created_at: "created",
    });
    insertRecord(db, "context_snapshots", { session_id: "seed-session", updated_at: "updated" });

    const requiredCases: Array<{
      table: string;
      record: Record<string, SqlValue>;
      columns: readonly string[];
    }> = [
      {
        table: "schema_migrations",
        record: { version: 50, applied_at: "applied" },
        columns: ["applied_at"],
      },
      {
        table: "projects",
        record: {
          id: "null-project", identity_kind: "path", identity_value: "D:\\null-project",
          root_path: "D:\\null-project", created_at: "created", updated_at: "updated",
        },
        columns: ["id", "identity_kind", "identity_value", "root_path", "created_at", "updated_at"],
      },
      {
        table: "sessions",
        record: {
          id: "null-session", project_id: "seed-project", title: "title", status: "idle",
          created_at: "created", updated_at: "updated",
        },
        columns: ["id", "project_id", "title", "status", "created_at", "updated_at"],
      },
      {
        table: "messages",
        record: {
          id: "null-message", session_id: "seed-session", seq: 20, role: "user", kind: "text",
          payload_json: "{}", status: "complete", created_at: "created", updated_at: "updated",
        },
        columns: ["id", "session_id", "seq", "role", "kind", "payload_json", "status", "created_at", "updated_at"],
      },
      {
        table: "tool_calls",
        record: {
          call_id: "null-call", session_id: "seed-session", assistant_message_id: "seed-message",
          ordinal: 20, tool_name: "read", input_text: "{}", status: "pending", created_at: "created",
        },
        columns: [
          "call_id", "session_id", "assistant_message_id", "ordinal", "tool_name", "input_text", "status", "created_at",
        ],
      },
      {
        table: "context_snapshots",
        record: {
          session_id: "seed-session", baseline: "", source_snapshot_json: "{}", baseline_seq: 0,
          summary_upto_seq: 0, updated_at: "updated",
        },
        columns: ["session_id", "baseline", "source_snapshot_json", "baseline_seq", "summary_upto_seq", "updated_at"],
      },
    ];
    for (const { table, record, columns } of requiredCases) {
      for (const column of columns) {
        assertInsertFails(
          db,
          () => insertRecord(db, table, { ...record, [column]: null }),
          new RegExp(`NOT NULL constraint failed: ${table}\\.${column}`),
        );
      }
    }

    for (const kind of ["remote", "root", "path"]) {
      isolated(db, () => insertRecord(db, "projects", {
        id: `kind-${kind}`, identity_kind: kind, identity_value: kind, root_path: kind,
        created_at: "created", updated_at: "updated",
      }));
    }
    assertInsertFails(db, () => insertRecord(db, "projects", {
      id: "kind-invalid", identity_kind: "local", identity_value: "x", root_path: "x",
      created_at: "created", updated_at: "updated",
    }), /CHECK constraint failed/);

    for (const status of ["idle", "running", "completed", "interrupted", "cancelled", "error"]) {
      isolated(db, () => insertRecord(db, "sessions", {
        id: `session-${status}`, project_id: "seed-project", title: status, status,
        created_at: "created", updated_at: "updated",
      }));
    }
    assertInsertFails(db, () => insertRecord(db, "sessions", {
      id: "session-invalid", project_id: "seed-project", title: "invalid", status: "pending",
      created_at: "created", updated_at: "updated",
    }), /CHECK constraint failed/);

    for (const role of ["system", "user", "assistant", "tool", "internal"]) {
      isolated(db, () => insertRecord(db, "messages", {
        id: `role-${role}`, session_id: "seed-session", seq: 30, role, kind: "text",
        payload_json: "{}", status: "complete", created_at: "created", updated_at: "updated",
      }));
    }
    assertInsertFails(db, () => insertRecord(db, "messages", {
      id: "role-invalid", session_id: "seed-session", seq: 31, role: "developer", kind: "text",
      payload_json: "{}", status: "complete", created_at: "created", updated_at: "updated",
    }), /CHECK constraint failed/);
    for (const status of ["streaming", "complete", "interrupted"]) {
      isolated(db, () => insertRecord(db, "messages", {
        id: `message-${status}`, session_id: "seed-session", seq: 32, role: "user", kind: "text",
        payload_json: "{}", status, created_at: "created", updated_at: "updated",
      }));
    }
    assertInsertFails(db, () => insertRecord(db, "messages", {
      id: "message-invalid", session_id: "seed-session", seq: 33, role: "user", kind: "text",
      payload_json: "{}", status: "idle", created_at: "created", updated_at: "updated",
    }), /CHECK constraint failed/);

    for (const status of ["pending", "awaiting_approval", "running", "success", "failure", "denied", "interrupted"]) {
      isolated(db, () => insertRecord(db, "tool_calls", {
        call_id: `call-${status}`, session_id: "seed-session", assistant_message_id: "seed-message",
        ordinal: 40, tool_name: "read", input_text: "{}", status, created_at: "created",
      }));
    }
    assertInsertFails(db, () => insertRecord(db, "tool_calls", {
      call_id: "call-invalid", session_id: "seed-session", assistant_message_id: "seed-message",
      ordinal: 41, tool_name: "read", input_text: "{}", status: "cancelled", created_at: "created",
    }), /CHECK constraint failed/);

    assertInsertFails(db, () => insertRecord(db, "schema_migrations", {
      version: 1, applied_at: "duplicate",
    }), /UNIQUE constraint failed: schema_migrations\.version/);
    assertInsertFails(db, () => seedProject(db, "seed-project"), /UNIQUE constraint failed: projects\.id/);
    assertInsertFails(db, () => seedSession(db, "seed-session", "seed-project"), /UNIQUE constraint failed: sessions\.id/);
    assertInsertFails(db, () => seedMessage(db, "seed-message", "seed-session", 2), /UNIQUE constraint failed: messages\.id/);
    assertInsertFails(db, () => insertRecord(db, "tool_calls", {
      call_id: "seed-call", session_id: "seed-session", assistant_message_id: "seed-message",
      ordinal: 2, tool_name: "read", input_text: "{}", status: "pending", created_at: "created",
    }), /UNIQUE constraint failed: tool_calls\.call_id/);
    assertInsertFails(db, () => insertRecord(db, "context_snapshots", {
      session_id: "seed-session", updated_at: "duplicate",
    }), /UNIQUE constraint failed: context_snapshots\.session_id/);
    assertInsertFails(db, () => seedMessage(db, "different-message", "seed-session", 1),
      /UNIQUE constraint failed: messages\.session_id, messages\.seq/);
    assertInsertFails(db, () => insertRecord(db, "tool_calls", {
      call_id: "different-call", session_id: "seed-session", assistant_message_id: "seed-message",
      ordinal: 0, tool_name: "read", input_text: "{}", status: "pending", created_at: "created",
    }), /UNIQUE constraint failed: tool_calls\.assistant_message_id, tool_calls\.ordinal/);
  } finally {
    connection.close();
  }
});

test("V1 enforces every foreign key, project restrict, and message/session cascades", async () => {
  const connection = await openFixture("foreign-keys");
  const db = connection.db;
  try {
    assertInsertFails(db, () => seedSession(db, "orphan-session", "missing-project"), /FOREIGN KEY constraint failed/);
    assertInsertFails(db, () => seedMessage(db, "orphan-message", "missing-session", 1), /FOREIGN KEY constraint failed/);
    assertInsertFails(db, () => insertRecord(db, "tool_calls", {
      call_id: "orphan-tool-session", session_id: "missing-session", assistant_message_id: "missing-message",
      ordinal: 0, tool_name: "read", input_text: "{}", status: "pending", created_at: "created",
    }), /FOREIGN KEY constraint failed/);
    seedProject(db, "fk-project");
    seedSession(db, "fk-session", "fk-project");
    assertInsertFails(db, () => insertRecord(db, "tool_calls", {
      call_id: "orphan-tool-message", session_id: "fk-session", assistant_message_id: "missing-message",
      ordinal: 0, tool_name: "read", input_text: "{}", status: "pending", created_at: "created",
    }), /FOREIGN KEY constraint failed/);
    assertInsertFails(db, () => insertRecord(db, "context_snapshots", {
      session_id: "missing-session", updated_at: "updated",
    }), /FOREIGN KEY constraint failed/);
    assert.throws(
      () => db.prepare("DELETE FROM projects WHERE id = 'fk-project'").run(),
      /FOREIGN KEY constraint failed/,
    );

    seedMessage(db, "message-cascade", "fk-session", 1);
    insertRecord(db, "tool_calls", {
      call_id: "tool-message-cascade", session_id: "fk-session", assistant_message_id: "message-cascade",
      ordinal: 0, tool_name: "read", input_text: "{}", status: "pending", created_at: "created",
    });
    db.prepare("DELETE FROM messages WHERE id = 'message-cascade'").run();
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE call_id = 'tool-message-cascade'").get()?.count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'fk-session'").get()?.count, 1);

    seedMessage(db, "session-message", "fk-session", 2);
    insertRecord(db, "tool_calls", {
      call_id: "session-tool", session_id: "fk-session", assistant_message_id: "session-message",
      ordinal: 0, tool_name: "read", input_text: "{}", status: "pending", created_at: "created",
    });
    insertRecord(db, "context_snapshots", { session_id: "fk-session", updated_at: "updated" });
    db.prepare("DELETE FROM sessions WHERE id = 'fk-session'").run();
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = 'fk-session'").get()?.count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE session_id = 'fk-session'").get()?.count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM context_snapshots WHERE session_id = 'fk-session'").get()?.count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = 'fk-project'").get()?.count, 1);
  } finally {
    connection.close();
  }
});
