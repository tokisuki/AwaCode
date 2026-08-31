import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface MigrationLock {
  release(): void;
}

function lockName(databasePath: string): string {
  const normalizedPath = process.platform === "win32"
    ? resolve(databasePath).toLowerCase()
    : resolve(databasePath);
  return `${createHash("sha256").update(normalizedPath).digest("hex")}.db`;
}

export async function acquireMigrationLock(databasePath: string): Promise<MigrationLock> {
  const lockDirectory = resolve(tmpdir(), "awacode-migration-locks");
  await mkdir(lockDirectory, { recursive: true });
  const lock = new DatabaseSync(resolve(lockDirectory, lockName(databasePath)));
  let held = false;
  try {
    lock.exec("PRAGMA busy_timeout = 5000");
    lock.exec(`
      CREATE TABLE IF NOT EXISTS migration_lock (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      ) STRICT
    `);
    lock.exec("BEGIN IMMEDIATE");
    held = true;
  } catch (error) {
    lock.close();
    throw error;
  }

  return {
    release() {
      if (held) {
        held = false;
        try {
          lock.exec("ROLLBACK");
        } finally {
          lock.close();
        }
      }
    },
  };
}
