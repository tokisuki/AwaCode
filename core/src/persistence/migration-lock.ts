import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, normalize, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface MigrationLock {
  release(): void;
}

export interface MigrationLockOptions {
  /** @internal Deterministic observation used only by real-process tests. */
  onBusy?(): void | Promise<void>;
  /** @internal Deterministic queue observation used only by lock tests. */
  onProcessMutexQueued?(waiting: boolean): void | Promise<void>;
}

const processMutexTails = new Map<string, Promise<void>>();

function normalizedPhysicalPath(path: string): string {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function canonicalDatabaseKey(databasePath: string): Promise<string> {
  let ancestor = resolve(databasePath);
  const missingSuffix: string[] = [];
  for (;;) {
    try {
      const physicalAncestor = await realpath(ancestor);
      return normalizedPhysicalPath(resolve(physicalAncestor, ...missingSuffix));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      missingSuffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

async function acquireProcessMutex(
  key: string,
  onQueued?: (waiting: boolean) => void | Promise<void>,
): Promise<() => void> {
  const waiting = processMutexTails.has(key);
  const previous = processMutexTails.get(key) ?? Promise.resolve();
  let openGate = () => {};
  const gate = new Promise<void>((resolveGate) => {
    openGate = resolveGate;
  });
  const tail = previous.then(() => gate);
  processMutexTails.set(key, tail);
  const cleanTail = () => {
    void tail.finally(() => {
      if (processMutexTails.get(key) === tail) {
        processMutexTails.delete(key);
      }
    });
  };
  try {
    await onQueued?.(waiting);
    await previous;
  } catch (error) {
    openGate();
    cleanTail();
    throw error;
  }

  let held = true;
  return () => {
    if (!held) {
      return;
    }
    held = false;
    openGate();
    cleanTail();
  };
}

function lockName(canonicalKey: string): string {
  return `${createHash("sha256").update(canonicalKey).digest("hex")}.db`;
}

function isBusyError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "errcode" in error
    && error.errcode === 5;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolveYield) => setImmediate(resolveYield));
}

export async function acquireMigrationLock(
  databasePath: string,
  options: MigrationLockOptions = {},
): Promise<MigrationLock> {
  const canonicalKey = await canonicalDatabaseKey(databasePath);
  const releaseProcessMutex = await acquireProcessMutex(
    canonicalKey,
    options.onProcessMutexQueued,
  );
  const lockDirectory = resolve(tmpdir(), "awacode-migration-locks");
  try {
    await mkdir(lockDirectory, { recursive: true });
    for (;;) {
      const lock = new DatabaseSync(resolve(lockDirectory, lockName(canonicalKey)));
      try {
        lock.exec("PRAGMA busy_timeout = 0");
        lock.exec(`
          CREATE TABLE IF NOT EXISTS migration_lock (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
          ) STRICT
        `);
        lock.exec("BEGIN IMMEDIATE");
        let held = true;
        return {
          release() {
            if (!held) {
              return;
            }
            held = false;
            try {
              lock.exec("ROLLBACK");
            } finally {
              try {
                lock.close();
              } finally {
                releaseProcessMutex();
              }
            }
          },
        };
      } catch (error) {
        lock.close();
        if (!isBusyError(error)) {
          throw error;
        }
        await options.onBusy?.();
        await yieldToEventLoop();
      }
    }
  } catch (error) {
    releaseProcessMutex();
    throw error;
  }
}
