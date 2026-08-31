import { backup, DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { link, mkdir, open as openFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import {
  prepareDataPaths,
  resolveDataPaths,
  type DataPathOptions,
  type DataPaths,
} from "./data-paths.ts";
import { withDatabaseSnapshot } from "./database-snapshot.ts";
import { acquireMigrationLock } from "./migration-lock.ts";
import {
  DATABASE_VERSION,
  type Migration,
  productionMigrations,
} from "./migrations.ts";

export interface OpenDatabaseOptions extends DataPathOptions {
  migrations?: readonly Migration[];
  now?: () => Date;
  /** @internal Deterministic barriers used only by real-disk/process tests. */
  testHooks?: {
    afterSnapshotClassification?(): void | Promise<void>;
    beforeBackupPublish?(temporaryPath: string): void | Promise<void>;
  };
}

export interface DatabaseConnection {
  readonly db: DatabaseSync;
  readonly paths: DataPaths;
  readonly version: number;
  close(): void;
}

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function hasUserSchemaObjects(db: DatabaseSync): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
  `).get() as { count: number };
  return row.count > 0;
}

function hasMigrationTable(db: DatabaseSync): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_schema
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get() as { count: number };
  return row.count === 1;
}

function isRecognizableMigrationTable(db: DatabaseSync): boolean {
  if (!hasMigrationTable(db)) {
    return false;
  }
  const columns = db.prepare("PRAGMA table_info(schema_migrations)").all() as unknown as TableInfoRow[];
  return columns.length === 2
    && columns[0]?.name === "version"
    && columns[0].type.toUpperCase() === "INTEGER"
    && columns[0].pk === 1
    && columns[1]?.name === "applied_at"
    && columns[1].type.toUpperCase() === "TEXT"
    && columns[1].notnull === 1;
}

function assertRecognizedOrEmpty(db: DatabaseSync, databasePath: string): void {
  if (hasUserSchemaObjects(db) && !isRecognizableMigrationTable(db)) {
    throw new Error(`refusing to initialize unrecognized non-empty database: ${databasePath}`);
  }
}

async function preflightDatabase(databasePath: string): Promise<void> {
  await withDatabaseSnapshot(databasePath, (snapshotPath) => {
    if (snapshotPath === undefined) {
      return;
    }
    const preflight = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      assertRecognizedOrEmpty(preflight, databasePath);
    } finally {
      preflight.close();
    }
  });
}

function databaseVersion(db: DatabaseSync): number {
  if (!hasMigrationTable(db)) {
    return 0;
  }
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as {
    version: number;
  };
  return row.version;
}

function appliedVersions(db: DatabaseSync): ReadonlySet<number> {
  if (!hasMigrationTable(db)) {
    return new Set();
  }
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as unknown as Array<{ version: number }>;
  return new Set(rows.map(({ version }) => version));
}

function validateMigrations(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previous) {
      throw new TypeError("database migrations must have unique, positive, ascending versions");
    }
    previous = migration.version;
  }
}

function applyMigration(db: DatabaseSync, migration: Migration, appliedAt: string): void {
  if (hasMigrationTable(db)) {
    const existing = db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(migration.version);
    if (existing !== undefined) {
      return;
    }
  }
  migration.up(db);
  if (!isRecognizableMigrationTable(db)) {
    throw new Error("migration did not leave a recognizable schema_migrations table");
  }
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
    .run(migration.version, appliedAt);
}

function backupName(version: number, now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `awacode-v${version}-${timestamp}.db`;
}

const BACKUP_TEMP_NAME = /^\.awacode-backup-[0-9a-f-]+\.tmp(?:-(?:journal|shm|wal))?$/i;

async function reserveTemporaryBackupPath(directory: string): Promise<string> {
  for (;;) {
    const path = resolve(directory, `.awacode-backup-${randomUUID()}.tmp`);
    try {
      const reservation = await openFile(path, "wx");
      await reservation.close();
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}

async function removeStaleBackupTemps(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && BACKUP_TEMP_NAME.test(entry.name))
    .map((entry) => rm(resolve(directory, entry.name), { force: true })));
}

async function removeTemporaryBackupArtifacts(temporaryPath: string): Promise<void> {
  await Promise.all(["", "-journal", "-shm", "-wal"]
    .map((suffix) => rm(`${temporaryPath}${suffix}`, { force: true })));
}

function finalizeAndValidateBackup(path: string): void {
  const validation = new DatabaseSync(path);
  try {
    validation.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (validation.prepare("PRAGMA journal_mode = DELETE").get()?.journal_mode !== "delete") {
      throw new Error(`backup could not leave WAL mode: ${path}`);
    }
    if (validation.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
      throw new Error(`backup integrity check failed: ${path}`);
    }
  } finally {
    validation.close();
  }
}

async function publishBackup(
  temporaryPath: string,
  directory: string,
  version: number,
  now: Date,
): Promise<void> {
  const baseName = backupName(version, now);
  const extensionIndex = baseName.lastIndexOf(".db");
  const stem = baseName.slice(0, extensionIndex);
  for (let collision = 0; ; collision += 1) {
    const name = collision === 0 ? baseName : `${stem}-${collision}.db`;
    const path = resolve(directory, name);
    try {
      await link(temporaryPath, path);
      await removeTemporaryBackupArtifacts(temporaryPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}

async function createBackup(
  databasePath: string,
  backupDirectory: string,
  version: number,
  now: Date,
  beforePublish?: (temporaryPath: string) => void | Promise<void>,
): Promise<void> {
  const temporaryPath = await reserveTemporaryBackupPath(backupDirectory);
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    await backup(source, temporaryPath);
    finalizeAndValidateBackup(temporaryPath);
    await beforePublish?.(temporaryPath);
    await publishBackup(temporaryPath, backupDirectory, version, now);
  } catch (error) {
    await removeTemporaryBackupArtifacts(temporaryPath);
    throw error;
  } finally {
    source.close();
  }
}

function configureConnection(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch (error) {
    if (
      typeof error !== "object"
      || error === null
      || !("errcode" in error)
      || error.errcode !== 5
    ) {
      throw error;
    }
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA synchronous = NORMAL");
}

export async function openDatabase(options: OpenDatabaseOptions = {}): Promise<DatabaseConnection> {
  const paths = resolveDataPaths(options);
  const migrations = options.migrations ?? productionMigrations;
  validateMigrations(migrations);
  const newestVersion = migrations.at(-1)?.version ?? 0;
  const migrationLock = await acquireMigrationLock(paths.database);

  try {
    await preflightDatabase(paths.database);
    await options.testHooks?.afterSnapshotClassification?.();
    await mkdir(paths.root, { recursive: true });
    const db = new DatabaseSync(paths.database);
    let closed = false;

    try {
      assertRecognizedOrEmpty(db, paths.database);
      await prepareDataPaths(options);
      configureConnection(db);
      db.exec("BEGIN IMMEDIATE");
      let version: number;
      try {
        await removeStaleBackupTemps(paths.backups);
        const nonEmpty = hasUserSchemaObjects(db);
        assertRecognizedOrEmpty(db, paths.database);
        const oldVersion = databaseVersion(db);
        if (oldVersion > newestVersion) {
          throw new Error(`database version ${oldVersion} is newer than supported version ${newestVersion}`);
        }
        const applied = appliedVersions(db);
        const missing = migrations.filter((migration) => !applied.has(migration.version));
        if (nonEmpty && missing.length > 0) {
          await createBackup(
            paths.database,
            paths.backups,
            oldVersion,
            (options.now ?? (() => new Date()))(),
            options.testHooks?.beforeBackupPublish,
          );
        }
        for (const migration of missing) {
          applyMigration(db, migration, (options.now ?? (() => new Date()))().toISOString());
        }
        version = databaseVersion(db);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the migration failure when SQLite already ended the transaction.
        }
        throw error;
      }
      return {
        db,
        paths,
        version,
        close() {
          if (!closed) {
            closed = true;
            db.close();
          }
        },
      };
    } catch (error) {
      if (!closed) {
        closed = true;
        db.close();
      }
      throw error;
    }
  } finally {
    migrationLock.release();
  }
}

export { DATABASE_VERSION };
