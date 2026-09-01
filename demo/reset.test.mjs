import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSafeDemoTarget, resetDemoWorkspace } from "./reset.mjs";

const demoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const reset = join(demoRoot, "reset.mjs");

function runReset(...args) {
  const child = execFile(process.execPath, [reset, ...args], { windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return once(child, "close").then(([code]) => ({ code, stdout, stderr }));
}

test("reset validation rejects a controlled symbolic-link ancestor", async () => {
  const linkedAncestor = join(demoRoot, ".workspace", "controlled-link");
  await assert.rejects(
    assertSafeDemoTarget(join(linkedAncestor, "child"), {
      lstat: async (path) => ({
        isSymbolicLink: () => path === linkedAncestor,
      }),
    }),
    /symbolic link or junction/,
  );
});

test("reset rejects a real linked ancestor and preserves the external sentinel", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "awacode-reset-linked-outside-"));
  const ancestor = join(demoRoot, ".workspace", "linked-ancestor");
  const sentinel = join(outside, "sentinel.txt");
  try {
    await writeFile(sentinel, "must survive\n", "utf8");
    await rm(ancestor, { recursive: true, force: true });
    try {
      await symlink(outside, ancestor, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`link capability unavailable: ${error instanceof Error ? error.code ?? error.message : "unknown"}`);
      return;
    }

    const result = await runReset("--target", join(ancestor, "workspace"));
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /symbolic link or junction/);
    assert.equal(await readFile(sentinel, "utf8"), "must survive\n");
    await assert.rejects(readFile(join(outside, "workspace", "app.mjs"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(ancestor, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("reset revalidates an ancestor after deletion before copying the fixture", async () => {
  const outside = await mkdtemp(join(tmpdir(), "awacode-reset-swap-outside-"));
  const ancestor = join(demoRoot, ".workspace", "swap-ancestor");
  const target = join(ancestor, "workspace");
  const sentinel = join(outside, "sentinel.txt");
  try {
    await writeFile(sentinel, "must survive\n", "utf8");
    await rm(ancestor, { recursive: true, force: true });
    await assert.rejects(
      resetDemoWorkspace(target, {
        afterDeleteBeforeCopy: async () => {
          await rm(ancestor, { recursive: true, force: true });
          await symlink(outside, ancestor, process.platform === "win32" ? "junction" : "dir");
        },
      }),
      /symbolic link or junction/,
    );
    assert.equal(await readFile(sentinel, "utf8"), "must survive\n");
    await assert.rejects(readFile(join(outside, "workspace", "app.mjs"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(ancestor, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("reset requires an explicit target inside demo and restores the fixture", async () => {
  const outside = await mkdtemp(join(tmpdir(), "awacode-reset-outside-"));
  try {
    const missing = await runReset();
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /--target/);

    const rejected = await runReset("--target", outside);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /inside the demo directory/);

    const target = join(demoRoot, ".workspace", "reset-test");
    await rm(target, { recursive: true, force: true });
    const restored = await runReset("--target", target);
    assert.equal(restored.code, 0, restored.stderr);
    assert.match(await readFile(join(target, "app.mjs"), "utf8"), /total > 100/);

    await writeFile(join(target, "app.mjs"), "changed\n", "utf8");
    const second = await runReset("--target", target);
    assert.equal(second.code, 0, second.stderr);
    assert.match(await readFile(join(target, "app.mjs"), "utf8"), /total > 100/);
    await rm(target, { recursive: true, force: true });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
