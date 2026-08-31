import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import test from "node:test";

import {
  acquireMigrationLock,
  canonicalDatabaseKey,
  type MigrationLock,
} from "../../src/persistence/migration-lock.ts";

const temporaryDirectories: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `awacode-lock-${label}-`));
  temporaryDirectories.push(root);
  return root;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function platformKey(path: string): string {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("canonical database keys preserve a nonexistent suffix below the nearest physical ancestor", async () => {
  const root = await temporaryRoot("nonexistent");
  const physicalRoot = await realpath(root);
  const databasePath = join(root, "not-created-yet", "awacode.db");
  const beforeCreation = await canonicalDatabaseKey(databasePath);
  assert.equal(beforeCreation, platformKey(resolve(physicalRoot, "not-created-yet", "awacode.db")));

  await mkdir(join(root, "not-created-yet"));
  await writeFile(databasePath, "");
  assert.equal(await canonicalDatabaseKey(databasePath), beforeCreation);
});

test("junction or symlink aliases share one canonical process-mutex queue", async (t) => {
  const root = await temporaryRoot("alias");
  const physicalRoot = join(root, "physical");
  const aliasRoot = join(root, "alias");
  await mkdir(physicalRoot);
  try {
    await symlink(physicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip(`filesystem links are unavailable: ${(error as Error).message}`);
      return;
    }
    throw error;
  }

  const physicalDatabase = join(physicalRoot, "awacode.db");
  const aliasDatabase = join(aliasRoot, "awacode.db");
  assert.equal(await canonicalDatabaseKey(aliasDatabase), await canonicalDatabaseKey(physicalDatabase));

  let first: MigrationLock | undefined;
  let second: MigrationLock | undefined;
  let third: MigrationLock | undefined;
  try {
    first = await acquireMigrationLock(physicalDatabase);
    let reportQueued = (_waiting: boolean) => {};
    const queued = new Promise<boolean>((resolveQueued) => {
      reportQueued = resolveQueued;
    });
    const secondPromise = acquireMigrationLock(aliasDatabase, {
      onProcessMutexQueued: reportQueued,
    });
    assert.equal(await withTimeout(queued, 1000, "alias mutex queue observation"), true);
    first.release();
    first = undefined;
    second = await withTimeout(secondPromise, 1000, "alias lock acquisition");
    second.release();
    second = undefined;
    third = await acquireMigrationLock(physicalDatabase, {
      onProcessMutexQueued(waiting) {
        assert.equal(waiting, false);
      },
    });
  } finally {
    third?.release();
    second?.release();
    first?.release();
  }
});

test("a process-mutex queue entry is released when acquisition observation fails", async () => {
  const root = await temporaryRoot("queue-error");
  const databasePath = join(root, "awacode.db");
  await assert.rejects(
    acquireMigrationLock(databasePath, {
      onProcessMutexQueued() {
        throw new Error("injected queue observation failure");
      },
    }),
    /injected queue observation failure/,
  );

  const recovered = await withTimeout(
    acquireMigrationLock(databasePath),
    1000,
    "lock acquisition after queue error",
  );
  recovered.release();
});
