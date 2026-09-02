import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { startScriptedOpenAI, textTurn, toolTurn } from "../../core/test/support/scripted-openai.ts";

const node = process.env.AWACODE_NODE_PATH;
const probe = process.env.AWACODE_REAL_CORE_PROBE;
assert.ok(node, "AWACODE_NODE_PATH is required");
assert.ok(probe, "AWACODE_REAL_CORE_PROBE is required");

const root = await mkdtemp(join(tmpdir(), "awacode-qt-real-"));
const workspace = join(root, "workspace");
const data = join(root, "data");
await writeFile(join(root, ".keep"), "");
await (await import("node:fs/promises")).mkdir(workspace);
await writeFile(join(workspace, "app.mjs"), "export function total() { return 1; }\n");
await writeFile(join(workspace, "app.test.mjs"), [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import { total } from "./app.mjs";',
  'test("total", () => assert.equal(total(), 2));',
].join("\n"));

const command = `& '${node.replaceAll("'", "''")}' --test app.test.mjs`;
const provider = await startScriptedOpenAI([
  textTurn("Plan: inspect, reproduce, edit, verify."),
  toolTurn("list", "list_files", { path: ".", max_depth: 2 }),
  toolTurn("read", "read_file", { path: "app.mjs" }),
  toolTurn("fail", "run_command", { command, cwd: ".", timeout_ms: 30_000 }),
  toolTurn("edit", "edit_file", { path: "app.mjs", old_text: "return 1;", new_text: "return 2;" }),
  toolTurn("pass", "run_command", { command, cwd: ".", timeout_ms: 30_000 }),
  textTurn("Fixed and verified."),
]);

try {
  const child = spawn(probe, [node, resolve("core/dist/index.js"), workspace], {
    cwd: resolve("."),
    env: {
      ...process.env,
      AWACODE_DATA_DIR: data,
      AWACODE_BASE_URL: provider.baseUrl,
      AWACODE_MODEL: "fixture-model",
      AWACODE_API_KEY: "fixture-key-for-local-e2e-only",
      AWACODE_CONTEXT_LIMIT: "32768",
      AWACODE_MAX_OUTPUT_TOKENS: "4096",
    },
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  const [code] = await once(child, "close");
  assert.equal(code, 0, Buffer.concat(output).toString("utf8"));
  assert.match(Buffer.concat(output).toString("utf8"), /qt-real-core-ok/);
  assert.equal(await readFile(join(workspace, "app.mjs"), "utf8"), "export function total() { return 2; }\n");
  assert.equal(provider.requests.length, 7);
} finally {
  await provider.close();
  await rm(root, { recursive: true, force: true });
}
