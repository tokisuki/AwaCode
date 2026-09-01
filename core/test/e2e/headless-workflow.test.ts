import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore, type ToolCallRecord } from "../../src/persistence/session-store.ts";
import { StdioRpc } from "../../src/protocol/stdio-rpc.ts";
import type { PermissionRequest } from "../../src/tools/permission.ts";
import {
  disposeChildChannel,
  spawnChildChannel,
  withTimeout,
  type ChildChannel,
} from "../support/child-process.ts";
import {
  startScriptedOpenAI,
  textTurn,
  toolTurn,
} from "../support/scripted-openai.ts";

const NODE24 = process.execPath;
const CORE_ENTRY = resolve("dist/index.js");
const CLI_ENTRY = resolve("dist/cli/index.js");
const FIXTURE_KEY = "fixture-key-for-local-e2e-only";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `awacode-e2e-${label}-`));
  temporaryDirectories.push(path);
  return path;
}

function modelEnvironment(dataRoot: string, baseUrl: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT")),
    AWACODE_DATA_DIR: dataRoot,
    AWACODE_BASE_URL: baseUrl,
    AWACODE_MODEL: "fixture-model",
    AWACODE_API_KEY: FIXTURE_KEY,
    AWACODE_CONTEXT_LIMIT: "32768",
    AWACODE_MAX_OUTPUT_TOKENS: "4096",
    AWACODE_NODE_PATH: NODE24,
  };
}

function commandForDemoTest(): string {
  if (process.platform === "win32") {
    return `& '${NODE24.replaceAll("'", "''")}' --test app.test.mjs`;
  }
  return `'${NODE24.replaceAll("'", "'\\''")}' --test app.test.mjs`;
}

function capture(child: ChildChannel): { stdout: Buffer[]; stderr: Buffer[] } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  return { stdout, stderr };
}

async function closeCore(channel: ChildChannel, rpc: StdioRpc): Promise<void> {
  channel.child.stdin.end();
  await withTimeout(Promise.all([channel.closed, rpc.done]), 5_000, "Core graceful close");
  await disposeChildChannel(channel, "Core child");
}

function toolResult(call: ToolCallRecord): { status?: unknown; metadata?: Record<string, unknown> } {
  return call.result as { status?: unknown; metadata?: Record<string, unknown> };
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("built CLI completes a read, failing test, approved edit, and passing test workflow", async () => {
  const dataRoot = await temporaryDirectory("workflow-data");
  const workspace = await temporaryDirectory("workflow-workspace");
  await writeFile(join(workspace, "app.mjs"), "export function total() { return 1; }\n", "utf8");
  await writeFile(join(workspace, "app.test.mjs"), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { total } from "./app.mjs";',
    'test("total is fixed", () => assert.equal(total(), 2));',
    "",
  ].join("\n"), "utf8");
  const command = commandForDemoTest();
  const server = await startScriptedOpenAI([
    textTurn("Plan: inspect the workspace, reproduce the failure, edit, and verify."),
    toolTurn("call-list", "list_files", { path: ".", max_depth: 2 }),
    toolTurn("call-read", "read_file", { path: "app.mjs" }),
    toolTurn("call-test-fail", "run_command", { command, cwd: ".", timeout_ms: 30_000 }),
    toolTurn("call-edit", "edit_file", {
      path: "app.mjs",
      old_text: "return 1;",
      new_text: "return 2;",
    }),
    toolTurn("call-test-pass", "run_command", { command, cwd: ".", timeout_ms: 30_000 }),
    textTurn("Fixed app.mjs and verified the test now passes."),
    textTurn('{"status":"complete","reason":"tests pass"}'),
  ]);
  const child = spawnChildChannel(NODE24, [
    CLI_ENTRY,
    "--workspace", workspace,
    "--prompt", "Fix the failing total test",
  ], { env: modelEnvironment(dataRoot, server.baseUrl), cwd: resolve(".") });
  const output = capture(child);
  let combined = "";
  let approvals = 0;
  const onOutput = (chunk: Buffer) => {
    combined += chunk.toString("utf8");
    const requested = combined.split("Decision (allow_once | deny): ").length - 1;
    while (approvals < requested) {
      approvals += 1;
      child.child.stdin.write("allow_once\n");
      if (approvals === 3) child.child.stdin.end();
    }
  };
  child.child.stdout.on("data", onOutput);

  try {
    const [code, signal] = await withTimeout(child.closed, 20_000, "Headless workflow CLI");
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(approvals, 3);
    assert.equal(await readFile(join(workspace, "app.mjs"), "utf8"), "export function total() { return 2; }\n");
    assert.equal(server.requests.length, 8);
    assert.ok(server.requests.every((request) => request.url === "/v1/chat/completions"));
    assert.ok(server.requests.every((request) => request.authorization === `Bearer ${FIXTURE_KEY}`));

    const stdout = Buffer.concat(output.stdout).toString("utf8");
    const stderr = Buffer.concat(output.stderr).toString("utf8");
    assert.match(stdout, /\[phase\] plan/);
    assert.match(stdout, /\[phase\] execute/);
    assert.match(stdout, /run_command failure: Command exited with a nonzero status\./);
    assert.match(stdout, /edit_file success: Edited 1 occurrence/);
    assert.match(stdout, /run_command success: Command completed successfully\./);
    assert.match(stdout, /Fixed app\.mjs and verified the test now passes\./);
    assert.match(stdout, /\[phase\] reflect/);
    assert.match(stdout, /\[commit\]/);
    assert.match(stdout, /\[result\] completed: tests pass/);
    assert.equal(stderr, "");

    const connection = await openDatabase({ env: { AWACODE_DATA_DIR: dataRoot } });
    try {
      const store = new SessionStore(connection.db);
      const sessionId = String((connection.db.prepare("SELECT id FROM sessions").get() as { id: string }).id);
      const loaded = store.loadSession(sessionId);
      assert.equal(loaded.session.status, "completed");
      assert.deepEqual(loaded.toolCalls.map((call) => [call.toolName, call.status]), [
        ["list_files", "success"],
        ["read_file", "success"],
        ["run_command", "failure"],
        ["edit_file", "success"],
        ["run_command", "success"],
      ]);
      assert.equal(toolResult(loaded.toolCalls[2]!).metadata?.exitCode === 0, false);
      assert.equal(toolResult(loaded.toolCalls[4]!).metadata?.exitCode, 0);
    } finally {
      connection.close();
    }
  } finally {
    child.child.stdout.off("data", onOutput);
    await disposeChildChannel(child, "Headless workflow CLI");
    await server.close();
  }
});

