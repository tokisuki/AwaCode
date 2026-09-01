import assert from "node:assert/strict";
import test from "node:test";

import { formatCoreNotification, formatLoadedSession } from "../../src/cli/presentation.ts";

test("phase, stream, tool, and status notifications have compact terminal output", () => {
  assert.equal(formatCoreNotification("agent/phase", { phase: "execute" }), "\n[phase] execute\n");
  assert.equal(formatCoreNotification("stream/text", { delta: "working", provisional: true }), "working");
  assert.equal(formatCoreNotification("stream/commit", { messageId: "message-1" }), "\n[commit] message-1\n");
  assert.equal(formatCoreNotification("tool/start", { name: "read_file", ordinal: 0 }), "\n[tool 1] read_file started\n");
  assert.equal(formatCoreNotification("tool/end", {
    name: "read_file",
    ordinal: 0,
    status: "success",
    summary: "Read demo.txt",
  }), "[tool 1] read_file success: Read demo.txt\n");
  assert.equal(formatCoreNotification("agent/status", { status: "done", reason: "verified" }), "\n[status] done: verified\n");
});

test("loaded sessions show persisted messages and tool terminal states", () => {
  assert.equal(formatLoadedSession({
    session: { id: "session-1", title: "Demo", status: "interrupted" },
    messages: [{ seq: 1, role: "user", kind: "text", status: "complete", payload: { text: "Fix it" } }],
    toolCalls: [{ ordinal: 0, toolName: "run_command", status: "interrupted", result: { summary: "Recovered" } }],
  }), [
    "Session session-1 — Demo [interrupted]",
    "#1 user/text [complete]: Fix it",
    "tool 1 run_command [interrupted]: Recovered",
    "",
  ].join("\n"));
});
