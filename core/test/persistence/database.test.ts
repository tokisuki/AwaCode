import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "../../src/persistence/database.ts";
import { productionMigrations, type Migration } from "../../src/persistence/migrations.ts";

const temporaryDirectories: string[] = [];

async function dataRoot(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-db-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function columnNames(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

test("opens a real V1 database with the exact strict schema and connection PRAGMAs", async () => {
  const root = await dataRoot("v1");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  try {
    assert.equal(connection.version, 1);
    assert.equal(connection.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    assert.equal(connection.db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    assert.equal(connection.db.prepare("PRAGMA synchronous").get()?.synchronous, 1);
    assert.equal(connection.db.prepare("PRAGMA busy_timeout").get()?.timeout, 5000);

    const tables = connection.db.prepare(`
      SELECT name, strict
      FROM pragma_table_list
      WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => ({ name: String(row.name), strict: Number(row.strict) }));
    assert.deepEqual(tables, [
      { name: "context_snapshots", strict: 1 },
      { name: "messages", strict: 1 },
      { name: "projects", strict: 1 },
      { name: "schema_migrations", strict: 1 },
      { name: "sessions", strict: 1 },
      { name: "tool_calls", strict: 1 },
    ]);
    assert.deepEqual(columnNames(connection.db, "schema_migrations"), ["version", "applied_at"]);
    assert.deepEqual(columnNames(connection.db, "projects"), [
      "id", "identity_kind", "identity_value", "remote", "root_path", "created_at", "updated_at",
    ]);
    assert.deepEqual(columnNames(connection.db, "sessions"), [
      "id", "project_id", "title", "model_json", "status", "created_at", "updated_at",
    ]);
    assert.deepEqual(columnNames(connection.db, "messages"), [
      "id", "session_id", "seq", "role", "kind", "payload_json", "status", "created_at", "updated_at",
    ]);
    assert.deepEqual(columnNames(connection.db, "tool_calls"), [
      "call_id", "session_id", "assistant_message_id", "ordinal", "tool_name", "input_text", "status",
      "result_json", "error_text", "created_at", "started_at", "finished_at",
    ]);
    assert.deepEqual(columnNames(connection.db, "context_snapshots"), [
      "session_id", "baseline", "source_snapshot_json", "baseline_seq", "summary", "summary_upto_seq", "updated_at",
    ]);

    assert.throws(
      () => connection.db.prepare(`
        INSERT INTO projects
          (id, identity_kind, identity_value, root_path, created_at, updated_at)
        VALUES ('bad', 'guess', 'value', 'C:\\repo', 'now', 'now')
      `).run(),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => connection.db.prepare(`
        INSERT INTO sessions
          (id, project_id, title, status, created_at, updated_at)
        VALUES ('orphan', 'missing', 'Title', 'idle', 'now', 'now')
      `).run(),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    connection.close();
  }
});

test("migration initialization is idempotent across close and reopen", async () => {
  const root = await dataRoot("reopen");
  const first = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 1);
  first.close();

  const second = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  try {
    assert.equal(second.version, 1);
    assert.equal(second.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 1);
    assert.deepEqual(
      second.db.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)),
      [1],
    );
  } finally {
    second.close();
  }
  assert.deepEqual(await readdir(join(root, "backups")), []);
});

test("applies a missing lower migration instead of trusting only the maximum version", async () => {
  const root = await dataRoot("missing-lower");
  const databasePath = join(root, "awacode.db");
  const partial = new DatabaseSync(databasePath);
  partial.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations (version, applied_at) VALUES (2, 'partial');
  `);
  partial.close();
  const secondMigration: Migration = { version: 2, up() {} };

  const connection = await openDatabase({
    env: { AWACODE_DATA_DIR: root },
    migrations: [...productionMigrations, secondMigration],
  });
  try {
    assert.deepEqual(
      connection.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
        .map((row) => Number(row.version)),
      [1, 2],
    );
    assert.equal(connection.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'projects'").get()?.count, 1);
  } finally {
    connection.close();
  }
});

test("rejects an unknown non-empty database without replacing it", async () => {
  const root = await dataRoot("unknown");
  const databasePath = join(root, "awacode.db");
  const unknown = new DatabaseSync(databasePath);
  unknown.exec("CREATE TABLE unrelated (value TEXT NOT NULL) STRICT");
  unknown.prepare("INSERT INTO unrelated (value) VALUES (?)").run("keep me");
  unknown.close();

  await assert.rejects(
    openDatabase({ env: { AWACODE_DATA_DIR: root } }),
    /unrecognized non-empty database/,
  );

  const reopened = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      reopened.prepare("SELECT value FROM unrelated").all().map((row) => String(row.value)),
      ["keep me"],
    );
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'projects'").get()?.count, 0);
  } finally {
    reopened.close();
  }
});

test("backs up a recognized V0 database before upgrading it successfully", async () => {
  const root = await dataRoot("backup-success");
  const databasePath = join(root, "awacode.db");
  const old = new DatabaseSync(databasePath);
  old.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE legacy_notes (value TEXT NOT NULL) STRICT;
    INSERT INTO legacy_notes (value) VALUES ('preserve me');
  `);
  old.close();

  const connection = await openDatabase({
    env: { AWACODE_DATA_DIR: root },
    now: () => new Date("2026-08-31T01:02:03.456Z"),
  });
  try {
    assert.equal(connection.version, 1);
    assert.deepEqual(
      connection.db.prepare("SELECT value FROM legacy_notes").all().map((row) => String(row.value)),
      ["preserve me"],
    );
  } finally {
    connection.close();
  }

  const backupFiles = await readdir(join(root, "backups"));
  assert.deepEqual(backupFiles, ["awacode-v0-2026-08-31T01-02-03-456Z.db"]);
  const backup = new DatabaseSync(join(root, "backups", backupFiles[0] as string), { readOnly: true });
  try {
    assert.equal(backup.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.deepEqual(
      backup.prepare("SELECT value FROM legacy_notes").all().map((row) => String(row.value)),
      ["preserve me"],
    );
    assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 0);
    assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'projects'").get()?.count, 0);
  } finally {
    backup.close();
  }
});

test("a failed upgrade rolls back DDL and its migration row while leaving source and backup usable", async () => {
  const root = await dataRoot("backup-failure");
  const initial = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  initial.db.prepare(`
    INSERT INTO projects
      (id, identity_kind, identity_value, root_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("project-before-failure", "path", "C:\\repo", "C:\\repo", "before", "before");
  initial.close();

  const failingMigration: Migration = {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE migration_should_rollback (value TEXT NOT NULL) STRICT;
        CREATE TRIGGER reject_v2
        BEFORE INSERT ON schema_migrations
        WHEN NEW.version = 2
        BEGIN
          SELECT RAISE(ABORT, 'injected migration failure');
        END;
      `);
    },
  };

  await assert.rejects(
    openDatabase({
      env: { AWACODE_DATA_DIR: root },
      migrations: [...productionMigrations, failingMigration],
      now: () => new Date("2026-08-31T02:03:04.567Z"),
    }),
    /injected migration failure/,
  );

  const source = new DatabaseSync(join(root, "awacode.db"));
  try {
    assert.equal(source.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.deepEqual(
      source.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => Number(row.version)),
      [1],
    );
    assert.equal(source.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'migration_should_rollback'").get()?.count, 0);
    assert.equal(source.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'reject_v2'").get()?.count, 0);
    assert.equal(source.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = 'project-before-failure'").get()?.count, 1);
  } finally {
    source.close();
  }

  const backupFiles = await readdir(join(root, "backups"));
  assert.deepEqual(backupFiles, ["awacode-v1-2026-08-31T02-03-04-567Z.db"]);
  const backup = new DatabaseSync(join(root, "backups", backupFiles[0] as string), { readOnly: true });
  try {
    assert.equal(backup.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = 'project-before-failure'").get()?.count, 1);
  } finally {
    backup.close();
  }
});

function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|OPENAI|ANTHROPIC|AZURE|AWS)/i.test(name)));
}

function childLineReader(child: ChildProcessWithoutNullStreams): { nextLine(): Promise<string> } {
  const lines: string[] = [];
  const waiters: Array<{ resolve(line: string): void; reject(error: Error): void }> = [];
  const diagnostics: Buffer[] = [];
  let partial = "";
  let terminalError: Error | undefined;

  child.stderr.on("data", (chunk: Buffer) => diagnostics.push(Buffer.from(chunk)));
  child.stdout.on("data", (chunk: Buffer) => {
    partial += chunk.toString("utf8");
    let newline = partial.indexOf("\n");
    while (newline >= 0) {
      const line = partial.slice(0, newline).replace(/\r$/, "");
      partial = partial.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter === undefined) {
        lines.push(line);
      } else {
        waiter.resolve(line);
      }
      newline = partial.indexOf("\n");
    }
  });
  child.once("exit", (code, signal) => {
    terminalError = new Error(
      `initializer exited before its next line (code=${String(code)}, signal=${String(signal)}): ${Buffer.concat(diagnostics).toString("utf8")}`,
    );
    for (const waiter of waiters.splice(0)) {
      waiter.reject(terminalError);
    }
  });

  return {
    nextLine() {
      const line = lines.shift();
      if (line !== undefined) {
        return Promise.resolve(line);
      }
      if (terminalError !== undefined) {
        return Promise.reject(terminalError);
      }
      return new Promise<string>((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

test("two real initializers released together converge on one valid V1 schema", async () => {
  const root = await dataRoot("race");
  const fixture = join(import.meta.dirname, "..", "..", "test-fixtures", "database-initialize-child.ts");
  const channels = [0, 1].map(() => {
    const child = spawn(process.execPath, [fixture, root], {
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = childLineReader(child);
    return { child, lines, ready: lines.nextLine(), exited: once(child, "exit") };
  });
  const children = channels.map((channel) => channel.child);

  try {
    const readyLines = await Promise.all(channels.map((channel) => channel.ready));
    assert.deepEqual(readyLines, ["READY", "READY"]);
    const resultPromises = channels.map((channel) => channel.lines.nextLine());
    for (const child of children) {
      child.stdin.end("GO\n");
    }
    const resultLines = await Promise.all(resultPromises);
    assert.deepEqual(resultLines.map((line) => JSON.parse(line)), [
      { version: 1, migrationCount: 1 },
      { version: 1, migrationCount: 1 },
    ]);
    const exits = await Promise.all(channels.map((channel) => channel.exited));
    assert.deepEqual(exits.map(([code]) => code), [0, 0]);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill();
      }
    }
  }

  const verified = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  try {
    assert.equal(verified.db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.equal(verified.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 1").get()?.count, 1);
    assert.equal(verified.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'projects'").get()?.count, 1);
  } finally {
    verified.close();
  }
});