test("killed Core converges an awaiting approval call and resume remains display-only", async () => {
  const dataRoot = await temporaryDirectory("recovery-data");
  const workspace = await temporaryDirectory("recovery-workspace");
  await writeFile(join(workspace, "demo.txt"), "old\n", "utf8");
  const server = await startScriptedOpenAI([
    textTurn("Plan: update demo.txt."),
    toolTurn("call-crash-edit", "edit_file", {
      path: "demo.txt",
      old_text: "old",
      new_text: "new",
    }),
  ]);
  try {
  const env = modelEnvironment(dataRoot, server.baseUrl);
  const first = spawnChildChannel(NODE24, [CORE_ENTRY], { env, cwd: resolve(".") });
  const firstDiagnostics = new PassThrough();
  const firstRpc = new StdioRpc({
    stdin: first.child.stdout,
    stdout: first.child.stdin,
    stderr: firstDiagnostics,
    idPrefix: "test-first-",
  });
  let permissionEntered!: () => void;
  const entered = new Promise<void>((resolveEntered) => { permissionEntered = resolveEntered; });
  let releasePermission!: () => void;
  const released = new Promise<void>((resolveReleased) => { releasePermission = resolveReleased; });
  firstRpc.peer.register("permission/request", (value) => value as PermissionRequest, async () => {
    permissionEntered();
    await released;
    return "deny";
  });

  let sessionId = "";
  try {
    const selected = await firstRpc.peer.request("workspace/set", { workspace }) as { projectId: string };
    const session = await firstRpc.peer.request("session/create", { projectId: selected.projectId, title: "Crash" }) as { id: string };
    sessionId = session.id;
    const running = firstRpc.peer.request("agent/run", { sessionId, prompt: "Update demo.txt" });
    void running.catch(() => undefined);
    await withTimeout(entered, 10_000, "permission request before crash");
    first.child.kill("SIGKILL");
    await withTimeout(first.closed, 5_000, "killed Core close");
    releasePermission();
    await withTimeout(
      running.then(
        () => assert.fail("killed agent/run unexpectedly completed"),
        () => undefined,
      ),
      5_000,
      "killed Core request rejection",
    );
  } finally {
    releasePermission?.();
    await disposeChildChannel(first, "Killed Core");
  }

  assert.equal(await readFile(join(workspace, "demo.txt"), "utf8"), "old\n");
  assert.equal(server.requests.length, 2);

  const second = spawnChildChannel(NODE24, [CORE_ENTRY], { env, cwd: resolve(".") });
  const secondDiagnostics = new PassThrough();
  const secondRpc = new StdioRpc({
    stdin: second.child.stdout,
    stdout: second.child.stdin,
    stderr: secondDiagnostics,
    idPrefix: "test-second-",
  });
  try {
    const hello = await secondRpc.peer.request("core/hello", {}) as { interruptedCount: number };
    assert.equal(hello.interruptedCount, 1);
    const loaded = await secondRpc.peer.request("session/load", { sessionId }) as {
      session: { status: string };
      messages: Array<{ status: string }>;
      toolCalls: Array<{ status: string; result: { metadata?: Record<string, unknown> } }>;
    };
    assert.equal(loaded.session.status, "interrupted");
    assert.equal(loaded.messages.some((message) => message.status === "streaming"), false);
    assert.deepEqual(loaded.toolCalls.map((call) => [call.status, call.result.metadata?.recovery]), [
      ["interrupted", "not_started"],
    ]);
    assert.equal(server.requests.length, 2);
  } finally {
    await closeCore(second, secondRpc);
  }

  await server.close();
  const resume = spawnChildChannel(NODE24, [CLI_ENTRY, "--resume", sessionId], {
    env,
    cwd: resolve("."),
  });
  const resumeOutput = capture(resume);
  resume.child.stdin.end();
  try {
    const [code, signal] = await withTimeout(resume.closed, 8_000, "display-only resume CLI");
    assert.equal(code, 0);
    assert.equal(signal, null);
    const stdout = Buffer.concat(resumeOutput.stdout).toString("utf8");
    assert.match(stdout, new RegExp(`Session ${sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(stdout, /\[interrupted\]/);
    assert.match(stdout, /tool 1 edit_file \[interrupted\]/);
    assert.doesNotMatch(stdout, /\[phase\]|\[result\]|Decision \(allow_once/);
    assert.equal(Buffer.concat(resumeOutput.stderr).toString("utf8"), "");
    assert.equal(await readFile(join(workspace, "demo.txt"), "utf8"), "old\n");
  } finally {
    await disposeChildChannel(resume, "Display-only resume CLI");
  }
  } finally {
    await server.close();
  }
});
