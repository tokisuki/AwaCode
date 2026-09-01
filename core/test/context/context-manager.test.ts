import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ContextBudgetError,
  ContextCompressionError,
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

test("a persisted summary excludes covered entries while retaining the required current user at its cutoff", async () => {
  const { connection, store, session } = await fixture("summary-cutoff");
  try {
    store.saveContextSnapshot({
      sessionId: session.id,
      baseline: "baseline",
      sourceSnapshot: {},
      baselineSeq: 0,
      summary: "covered history",
      summaryUptoSeq: 2,
    });
    const manager = new ContextManager(store);
    const built = await manager.build({
      sessionId: session.id,
      history: [
        {
          type: "message",
          messageId: "covered-old",
          seq: 1,
          role: "user",
          kind: "text",
          payload: { text: "must not be repeated" },
        },
        {
          type: "message",
          messageId: "current-at-cutoff",
          seq: 2,
          role: "user",
          kind: "text",
          payload: { text: "required current" },
        },
        {
          type: "message",
          messageId: "after-summary",
          seq: 3,
          role: "assistant",
          kind: "text",
          payload: { text: "new answer" },
        },
      ],
      currentUserMessageId: "current-at-cutoff",
      systemText: "ignored new baseline",
      tools: [],
      contextLimit: 8_000,
      maxOutputTokens: 1_000,
    });

    assert.deepEqual(built.selectedMessageIds, ["current-at-cutoff", "after-summary"]);
    assert.deepEqual(built.messages, [
      { role: "system", content: "baseline" },
      { role: "system", content: "Conversation summary:\ncovered history" },
      { role: "user", content: "required current" },
      { role: "assistant", content: "new answer", toolCalls: [] },
    ]);
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

test("global memory precedes project memory so project instructions have priority", async () => {
  const { connection, store, session } = await fixture("memory-order");
  try {
    const manager = new ContextManager(store);
    const built = await manager.build({
      sessionId: session.id,
      history: [{
        type: "message",
        messageId: "current",
        seq: 1,
        role: "user",
        kind: "text",
        payload: { text: "continue" },
      }],
      currentUserMessageId: "current",
      systemText: "baseline",
      memory: { global: "Use tabs.", project: "Use spaces in this project." },
      tools: [],
      contextLimit: 8_000,
      maxOutputTokens: 1_000,
    });

    assert.deepEqual(built.messages.slice(0, 3), [
      { role: "system", content: "baseline" },
      { role: "system", content: "Global memory:\nUse tabs." },
      { role: "system", content: "Project memory (takes priority over global memory):\nUse spaces in this project." },
    ]);
  } finally {
    connection.close();
  }
});

test("rolling compression persists a replacement summary and never deletes SQLite messages", async () => {
  const { connection, store, session } = await fixture("rolling-summary");
  try {
    const old = store.insertMessage({ sessionId: session.id, role: "user", kind: "text", payload: { text: "x".repeat(12_000) } });
    const current = store.insertMessage({ sessionId: session.id, role: "user", kind: "text", payload: { text: "current request" } });
    const summaryRequests: Array<{ previousSummary: string | null; messages: readonly unknown[] }> = [];
    const manager = new ContextManager(store, {
      summaryGenerator: async (request) => {
        summaryRequests.push(request);
        return "Goal: retain the old requirement.\nNext: handle the current request.";
      },
    });
    const built = await manager.build({
      sessionId: session.id,
      history: [old, current].map((message) => ({
        type: "message" as const,
        messageId: message.id,
        seq: message.seq,
        role: message.role as "user",
        kind: message.kind,
        payload: message.payload,
      })),
      currentUserMessageId: current.id,
      systemText: "baseline",
      tools: [],
      contextLimit: 2_100,
      maxOutputTokens: 100,
    });

    assert.equal(summaryRequests.length, 1);
    assert.equal(summaryRequests[0]?.previousSummary, null);
    assert.equal(store.loadContextSnapshot(session.id)?.summaryUptoSeq, old.seq);
    assert.equal(store.loadContextSnapshot(session.id)?.summary, "Goal: retain the old requirement.\nNext: handle the current request.");
    assert.equal(store.loadSession(session.id).messages.length, 2);
    assert.deepEqual(built.selectedMessageIds, [current.id]);
    assert.ok(built.messages.some((message) => message.role === "system" && message.content.includes("retain the old requirement")));
  } finally {
    connection.close();
  }
});

test("rolling compression replaces the old summary, truncates tool output, and advances its cutoff", async () => {
  const { connection, store, session } = await fixture("rolling-replacement");
  try {
    store.saveContextSnapshot({
      sessionId: session.id,
      baseline: "baseline",
      sourceSnapshot: {},
      baselineSeq: 1,
      summary: "previous summary",
      summaryUptoSeq: 1,
    });
    let request: { previousSummary: string | null; messages: readonly { role: string; content: string | null }[] } | undefined;
    const manager = new ContextManager(store, {
      summaryGenerator: async (value) => {
        request = value as typeof request;
        return "replacement summary";
      },
    });
    await manager.build({
      sessionId: session.id,
      history: [
        {
          type: "assistant_tool_block",
          messageId: "old-tool",
          seq: 2,
          kind: "tool_calls",
          payload: { text: "old tool" },
          toolCalls: [{ callId: "call", ordinal: 0, toolName: "read_file", inputText: "{}" }],
          toolResults: [{
            callId: "call",
            ordinal: 0,
            status: "success",
            kind: "normal",
            result: { content: "z".repeat(20_000) },
            errorText: null,
          }],
        },
        { type: "message", messageId: "current", seq: 3, role: "user", kind: "text", payload: { text: "now" } },
      ],
      currentUserMessageId: "current",
      systemText: "ignored",
      tools: [],
      contextLimit: 2_100,
      maxOutputTokens: 100,
    });

    assert.equal(request?.previousSummary, "previous summary");
    const toolResult = request?.messages.find((message) => message.role === "tool");
    assert.ok(toolResult);
    assert.ok((toolResult.content?.length ?? 0) <= 2_000);
    assert.deepEqual(store.loadContextSnapshot(session.id)?.summaryUptoSeq, 2);
    assert.equal(store.loadContextSnapshot(session.id)?.summary, "replacement summary");
  } finally {
    connection.close();
  }
});

test("summary generation failure is explicit instead of silently dropping old history", async () => {
  const { connection, store, session } = await fixture("summary-failure");
  try {
    const manager = new ContextManager(store, {
      summaryGenerator: async () => { throw new Error("fixture summary failure"); },
    });
    await assert.rejects(manager.build({
      sessionId: session.id,
      history: [
        { type: "message", messageId: "old", seq: 1, role: "user", kind: "text", payload: { text: "x".repeat(12_000) } },
        { type: "message", messageId: "current", seq: 2, role: "user", kind: "text", payload: { text: "now" } },
      ],
      currentUserMessageId: "current",
      systemText: "baseline",
      tools: [],
      contextLimit: 2_100,
      maxOutputTokens: 100,
    }), (error: unknown) => error instanceof ContextCompressionError && error.code === "context_compression_failed");
    assert.equal(store.loadContextSnapshot(session.id)?.summary, null);
  } finally {
    connection.close();
  }
});

test("a temporary memory read failure preserves the last successful source snapshot", async () => {
  const { connection, store, session } = await fixture("memory-source-fallback");
  try {
    const manager = new ContextManager(store);
    const input = {
      sessionId: session.id,
      history: [{ type: "message" as const, messageId: "current", seq: 1, role: "user" as const, kind: "text", payload: { text: "next" } }],
      currentUserMessageId: "current",
      systemText: "baseline",
      tools: [],
      contextLimit: 8_000,
      maxOutputTokens: 1_000,
    };
    await manager.build({ ...input, memory: { global: "stable global", project: "stable project" } });
    const recovered = await manager.build({ ...input, memory: null });
    assert.deepEqual(recovered.messages.slice(1, 3), [
      { role: "system", content: "Global memory:\nstable global" },
      { role: "system", content: "Project memory (takes priority over global memory):\nstable project" },
    ]);
  } finally {
    connection.close();
  }
});
