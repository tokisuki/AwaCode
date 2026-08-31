import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore } from "../../src/persistence/session-store.ts";
import type { ProjectIdentity } from "../../src/project/project-identity.ts";
import {
  NOT_STARTED_RECOVERY_RESULT,
  OUTCOME_UNKNOWN_RECOVERY_RESULT,
  recoverInterruptedState,
} from "../../src/session/recovery.ts";
import { transitionToolCall } from "../../src/session/tool-call-state.ts";
import {
  disposeChildChannel,
  spawnChildChannel,
  waitForChildExit,
} from "../support/child-process.ts";

const temporaryDirectories: string[] = [];

async function dataRoot(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-recovery-${label}-`));
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

test("startup recovery distinguishes calls that never began from running calls with unknown outcomes", async () => {
  const root = await dataRoot("differentiates");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const store = new SessionStore(connection.db, {
    now: () => new Date("2026-09-01T03:00:00.000Z"),
    randomUUID: () => "session-recovery",
  });
  try {
    store.upsertProject(identity("project-recovery", "D:\\repo"));
    const session = store.createSession("project-recovery", "Interrupted run");
    connection.db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    store.insertAssistantMessageWithToolCalls({
      sessionId: session.id,
      payload: { text: "working" },
      toolCalls: [
        { callId: "pending-call", ordinal: 0, toolName: "read", inputText: "{}" },
        { callId: "awaiting-call", ordinal: 1, toolName: "write", inputText: "{}" },
        { callId: "running-call", ordinal: 2, toolName: "shell", inputText: "{}" },
      ],
    });
    assert.equal(transitionToolCall(store, {
      callId: "awaiting-call",
      expectedStatus: "pending",
      status: "awaiting_approval",
    }).kind, "applied");
    assert.equal(transitionToolCall(store, {
      callId: "running-call",
      expectedStatus: "pending",
      status: "running",
    }).kind, "applied");

    const summary = recoverInterruptedState(store);
    assert.deepEqual(summary, {
      interruptedCount: 3,
      sessionsInterrupted: 1,
      messagesInterrupted: 0,
      notStartedCallsInterrupted: 2,
      outcomeUnknownCallsInterrupted: 1,
    });
    const recovered = store.loadSession(session.id);
    assert.deepEqual(
      recovered.toolCalls.map(({ callId, status, result }) => ({ callId, status, result })),
      [
        { callId: "pending-call", status: "interrupted", result: NOT_STARTED_RECOVERY_RESULT },
        { callId: "awaiting-call", status: "interrupted", result: NOT_STARTED_RECOVERY_RESULT },
        { callId: "running-call", status: "interrupted", result: OUTCOME_UNKNOWN_RECOVERY_RESULT },
      ],
    );
  } finally {
    connection.close();
  }
});

test("the public convergence boundary constructs the exact recovery results without caller data", async () => {
  const root = await dataRoot("trusted-boundary");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const ids = ["session-trusted-boundary", "message-trusted-boundary"];
  const store = new SessionStore(connection.db, {
    now: () => new Date("2026-09-01T03:30:00.000Z"),
    randomUUID: () => ids.shift() as string,
  });
  try {
    store.upsertProject(identity("project-trusted-boundary", "D:\\repo"));
    const session = store.createSession("project-trusted-boundary", "Trusted recovery boundary");
    store.insertAssistantMessageWithToolCalls({
      sessionId: session.id,
      payload: {},
      toolCalls: [
        { callId: "trusted-pending", ordinal: 0, toolName: "read", inputText: "{}" },
        { callId: "trusted-running", ordinal: 1, toolName: "shell", inputText: "{}" },
      ],
    });
    assert.equal(transitionToolCall(store, {
      callId: "trusted-running",
      expectedStatus: "pending",
      status: "running",
    }).kind, "applied");

    assert.deepEqual(store.convergeInterruptedState(), {
      interruptedCount: 2,
      sessionsInterrupted: 0,
      messagesInterrupted: 0,
      notStartedCallsInterrupted: 1,
      outcomeUnknownCallsInterrupted: 1,
    });
    assert.deepEqual(store.loadSession(session.id).toolCalls.map(({ callId, result, errorText }) => ({
      callId,
      result,
      errorText,
    })), [
      {
        callId: "trusted-pending",
        result: NOT_STARTED_RECOVERY_RESULT,
        errorText: "Tool execution never began; no local side effect occurred.",
      },
      {
        callId: "trusted-running",
        result: OUTCOME_UNKNOWN_RECOVERY_RESULT,
        errorText: "Durable outcome unknown; local side effects may have occurred. Inspect the workspace before retrying.",
      },
    ]);
  } finally {
    connection.close();
  }
});

test("mixed recovery preserves terminal bytes and remains idempotent after reopening the database", async () => {
  const root = await dataRoot("mixed-reopen");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const ids = ["session-mixed", "streaming-mixed", "assistant-mixed"];
  const store = new SessionStore(connection.db, {
    now: () => new Date("2026-09-01T06:00:00.000Z"),
    randomUUID: () => ids.shift() as string,
  });
  try {
    store.upsertProject(identity("project-mixed", "D:\\repo"));
    const session = store.createSession("project-mixed", "Mixed recovery");
    connection.db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    store.insertMessage({
      sessionId: session.id,
      role: "assistant",
      kind: "text",
      payload: { text: "partial" },
      status: "streaming",
    });
    store.insertAssistantMessageWithToolCalls({
      sessionId: session.id,
      payload: {},
      toolCalls: [
        { callId: "mixed-pending", ordinal: 0, toolName: "read", inputText: "{}" },
        { callId: "mixed-awaiting", ordinal: 1, toolName: "write", inputText: "{}" },
        { callId: "mixed-running", ordinal: 2, toolName: "shell", inputText: "{}" },
        { callId: "mixed-success", ordinal: 3, toolName: "read", inputText: "{}" },
        { callId: "mixed-failure", ordinal: 4, toolName: "read", inputText: "{}" },
        { callId: "mixed-denied", ordinal: 5, toolName: "write", inputText: "{}" },
        { callId: "mixed-interrupted", ordinal: 6, toolName: "shell", inputText: "{}" },
      ],
    });
    assert.equal(transitionToolCall(store, {
      callId: "mixed-awaiting", expectedStatus: "pending", status: "awaiting_approval",
    }).kind, "applied");
    assert.equal(transitionToolCall(store, {
      callId: "mixed-running", expectedStatus: "pending", status: "running",
    }).kind, "applied");
    assert.equal(transitionToolCall(store, {
      callId: "mixed-success", expectedStatus: "pending", status: "running",
    }).kind, "applied");
    assert.equal(transitionToolCall(store, {
      callId: "mixed-success", expectedStatus: "running", status: "success", result: { kept: "success" },
    }).kind, "applied");
    assert.equal(transitionToolCall(store, {
      callId: "mixed-failure", expectedStatus: "pending", status: "failure", result: { kept: "failure" },
    }).kind, "applied");
    assert.equal(transitionToolCall(store, {
      callId: "mixed-denied", expectedStatus: "pending", status: "awaiting_approval",
    }).kind, "applied");
    assert.equal(transitionToolCall(store, {
      callId: "mixed-denied", expectedStatus: "awaiting_approval", status: "denied", result: { kept: "denied" },
    }).kind, "applied");
    assert.equal(transitionToolCall(store, {
      callId: "mixed-interrupted", expectedStatus: "pending", status: "interrupted", result: { kept: "interrupted" },
    }).kind, "applied");

    const terminalBytes = () => connection.db.prepare(`
      SELECT call_id, status, result_json, error_text, started_at, finished_at
      FROM tool_calls
      WHERE call_id IN ('mixed-success', 'mixed-failure', 'mixed-denied', 'mixed-interrupted')
      ORDER BY call_id
    `).all();
    const before = terminalBytes();
    assert.deepEqual(recoverInterruptedState(store), {
      interruptedCount: 3,
      sessionsInterrupted: 1,
      messagesInterrupted: 1,
      notStartedCallsInterrupted: 2,
      outcomeUnknownCallsInterrupted: 1,
    });
    assert.deepEqual(terminalBytes(), before);
    assert.deepEqual(recoverInterruptedState(store), {
      interruptedCount: 0,
      sessionsInterrupted: 0,
      messagesInterrupted: 0,
      notStartedCallsInterrupted: 0,
      outcomeUnknownCallsInterrupted: 0,
    });
    assert.deepEqual(terminalBytes(), before);
    assert.equal(store.loadSession(session.id).messages[0]?.status, "interrupted");
  } finally {
    connection.close();
  }

  const reopened = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  try {
    const reopenedStore = new SessionStore(reopened.db);
    assert.deepEqual(recoverInterruptedState(reopenedStore), {
      interruptedCount: 0,
      sessionsInterrupted: 0,
      messagesInterrupted: 0,
      notStartedCallsInterrupted: 0,
      outcomeUnknownCallsInterrupted: 0,
    });
    assert.deepEqual(
      reopenedStore.loadSession("session-mixed").toolCalls
        .filter(({ callId }) => ["mixed-success", "mixed-failure", "mixed-denied", "mixed-interrupted"].includes(callId))
        .map(({ callId, status, result }) => ({ callId, status, result })),
      [
        { callId: "mixed-success", status: "success", result: { kept: "success" } },
        { callId: "mixed-failure", status: "failure", result: { kept: "failure" } },
        { callId: "mixed-denied", status: "denied", result: { kept: "denied" } },
        { callId: "mixed-interrupted", status: "interrupted", result: { kept: "interrupted" } },
      ],
    );
  } finally {
    reopened.close();
  }
});

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|OPENAI|ANTHROPIC|AZURE|AWS)/i.test(name)));
}

test("a killed real child recovers a running call without replaying its marker side effect", async () => {
  const root = await dataRoot("real-crash");
  const markerPath = join(root, "tool-side-effect.txt");
  const fixture = join(import.meta.dirname, "..", "..", "test-fixtures", "running-tool-call-child.ts");
  const channel = spawnChildChannel(process.execPath, [fixture, root, markerPath], {
    env: cleanEnvironment(),
  });
  try {
    assert.equal(await channel.lines.nextLine(), "RUNNING");
    assert.equal(channel.child.kill("SIGKILL"), true);
    const [code, signal] = await waitForChildExit(channel, 5000, "running tool child termination");
    assert.ok(code !== 0 || signal !== null);
  } finally {
    await disposeChildChannel(channel, "running tool child cleanup");
  }

  const reopened = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  try {
    const store = new SessionStore(reopened.db, {
      now: () => new Date("2026-09-01T07:00:00.000Z"),
    });
    assert.deepEqual(recoverInterruptedState(store), {
      interruptedCount: 1,
      sessionsInterrupted: 1,
      messagesInterrupted: 0,
      notStartedCallsInterrupted: 0,
      outcomeUnknownCallsInterrupted: 1,
    });
    const recovered = store.loadSession("crash-session");
    assert.equal(recovered.toolCalls[0]?.status, "interrupted");
    assert.deepEqual(recovered.toolCalls[0]?.result, OUTCOME_UNKNOWN_RECOVERY_RESULT);
    assert.equal(recovered.session.status, "interrupted");
    await assert.rejects(readFile(markerPath, "utf8"), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    reopened.close();
  }
});
