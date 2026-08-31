import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import test from "node:test";

import { prepareDataPaths, resolveDataPaths } from "../../src/persistence/data-paths.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("uses the non-blank override without touching the real user data directory", async () => {
  const parent = await temporaryDirectory("paths-override");
  const override = join(parent, "portable", "..", "data");
  const forbidden = join(parent, "real-user-data");

  const paths = await prepareDataPaths({
    env: { AWACODE_DATA_DIR: override, LOCALAPPDATA: forbidden },
  });

  assert.deepEqual(paths, {
    root: resolve(normalize(override)),
    database: resolve(override, "awacode.db"),
    config: resolve(override, "config.json"),
    auth: resolve(override, "auth.json"),
    memory: resolve(override, "memory"),
    backups: resolve(override, "backups"),
  });
  await access(paths.root);
  await access(paths.backups);
  await assert.rejects(access(forbidden));
});

test("uses LOCALAPPDATA AwaCode on Windows when the override is blank", () => {
  const localAppData = resolve("C:\\", "Users", "tester", "AppData", "Local");

  const paths = resolveDataPaths({
    env: { AWACODE_DATA_DIR: "  ", LOCALAPPDATA: localAppData },
    platform: "win32",
  });

  assert.equal(paths.root, resolve(localAppData, "AwaCode"));
});

test("rejects a missing or blank Windows LOCALAPPDATA without an override", () => {
  for (const localAppData of [undefined, "", "   "]) {
    assert.throws(
      () => resolveDataPaths({ env: { LOCALAPPDATA: localAppData }, platform: "win32" }),
      /LOCALAPPDATA must be non-blank/,
    );
  }
});
