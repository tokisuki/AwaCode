import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryStore, MemoryStoreError } from "../../src/memory/memory-store.ts";

const temporaryDirectories: string[] = [];

async function fixture(label: string, beforeReplace?: () => Promise<void>) {
  const dataRoot = await mkdtemp(join(tmpdir(), `awacode-memory-${label}-`));
  temporaryDirectories.push(dataRoot);
  return {
    dataRoot,
    store: new MemoryStore({ env: { AWACODE_DATA_DIR: dataRoot } }, {
      createTemporaryName: () => `${label}-temporary`,
      ...(beforeReplace === undefined ? {} : { beforeReplace }),
    }),
  };
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("memory store keeps global and project text separate and supports append, exact update, and forget", async () => {
  const { store } = await fixture("scopes");
  assert.deepEqual(await store.read("project-one"), { global: "", project: "" });

  await store.write({ scope: "global", projectId: "project-one", newText: "Use concise replies." });
  await store.write({ scope: "project", projectId: "project-one", newText: "Build uses Node 24." });
  await store.write({ scope: "project", projectId: "project-one", newText: "Tests are mandatory." });
  assert.deepEqual(await store.read("project-one"), {
    global: "Use concise replies.",
    project: "Build uses Node 24.\nTests are mandatory.",
  });
  assert.deepEqual(await store.read("project-two"), { global: "Use concise replies.", project: "" });

  await store.write({
    scope: "project",
    projectId: "project-one",
    oldText: "Build uses Node 24.",
    newText: "Build uses bundled Node 24.",
  });
  await store.write({
    scope: "project",
    projectId: "project-one",
    oldText: "\nTests are mandatory.",
    newText: "",
  });
  assert.equal((await store.read("project-one")).project, "Build uses bundled Node 24.");
});

test("memory store rejects absent or non-unique exact updates without changing text", async () => {
  const { store } = await fixture("exact");
  await store.write({ scope: "project", projectId: "project", newText: "same same" });
  for (const oldText of ["missing", "same"]) {
    await assert.rejects(
      store.write({ scope: "project", projectId: "project", oldText, newText: "changed" }),
      (error: unknown) => error instanceof MemoryStoreError
        && error.code === (oldText === "same" ? "match_not_unique" : "match_not_found"),
    );
  }
  assert.equal((await store.read("project")).project, "same same");
});

test("memory replacement is atomic and leaves no published temporary file", async () => {
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  let pause = false;
  const { dataRoot, store } = await fixture("atomic", async () => {
    if (pause) {
      entered();
      await releasePromise;
    }
  });
  await store.write({ scope: "global", projectId: "project", newText: "old" });
  pause = true;
  const pending = store.write({ scope: "global", projectId: "project", oldText: "old", newText: "new" });
  await enteredPromise;
  assert.equal((await store.read("project")).global, "old");
  release();
  await pending;
  assert.equal((await store.read("project")).global, "new");
  assert.deepEqual(await readdir(join(dataRoot, "memory")), ["global.md"]);
});
