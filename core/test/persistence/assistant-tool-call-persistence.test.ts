import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore } from "../../src/persistence/session-store.ts";
import type { ProjectIdentity } from "../../src/project/project-identity.ts";

const temporaryDirectories: string[] = [];

async function dataRoot(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-assistant-calls-${label}-`));
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

test("a completed assistant message and its ordered pending calls commit as one unit", async () => {
  const root = await dataRoot("success");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const store = new SessionStore(connection.db, {
    now: () => new Date("2026-09-01T02:00:00.000Z"),
    randomUUID: () => "assistant-message",
  });
  try {
    store.upsertProject(identity("project-atomic", "D:\\repo"));
    const session = store.createSession("project-atomic", "Atomic tool block");
    const inserted = store.insertAssistantMessageWithToolCalls({
      sessionId: session.id,
      kind: "tool_calls",
      payload: { text: "I will inspect both files." },
      toolCalls: [
        { callId: "call-a", ordinal: 0, toolName: "read", inputText: "{\"path\":\"a.ts\"}" },
        { callId: "call-b", ordinal: 1, toolName: "read", inputText: "{\"path\":\"b.ts\"}" },
      ],
    });

    assert.deepEqual(
      { id: inserted.message.id, role: inserted.message.role, status: inserted.message.status },
      { id: "assistant-message", role: "assistant", status: "complete" },
    );
    assert.deepEqual(
      inserted.toolCalls.map(({ callId, assistantMessageId, ordinal, status, result }) => ({
        callId,
        assistantMessageId,
        ordinal,
        status,
        result,
      })),
      [
        { callId: "call-a", assistantMessageId: "assistant-message", ordinal: 0, status: "pending", result: null },
        { callId: "call-b", assistantMessageId: "assistant-message", ordinal: 1, status: "pending", result: null },
      ],
    );
    assert.deepEqual(store.loadSession(session.id).messages.map(({ id }) => id), ["assistant-message"]);
  } finally {
    connection.close();
  }
});

test("a duplicate call ID or ordinal rolls back the assistant message and every call", async () => {
  const root = await dataRoot("rollback");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const ids = ["session-rollback", "message-duplicate-call", "message-duplicate-ordinal"];
  const store = new SessionStore(connection.db, { randomUUID: () => ids.shift() as string });
  try {
    store.upsertProject(identity("project-rollback", "D:\\repo"));
    const session = store.createSession("project-rollback", "Rollback tool blocks");
    assert.throws(() => store.insertAssistantMessageWithToolCalls({
      sessionId: session.id,
      kind: "tool_calls",
      payload: {},
      toolCalls: [
        { callId: "duplicate-call", ordinal: 0, toolName: "read", inputText: "{}" },
        { callId: "duplicate-call", ordinal: 1, toolName: "read", inputText: "{}" },
      ],
    }), /UNIQUE constraint failed/);
    assert.deepEqual(store.loadSession(session.id).messages, []);
    assert.deepEqual(store.loadSession(session.id).toolCalls, []);

    assert.throws(() => store.insertAssistantMessageWithToolCalls({
      sessionId: session.id,
      kind: "tool_calls",
      payload: {},
      toolCalls: [
        { callId: "ordinal-a", ordinal: 0, toolName: "read", inputText: "{}" },
        { callId: "ordinal-b", ordinal: 0, toolName: "read", inputText: "{}" },
      ],
    }), /ordinals must be unique and zero-based/);
    assert.deepEqual(store.loadSession(session.id).messages, []);
    assert.deepEqual(store.loadSession(session.id).toolCalls, []);
  } finally {
    connection.close();
  }
});

test("the ordinary streaming-message path cannot attach a runnable tool call", async () => {
  const root = await dataRoot("streaming-guard");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const ids = ["session-streaming", "message-streaming"];
  const store = new SessionStore(connection.db, { randomUUID: () => ids.shift() as string });
  try {
    store.upsertProject(identity("project-streaming", "D:\\repo"));
    const session = store.createSession("project-streaming", "Streaming guard");
    const message = store.insertMessage({
      sessionId: session.id,
      role: "assistant",
      kind: "tool_calls",
      payload: { text: "partial" },
      status: "streaming",
    });
    assert.throws(() => store.insertToolCall({
      callId: "streaming-call",
      sessionId: session.id,
      assistantMessageId: message.id,
      ordinal: 0,
      toolName: "write",
      inputText: "{}",
      status: "pending",
    }), /complete assistant message/);
    assert.deepEqual(store.loadSession(session.id).toolCalls, []);
  } finally {
    connection.close();
  }
});
