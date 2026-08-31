import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "../../src/persistence/database.ts";
import { productionMigrations, type Migration } from "../../src/persistence/migrations.ts";
import {
  disposeChildChannel,
  disposeChildChannels,
  spawnChildChannel,
  waitForChildExit,
  withTimeout,
} from "../support/child-process.ts";

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

function schemaSnapshot(db: DatabaseSync): Array<{ type: string; name: string; sql: string | null }> {
  return db.prepare(`
    SELECT type, name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all().map((row) => ({
    type: String(row.type),
    name: String(row.name),
    sql: row.sql === null ? null : String(row.sql),
  }));
}

async function databaseArtifacts(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.startsWith("awacode.db")).sort();
}

async function directoryFileSnapshot(root: string) {
  const entries = await readdir(root, { withFileTypes: true });
  return Promise.all(entries.sort((left, right) => left.name.localeCompare(right.name)).map(async (entry) => {
    const path = join(root, entry.name);
    const metadata = await stat(path);
    return {
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      size: metadata.size,
      mode: metadata.mode,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
      contentsHash: entry.isFile()
        ? createHash("sha256").update(await readFile(path)).digest("hex")
        : null,
    };
  }));
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

test("same-process concurrent initializers serialize without a five-second event-loop stall", async () => {
  const root = await dataRoot("same-process-race");
  const startedAt = Date.now();
  const [first, second] = await withTimeout(Promise.all([
    openDatabase({ env: { AWACODE_DATA_DIR: root } }),
    openDatabase({ env: { AWACODE_DATA_DIR: root } }),
  ]), 2000, "same-process database initialization");
  try {
    assert.equal(first.version, 1);
    assert.equal(second.version, 1);
    assert.ok(Date.now() - startedAt < 2000);
  } finally {
    first.close();
    second.close();
  }
});

test("same-process migration lock is released after an initializer error", async () => {
  const root = await dataRoot("same-process-error");
  await assert.rejects(
    openDatabase({
      env: { AWACODE_DATA_DIR: root },
      testHooks: {
        afterSnapshotClassification() {
          throw new Error("injected initializer failure");
        },
      },
    }),
    /injected initializer failure/,
  );

  const recovered = await withTimeout(
    openDatabase({ env: { AWACODE_DATA_DIR: root } }),
    1000,
    "database initialization after lock-holder error",
  );
  recovered.close();
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

test("rejects a view-only unknown database without creating AwaCode tables", async () => {
  const root = await dataRoot("unknown-view");
  const databasePath = join(root, "awacode.db");
  const unknown = new DatabaseSync(databasePath);
  unknown.exec("CREATE VIEW unrelated_view AS SELECT 'keep me' AS value");
  unknown.close();

  await assert.rejects(async () => {
    const accepted = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
    accepted.close();
    throw new Error("view-only database was accepted");
  }, /unrecognized non-empty database/);

  const reopened = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      reopened.prepare("SELECT value FROM unrelated_view").all().map((row) => String(row.value)),
      ["keep me"],
    );
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'projects'").get()?.count, 0);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'").get()?.count, 0);
  } finally {
    reopened.close();
  }
});

test("rejecting an unknown database does not change journal mode, schema, bytes, or sidecars", async () => {
  const root = await dataRoot("unknown-unchanged");
  const databasePath = join(root, "awacode.db");
  const unknown = new DatabaseSync(databasePath);
  unknown.exec("CREATE VIEW unrelated_view AS SELECT 'keep me' AS value");
  const journalModeBefore = String(unknown.prepare("PRAGMA journal_mode").get()?.journal_mode);
  const schemaBefore = schemaSnapshot(unknown);
  unknown.close();
  const bytesBefore = await readFile(databasePath);
  const artifactsBefore = await databaseArtifacts(root);

  await assert.rejects(
    openDatabase({ env: { AWACODE_DATA_DIR: root } }),
    /unrecognized non-empty database/,
  );

  const reopened = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(reopened.prepare("PRAGMA journal_mode").get()?.journal_mode, journalModeBefore);
    assert.deepEqual(schemaSnapshot(reopened), schemaBefore);
  } finally {
    reopened.close();
  }
  assert.deepEqual(await readFile(databasePath), bytesBefore);
  assert.deepEqual(await databaseArtifacts(root), artifactsBefore);
});

test("rejecting an unknown WAL database does not create SHM or change any original directory entry", async () => {
  const root = await dataRoot("unknown-wal-unchanged");
  const databasePath = join(root, "awacode.db");
  const unknown = new DatabaseSync(databasePath);
  unknown.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  unknown.exec("CREATE TABLE unrelated (value TEXT NOT NULL) STRICT");
  unknown.prepare("INSERT INTO unrelated (value) VALUES (?)").run("only in WAL");
  const databaseBytes = await readFile(databasePath);
  const walBytes = await readFile(`${databasePath}-wal`);
  unknown.close();
  await Promise.all(["", "-shm", "-wal"].map((suffix) => rm(`${databasePath}${suffix}`, { force: true })));
  await writeFile(databasePath, databaseBytes);
  await writeFile(`${databasePath}-wal`, walBytes);

  const before = await directoryFileSnapshot(root);
  assert.deepEqual(before.map(({ name }) => name), ["awacode.db", "awacode.db-wal"]);

  await assert.rejects(
    openDatabase({ env: { AWACODE_DATA_DIR: root } }),
    /unrecognized non-empty database/,
  );

  assert.deepEqual(await directoryFileSnapshot(root), before);
});

test("reclassifies a database replaced after snapshot before any persistent configuration", async () => {
  const root = await dataRoot("snapshot-replacement");
  const databasePath = join(root, "awacode.db");
  let hookCalls = 0;

  await assert.rejects(async () => {
    const accepted = await openDatabase({
      env: { AWACODE_DATA_DIR: root },
      testHooks: {
        afterSnapshotClassification() {
          hookCalls += 1;
          const replacement = new DatabaseSync(databasePath);
          replacement.exec("CREATE TABLE replacement_unknown (value TEXT NOT NULL) STRICT");
          replacement.prepare("INSERT INTO replacement_unknown (value) VALUES (?)").run("do not configure");
          replacement.close();
        },
      },
    });
    accepted.close();
    throw new Error("replacement hook was not awaited");
  }, /unrecognized non-empty database/);

  assert.equal(hookCalls, 1);
  const replacement = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(replacement.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
    assert.deepEqual(
      replacement.prepare("SELECT value FROM replacement_unknown").all().map((row) => String(row.value)),
      ["do not configure"],
    );
    assert.equal(replacement.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'projects'").get()?.count, 0);
  } finally {
    replacement.close();
  }
  assert.deepEqual(await databaseArtifacts(root), ["awacode.db"]);
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

test("two real initializers released together converge on one valid V1 schema", async () => {
  const root = await dataRoot("race");
  const fixture = join(import.meta.dirname, "..", "..", "test-fixtures", "database-initialize-child.ts");
  const channels = [0, 1].map(() => {
    const channel = spawnChildChannel(process.execPath, [fixture, root], {
      env: childEnvironment(),
    });
    return { ...channel, ready: channel.lines.nextLine() };
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
    const exits = await Promise.all(channels.map((channel, index) =>
      waitForChildExit(channel, 5000, `initializer ${index} completion`)));
    assert.deepEqual(exits.map(([code]) => code), [0, 0]);
  } finally {
    await disposeChildChannels(channels, "initializer cleanup");
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

test("a cross-process lock retries asynchronously until a crashed holder releases it", async () => {
  const root = await dataRoot("held-lock-crash");
  const fixture = join(import.meta.dirname, "..", "..", "test-fixtures", "database-initialize-child.ts");
  const timestamp = "2026-08-31T10:11:12.444Z";
  const holder = spawnChildChannel(process.execPath, [fixture, root, timestamp, "pause-after-snapshot"], {
    env: childEnvironment(),
  });
  const waiter = spawnChildChannel(process.execPath, [fixture, root, timestamp, "report-lock-busy"], {
    env: childEnvironment(),
  });

  try {
    assert.equal(await holder.lines.nextLine(), "READY");
    holder.child.stdin.write("GO\n");
    assert.equal(await holder.lines.nextLine(), "LOCK_HELD");

    assert.equal(await waiter.lines.nextLine(), "READY");
    waiter.child.stdin.write("GO\n");
    assert.equal(await waiter.lines.nextLine(), "LOCK_BUSY");
    assert.equal(await waiter.lines.nextLine(), "LOCK_RETRY_WAIT 1");

    assert.equal(holder.child.kill(), true);
    const [holderCode, holderSignal] = await withTimeout(holder.exited, 5000, "lock holder termination");
    assert.ok(holderCode !== 0 || holderSignal !== null);
    waiter.child.stdin.end("RETRY\n");
    assert.deepEqual(JSON.parse(await waiter.lines.nextLine()), { version: 1, migrationCount: 1 });
    assert.equal((await withTimeout(waiter.exited, 5000, "lock waiter completion"))[0], 0);
  } finally {
    await disposeChildChannels([holder, waiter], "held-lock child cleanup");
  }
});

test("a killed initializer paused after backup validation leaves only a stale temp for recovery", async () => {
  const root = await dataRoot("backup-crash");
  const databasePath = join(root, "awacode.db");
  const old = new DatabaseSync(databasePath);
  old.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE legacy_blob (id INTEGER PRIMARY KEY, payload BLOB NOT NULL) STRICT;
    INSERT INTO legacy_blob (payload) VALUES (zeroblob(1048576));
  `);
  old.close();
  const backupDirectory = join(root, "backups");
  await mkdir(backupDirectory);

  const timestamp = "2026-08-31T10:11:12.333Z";
  const fixture = join(import.meta.dirname, "..", "..", "test-fixtures", "database-initialize-child.ts");
  const channel = spawnChildChannel(process.execPath, [fixture, root, timestamp, "pause-before-publish"], {
    env: childEnvironment(),
  });
  const { child } = channel;
  const { lines, exited } = channel;
  let validatedArtifact = "";
  try {
    assert.equal(await lines.nextLine(), "READY");
    child.stdin.write("GO\n");
    validatedArtifact = await lines.nextLine();
    assert.match(validatedArtifact, /^BACKUP_VALIDATED \.awacode-backup-[0-9a-f-]+\.tmp$/);
    const whilePaused = await readdir(backupDirectory);
    assert.equal(whilePaused.length, 1);
    assert.match(whilePaused[0] as string, /^\.awacode-backup-[0-9a-f-]+\.tmp$/);
    assert.deepEqual(whilePaused.filter((name) => name.endsWith(".db")), []);
    const validated = new DatabaseSync(join(backupDirectory, whilePaused[0] as string), { readOnly: true });
    try {
      assert.equal(validated.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
      assert.equal(validated.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      assert.equal(validated.prepare("SELECT COUNT(*) AS count FROM legacy_blob").get()?.count, 1);
      assert.equal(validated.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 0);
    } finally {
      validated.close();
    }
    assert.equal(child.kill(), true);
    const [code, signal] = await withTimeout(exited, 5000, "paused backup child termination");
    assert.ok(code !== 0 || signal !== null);
  } finally {
    await disposeChildChannel(channel, "backup child cleanup");
  }

  const afterCrash = await readdir(backupDirectory);
  assert.equal(afterCrash.length, 1);
  assert.match(afterCrash[0] as string, /^\.awacode-backup-[0-9a-f-]+\.tmp$/);
  assert.deepEqual(afterCrash.filter((name) => name.endsWith(".db")), []);

  const recovered = await openDatabase({
    env: { AWACODE_DATA_DIR: root },
    now: () => new Date(timestamp),
  });
  recovered.close();

  const afterRecovery = await readdir(backupDirectory);
  assert.deepEqual(afterRecovery, ["awacode-v0-2026-08-31T10-11-12-333Z.db"]);
  const completed = new DatabaseSync(join(backupDirectory, afterRecovery[0] as string), { readOnly: true });
  try {
    assert.equal(completed.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.equal(completed.prepare("SELECT COUNT(*) AS count FROM legacy_blob").get()?.count, 1);
    assert.equal(completed.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 0);
    assert.equal(completed.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'projects'").get()?.count, 0);
  } finally {
    completed.close();
  }
});

test("two real V0 upgrades share one critical section and never overwrite a colliding backup", async () => {
  const root = await dataRoot("old-race");
  const databasePath = join(root, "awacode.db");
  const old = new DatabaseSync(databasePath);
  old.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE legacy_notes (value TEXT NOT NULL) STRICT;
    INSERT INTO legacy_notes (value) VALUES ('V0 survives');
  `);
  old.close();

  const timestamp = "2026-08-31T09:10:11.222Z";
  const baseName = "awacode-v0-2026-08-31T09-10-11-222Z.db";
  const backupDirectory = join(root, "backups");
  await mkdir(backupDirectory);
  const collision = new DatabaseSync(join(backupDirectory, baseName));
  collision.exec(`
    CREATE TABLE collision_sentinel (value TEXT NOT NULL) STRICT;
    INSERT INTO collision_sentinel (value) VALUES ('do not overwrite');
  `);
  collision.close();

  const fixture = join(import.meta.dirname, "..", "..", "test-fixtures", "database-initialize-child.ts");
  const channels = [0, 1].map(() => {
    const channel = spawnChildChannel(process.execPath, [fixture, root, timestamp], {
      env: childEnvironment(),
    });
    return { ...channel, ready: channel.lines.nextLine() };
  });
  try {
    assert.deepEqual(await Promise.all(channels.map((channel) => channel.ready)), ["READY", "READY"]);
    const results = channels.map((channel) => channel.lines.nextLine());
    for (const channel of channels) {
      channel.child.stdin.end("GO\n");
    }
    assert.deepEqual((await Promise.all(results)).map((line) => JSON.parse(line)), [
      { version: 1, migrationCount: 1 },
      { version: 1, migrationCount: 1 },
    ]);
    assert.deepEqual(
      (await Promise.all(channels.map((channel, index) =>
        waitForChildExit(channel, 5000, `empty initializer ${index} completion`)))).map(([code]) => code),
      [0, 0],
    );
  } finally {
    await disposeChildChannels(channels, "V0 initializer cleanup");
  }

  const collisionAfter = new DatabaseSync(join(backupDirectory, baseName), { readOnly: true });
  try {
    assert.deepEqual(
      collisionAfter.prepare("SELECT value FROM collision_sentinel").all().map((row) => String(row.value)),
      ["do not overwrite"],
    );
  } finally {
    collisionAfter.close();
  }

  assert.deepEqual((await readdir(backupDirectory)).sort(), [
    "awacode-v0-2026-08-31T09-10-11-222Z-1.db",
    baseName,
  ]);
  const v0Backup = new DatabaseSync(
    join(backupDirectory, "awacode-v0-2026-08-31T09-10-11-222Z-1.db"),
    { readOnly: true },
  );
  try {
    assert.equal(v0Backup.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.equal(v0Backup.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 0);
    assert.equal(v0Backup.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'projects'").get()?.count, 0);
    assert.deepEqual(
      v0Backup.prepare("SELECT value FROM legacy_notes").all().map((row) => String(row.value)),
      ["V0 survives"],
    );
  } finally {
    v0Backup.close();
  }
});
