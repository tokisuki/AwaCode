import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalDatabaseKey } from "./migration-lock.ts";

export class DataRootInUseError extends Error {
  readonly code = "data_root_in_use" as const;

  constructor() {
    super("AwaCode data directory is already in use by another AwaCode Core.");
    this.name = "DataRootInUseError";
  }
}

export interface DataRootLock {
  release(): void;
}

function isBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "errcode" in error && error.errcode === 5;
}

export async function acquireDataRootLock(databasePath: string): Promise<DataRootLock> {
  const canonical = await canonicalDatabaseKey(databasePath);
  const directory = dirname(canonical);
  await mkdir(directory, { recursive: true });
  const lock = new DatabaseSync(resolve(directory, ".awacode-core-lock.db"));
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    lock.exec("CREATE TABLE IF NOT EXISTS owner_lock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1)) STRICT");
    lock.exec("BEGIN IMMEDIATE");
  } catch (error) {
    lock.close();
    if (isBusy(error)) throw new DataRootInUseError();
    throw error;
  }
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      try {
        lock.exec("ROLLBACK");
      } finally {
        lock.close();
      }
    },
  };
}
