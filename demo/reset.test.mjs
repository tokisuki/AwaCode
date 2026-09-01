import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
