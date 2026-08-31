import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore, type ToolCallStatus } from "../../src/persistence/session-store.ts";
import { transitionToolCall } from "../../src/session/tool-call-state.ts";
import type { ProjectIdentity } from "../../src/project/project-identity.ts";

const temporaryDirectories: string[] = [];

async function dataRoot(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-tool-state-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function identity(id: string, rootPath: string): ProjectIdentity {
  return {
    id,
    kind: "remote",
    value: "github.com/openai/awacode",
    remote: "github.com/openai/awacode",
    rootPath,
  };
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("the persisted tool-call state graph accepts every legal edge and rejects illegal edges", async () => {
  const root = await dataRoot("graph");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  let now = "2026-09-01T01:00:00.000Z";
  const ids = ["session-graph", ...Array.from({ length: 12 }, (_value, index) => `message-${index}`)];
  const store = new SessionStore(connection.db, {
    now: () => new Date(now),
    randomUUID: () => ids.shift() as string,
  });

  const createCall = (callId: string, status: ToolCallStatus = "pending") => {
    const message = store.insertMessage({
      sessionId: "session-graph",
      role: "assistant",
      kind: "tool_calls",
      payload: { callId },
    });
    store.insertToolCall({
      callId,
      sessionId: "session-graph",
      assistantMessageId: message.id,
      ordinal: 0,
      toolName: "read",
      inputText: "{}",
      status,
      ...(status === "success" || status === "failure" || status === "denied" || status === "interrupted"
        ? { result: { seeded: status }, finishedAt: now }
        : {}),
    });
  };

  try {
    store.upsertProject(identity("project-graph", "D:\\repo"));
    store.createSession("project-graph", "Transition graph");
    const legalPaths: ReadonlyArray<readonly ToolCallStatus[]> = [
      ["pending", "running", "success"],
      ["pending", "awaiting_approval", "running", "failure"],
      ["pending", "awaiting_approval", "denied"],
      ["pending", "failure"],
      ["pending", "interrupted"],
      ["pending", "awaiting_approval", "interrupted"],
      ["pending", "running", "interrupted"],
    ];

    for (const [index, path] of legalPaths.entries()) {
      const callId = `legal-${index}`;
      createCall(callId);
      for (let step = 1; step < path.length; step += 1) {
        const from = path[step - 1] as ToolCallStatus;
        const status = path[step] as ToolCallStatus;
        now = `2026-09-01T01:${String(index).padStart(2, "0")}:${String(step).padStart(2, "0")}.000Z`;
        const outcome = transitionToolCall(store, {
          callId,
          expectedStatus: from,
          status,
          ...(status === "success" || status === "failure" || status === "denied" || status === "interrupted"
            ? { result: { terminal: status } }
            : {}),
        });
        assert.equal(outcome.kind, "applied", `${from} -> ${status}`);
        assert.equal(outcome.call.status, status);
      }
    }

    createCall("illegal-running-denied", "running");
    const runningDenied = transitionToolCall(store, {
      callId: "illegal-running-denied",
      expectedStatus: "running",
      status: "denied",
      result: { terminal: "denied" },
    });
    assert.equal(runningDenied.kind, "conflict");
    assert.equal(runningDenied.reason, "illegal_transition");
    assert.equal(runningDenied.call.status, "running");

    for (const terminal of ["success", "failure", "denied", "interrupted"] as const) {
      const callId = `terminal-${terminal}`;
      createCall(callId, terminal);
      const outcome = transitionToolCall(store, {
        callId,
        expectedStatus: terminal,
        status: "running",
      });
      assert.equal(outcome.kind, "conflict");
      assert.equal(outcome.reason, "illegal_transition");
      assert.equal(outcome.call.status, terminal);
    }
  } finally {
    connection.close();
  }
});

test("terminal transitions require one result and never overwrite terminal data or timestamps", async () => {
  const root = await dataRoot("terminal");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  let now = "2026-09-01T05:00:00.000Z";
  const ids = ["session-terminal", "message-terminal"];
  const store = new SessionStore(connection.db, {
    now: () => new Date(now),
    randomUUID: () => ids.shift() as string,
  });
  try {
    store.upsertProject(identity("project-terminal", "D:\\repo"));
    const session = store.createSession("project-terminal", "Terminal invariants");
    const message = store.insertMessage({
      sessionId: session.id,
      role: "assistant",
      kind: "tool_calls",
      payload: {},
    });
    store.insertToolCall({
      callId: "call-terminal",
      sessionId: session.id,
      assistantMessageId: message.id,
      ordinal: 0,
      toolName: "shell",
      inputText: "{}",
    });

    assert.throws(() => transitionToolCall(store, {
      callId: "call-terminal",
      expectedStatus: "pending",
      status: "failure",
    }), /requires a non-null JSON result/);
    assert.equal(store.loadToolCall("call-terminal").status, "pending");

    now = "2026-09-01T05:01:00.000Z";
    assert.equal(transitionToolCall(store, {
      callId: "call-terminal",
      expectedStatus: "pending",
      status: "running",
    }).kind, "applied");
    now = "2026-09-01T05:02:00.000Z";
    assert.equal(transitionToolCall(store, {
      callId: "call-terminal",
      expectedStatus: "running",
      status: "success",
      result: { content: "original" },
      errorText: "  safe\u0000 error  ",
    }).kind, "applied");
    const terminal = store.loadToolCall("call-terminal");
    assert.deepEqual({
      status: terminal.status,
      result: terminal.result,
      errorText: terminal.errorText,
      startedAt: terminal.startedAt,
      finishedAt: terminal.finishedAt,
    }, {
      status: "success",
      result: { content: "original" },
      errorText: "safe error",
      startedAt: "2026-09-01T05:01:00.000Z",
      finishedAt: "2026-09-01T05:02:00.000Z",
    });

    now = "2026-09-01T05:03:00.000Z";
    const repeated = transitionToolCall(store, {
      callId: "call-terminal",
      expectedStatus: "running",
      status: "success",
      result: { content: "replacement" },
      errorText: "replacement error",
    });
    assert.equal(repeated.kind, "idempotent");
    assert.deepEqual(repeated.call, terminal);
  } finally {
    connection.close();
  }
});

test("allow loses cleanly to persisted deny or cancel decisions across two connections", async () => {
  const root = await dataRoot("race");
  const firstConnection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const secondConnection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const ids = ["session-race", "message-race"];
  const first = new SessionStore(firstConnection.db, { randomUUID: () => ids.shift() as string });
  const second = new SessionStore(secondConnection.db);
  try {
    first.upsertProject(identity("project-race", "D:\\repo"));
    const session = first.createSession("project-race", "Approval race");
    first.insertAssistantMessageWithToolCalls({
      sessionId: session.id,
      kind: "tool_calls",
      payload: {},
      toolCalls: [
        { callId: "deny-wins", ordinal: 0, toolName: "write", inputText: "{}" },
        { callId: "cancel-wins", ordinal: 1, toolName: "shell", inputText: "{}" },
        { callId: "allow-wins", ordinal: 2, toolName: "write", inputText: "{}" },
      ],
    });
    for (const callId of ["deny-wins", "cancel-wins", "allow-wins"]) {
      assert.equal(transitionToolCall(first, {
        callId,
        expectedStatus: "pending",
        status: "awaiting_approval",
      }).kind, "applied");
    }

    assert.equal(transitionToolCall(first, {
      callId: "deny-wins",
      expectedStatus: "awaiting_approval",
      status: "denied",
      result: { reason: "user denied" },
    }).kind, "applied");
    let actionsBegun = 0;
    const allowAfterDeny = transitionToolCall(second, {
      callId: "deny-wins",
      expectedStatus: "awaiting_approval",
      status: "running",
    });
    if (allowAfterDeny.kind === "applied") actionsBegun += 1;
    assert.equal(allowAfterDeny.kind, "conflict");
    assert.equal(allowAfterDeny.call.status, "denied");

    assert.equal(transitionToolCall(first, {
      callId: "cancel-wins",
      expectedStatus: "awaiting_approval",
      status: "interrupted",
      result: { reason: "cancelled" },
    }).kind, "applied");
    const allowAfterCancel = transitionToolCall(second, {
      callId: "cancel-wins",
      expectedStatus: "awaiting_approval",
      status: "running",
    });
    if (allowAfterCancel.kind === "applied") actionsBegun += 1;
    assert.equal(allowAfterCancel.kind, "conflict");
    assert.equal(allowAfterCancel.call.status, "interrupted");

    const allowFirst = transitionToolCall(first, {
      callId: "allow-wins",
      expectedStatus: "awaiting_approval",
      status: "running",
    });
    if (allowFirst.kind === "applied") actionsBegun += 1;
    const denyAfterAllow = transitionToolCall(second, {
      callId: "allow-wins",
      expectedStatus: "awaiting_approval",
      status: "denied",
      result: { reason: "late denial" },
    });
    assert.equal(denyAfterAllow.kind, "conflict");
    assert.equal(denyAfterAllow.call.status, "running");
    assert.equal(actionsBegun, 1);
  } finally {
    secondConnection.close();
    firstConnection.close();
  }
});
