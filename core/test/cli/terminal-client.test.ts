import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { PermissionRequest } from "../../src/tools/permission.ts";
import {
  cancelAgentRun,
  forwardCoreStderr,
  promptForPermission,
  runCliCommand,
  type CliRpcClient,
} from "../../src/cli/terminal-client.ts";

test("resume loads and displays a session without starting an agent run", async () => {
  const calls: Array<[string, unknown]> = [];
  const displayed: unknown[] = [];
  const client: CliRpcClient = {
    async request(method, params) {
      calls.push([method, params]);
      return {
        session: { id: "session-1", title: "Existing", status: "interrupted" },
        messages: [{ seq: 1, role: "user", kind: "text", status: "complete", payload: { text: "Earlier" } }],
        toolCalls: [],
      };
    },
  };

  const result = await runCliCommand({ kind: "resume", sessionId: "session-1" }, client, {
    displaySession: (loaded) => { displayed.push(loaded); },
  });

  assert.deepEqual(calls, [["session/load", { sessionId: "session-1" }]]);
  assert.equal(displayed.length, 1);
  assert.deepEqual(result, { kind: "resumed", sessionId: "session-1" });
});

test("new and continuing commands create only the required RPC resources before agent/run", async () => {
  const calls: Array<[string, unknown]> = [];
  const client: CliRpcClient = {
    async request(method, params) {
      calls.push([method, params]);
      if (method === "workspace/set") return { projectId: "project-1", workspace: "D:/demo" };
      if (method === "session/create") return { id: "session-new" };
      return { status: "completed", finalText: "done" };
    },
  };

  assert.deepEqual(await runCliCommand(
    { kind: "new", workspace: "D:/demo", prompt: "Fix" },
    client,
    { displaySession() {} },
  ), { status: "completed", finalText: "done" });
  assert.deepEqual(calls, [
    ["workspace/set", { workspace: "D:/demo" }],
    ["session/create", { projectId: "project-1", title: "Fix" }],
    ["agent/run", { sessionId: "session-new", prompt: "Fix" }],
  ]);

  calls.length = 0;
  await runCliCommand(
    { kind: "continue", sessionId: "session-existing", prompt: "Continue" },
    client,
    { displaySession() {} },
  );
  assert.deepEqual(calls, [["agent/run", { sessionId: "session-existing", prompt: "Continue" }]]);
});

test("permission prompting returns only an explicit allow_once or deny decision", async () => {
  const answers = ["yes", "ALLOW_ONCE", "allow_once"];
  const output: string[] = [];
  const request: PermissionRequest = {
    callId: "call-1",
    kind: "command",
    title: "Run shell command",
    preview: {
      command: "npm test",
      cwd: ".",
      timeoutMs: 60_000,
      warning: "This command runs with current-user permissions and may access paths outside the workspace.",
    },
  };
  assert.equal(await promptForPermission(request, {
    write: (text) => { output.push(text); },
    readLine: async () => answers.shift() ?? "deny",
  }), "allow_once");
  assert.equal(output.filter((text) => text.includes("allow_once | deny")).length, 3);

  assert.equal(await promptForPermission(request, {
    write() {},
    readLine: async () => "deny",
  }), "deny");
});

test("Core stderr is forwarded only to the CLI diagnostic stream", async () => {
  const coreStderr = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
  stderr.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));
  const detach = forwardCoreStderr(coreStderr, stderr);

  coreStderr.end("fixture diagnostic\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  detach();

  assert.equal(Buffer.concat(stdoutChunks).toString("utf8"), "");
  assert.equal(Buffer.concat(stderrChunks).toString("utf8"), "fixture diagnostic\n");
});

test("cancellation requests agent/cancel, waits boundedly, then terminates a stuck child", async () => {
  const events: string[] = [];
  let release!: () => void;
  const childExit = new Promise<void>((resolve) => { release = resolve; });
  await cancelAgentRun({
    requestCancel: async () => { events.push("cancel"); },
    childExit,
    terminateChild: () => { events.push("terminate"); release(); },
    wait: async () => false,
  });
  assert.deepEqual(events, ["cancel", "terminate"]);

  events.length = 0;
  await cancelAgentRun({
    requestCancel: async () => { events.push("cancel"); },
    childExit: Promise.resolve(),
    terminateChild: () => { events.push("terminate"); },
    wait: async (exited) => { await exited; return true; },
  });
  assert.deepEqual(events, ["cancel"]);
});

test("an unresponsive cancel RPC cannot prevent the bounded wait from terminating Core", { timeout: 500 }, async () => {
  const events: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  let rejectCancel!: (error: Error) => void;
  const cancelRequest = new Promise<never>((_resolve, reject) => { rejectCancel = reject; });
  let releaseExit!: () => void;
  const childExit = new Promise<void>((resolve) => { releaseExit = resolve; });
  try {
    await cancelAgentRun({
      requestCancel: () => {
        events.push("cancel");
        return cancelRequest;
      },
      childExit,
      wait: async () => {
        events.push("wait");
        return false;
      },
      terminateChild: () => {
        events.push("terminate");
        releaseExit();
      },
    });
    rejectCancel(new Error("late fixture cancellation rejection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["cancel", "wait", "terminate"]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
