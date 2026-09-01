import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ContextBudgetError,
  ContextManager,
  estimateTextTokens,
  recentContextBudget,
} from "../../src/context/context-manager.ts";
import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore } from "../../src/persistence/session-store.ts";
import type { ProviderHistoryEntry } from "../../src/session/history.ts";

const temporaryDirectories: string[] = [];

async function fixture(label: string) {
  const directory = await mkdtemp(join(tmpdir(), `awacode-context-${label}-`));
  temporaryDirectories.push(directory);
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: directory } });
  const store = new SessionStore(connection.db, {
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    randomUUID: (() => {
      let next = 0;
      return () => `context-id-${++next}`;
    })(),
  });
  store.upsertProject({
    id: "project-context",
    kind: "path",
    value: directory,
    rootPath: directory,
  });
  const session = store.createSession("project-context", label);
  return { connection, store, session };
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("token estimation and recent budget follow the documented conservative arithmetic", () => {
  assert.equal(estimateTextTokens("abcd中🙂"), 3);
  assert.equal(recentContextBudget(32_768, 4_096), 7_168);
  assert.equal(recentContextBudget(8_192, 4_096), 2_000);
  assert.equal(recentContextBudget(100_000, 10_000), 15_000);
});

test("context selection keeps newest whole tool blocks and the current user message in chronological order", async () => {
  const { connection, store, session } = await fixture("blocks");
  try {
    const history: ProviderHistoryEntry[] = [
      {
        type: "message",
        messageId: "old-user",
        seq: 1,
        role: "user",
        kind: "text",
        payload: { text: "x".repeat(10_000) },
      },
      {
        type: "assistant_tool_block",
        messageId: "tool-block",
        seq: 2,
        kind: "tool_calls",
        payload: { text: "inspect" },
        toolCalls: [{ callId: "call-1", ordinal: 0, toolName: "read_file", inputText: "{\"path\":\"a.ts\"}" }],
        toolResults: [{
          callId: "call-1",
          ordinal: 0,
          status: "success",
          kind: "normal",
          result: { status: "success", content: "ok" },
          errorText: null,
        }],
      },
      {
        type: "message",
        messageId: "current-user",
        seq: 3,
        role: "user",
        kind: "text",
        payload: { text: "现在修复" },
      },
    ];
    const manager = new ContextManager(store);
    const built = await manager.build({
      sessionId: session.id,
      history,
      currentUserMessageId: "current-user",
      systemText: "system",
      tools: [],
      contextLimit: 2_100,
      maxOutputTokens: 100,
    });

    assert.deepEqual(built.messages, [
      { role: "system", content: "system" },
      { role: "assistant", content: "inspect", toolCalls: [{ id: "call-1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" }] },
      { role: "tool", toolCallId: "call-1", content: "{\"status\":\"success\",\"content\":\"ok\"}" },
      { role: "user", content: "现在修复" },
    ]);
    assert.equal(built.selectedMessageIds.includes("old-user"), false);
    assert.deepEqual(built.selectedMessageIds, ["tool-block", "current-user"]);
  } finally {
    connection.close();
  }
});

test("context snapshots preserve summaries and refresh named source hooks without generating a summary", async () => {
  const { connection, store, session } = await fixture("snapshot");
  try {
    store.saveContextSnapshot({
      sessionId: session.id,
      baseline: "persisted baseline",
      sourceSnapshot: { project: "old" },
      baselineSeq: 1,
      summary: "earlier work",
      summaryUptoSeq: 4,
    });
    const manager = new ContextManager(store, {
      sourceSnapshotHooks: [{ name: "project", read: () => ({ revision: 2 }) }],
    });
    const history: ProviderHistoryEntry[] = [{
      type: "message",
      messageId: "current",
      seq: 5,
      role: "user",
      kind: "text",
      payload: { text: "next" },
    }];

    const built = await manager.build({
      sessionId: session.id,
      history,
      currentUserMessageId: "current",
      systemText: "new baseline is ignored",
      tools: [],
      contextLimit: 8_000,
      maxOutputTokens: 1_000,
    });

    assert.deepEqual(built.messages.slice(0, 2), [
      { role: "system", content: "persisted baseline" },
      { role: "system", content: "Conversation summary:\nearlier work" },
    ]);
    assert.deepEqual(store.loadContextSnapshot(session.id), {
      sessionId: session.id,
      baseline: "persisted baseline",
      sourceSnapshot: { project: { revision: 2 } },
      baselineSeq: 1,
      summary: "earlier work",
      summaryUptoSeq: 4,
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
  } finally {
    connection.close();
  }
});

test("context construction fails clearly when the required current user message cannot fit", async () => {
  const { connection, store, session } = await fixture("over-budget");
  try {
    const manager = new ContextManager(store);
    await assert.rejects(manager.build({
      sessionId: session.id,
      history: [{
        type: "message",
        messageId: "current",
        seq: 1,
        role: "user",
        kind: "text",
        payload: { text: "z".repeat(20_000) },
      }],
      currentUserMessageId: "current",
      systemText: "system",
      tools: [],
      contextLimit: 4_096,
      maxOutputTokens: 4_000,
    }), (error: unknown) => error instanceof ContextBudgetError && error.code === "required_context_too_large");
  } finally {
    connection.close();
  }
});

test("transient phase instructions count against the same context budget as baseline system text", async () => {
  const { connection, store, session } = await fixture("phase-over-budget");
  try {
    const manager = new ContextManager(store);
    await assert.rejects(manager.build({
      sessionId: session.id,
      history: [{
        type: "message",
        messageId: "current",
        seq: 1,
        role: "user",
        kind: "text",
        payload: { text: "a" },
      }],
      currentUserMessageId: "current",
      systemText: "system",
      transientSystemText: "x".repeat(1_000),
      tools: [],
      contextLimit: 4_096,
      maxOutputTokens: 4_000,
    }), ContextBudgetError);
  } finally {
    connection.close();
  }
});
