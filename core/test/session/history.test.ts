import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore } from "../../src/persistence/session-store.ts";
import type { ProjectIdentity } from "../../src/project/project-identity.ts";
import {
  HistoryIntegrityError,
  prepareProviderHistory,
  validateProviderHistory,
} from "../../src/session/history.ts";
import { transitionToolCall } from "../../src/session/tool-call-state.ts";

const temporaryDirectories: string[] = [];

async function dataRoot(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-history-${label}-`));
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

test("provider history emits a valid multi-call block in order and excludes interrupted streaming audit messages", async () => {
  const root = await dataRoot("valid");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const ids = ["session-history", "user-message", "streaming-message", "assistant-message"];
  const store = new SessionStore(connection.db, {
    now: () => new Date("2026-09-01T04:00:00.000Z"),
    randomUUID: () => ids.shift() as string,
  });
  try {
    store.upsertProject(identity("project-history", "D:\\repo"));
    const session = store.createSession("project-history", "Provider history");
    store.insertMessage({
      sessionId: session.id,
      role: "user",
      kind: "text",
      payload: { text: "inspect files" },
    });
    store.insertMessage({
      sessionId: session.id,
      role: "assistant",
      kind: "text",
      payload: { text: "partial text that crashed" },
      status: "streaming",
    });
    store.insertAssistantMessageWithToolCalls({
      sessionId: session.id,
      payload: { text: "I inspected both files." },
      toolCalls: [
        { callId: "call-success", ordinal: 0, toolName: "read", inputText: "{\"path\":\"a.ts\"}" },
        { callId: "call-failure", ordinal: 1, toolName: "read", inputText: "{\"path\":\"missing.ts\"}" },
      ],
    });
    assert.equal(transitionToolCall(store, {
      callId: "call-success",
      expectedStatus: "pending",
      status: "running",
    }).kind, "applied");
    assert.equal(transitionToolCall(store, {
      callId: "call-success",
      expectedStatus: "running",
      status: "success",
      result: { content: "A" },
    }).kind, "applied");
    assert.equal(transitionToolCall(store, {
      callId: "call-failure",
      expectedStatus: "pending",
      status: "failure",
      result: { content: "not found" },
      errorText: "not found",
    }).kind, "applied");

    assert.deepEqual(prepareProviderHistory(store, session.id), [
      {
        type: "message",
        messageId: "user-message",
        seq: 1,
        role: "user",
        kind: "text",
        payload: { text: "inspect files" },
      },
      {
        type: "assistant_tool_block",
        messageId: "assistant-message",
        seq: 3,
        kind: "tool_calls",
        payload: { text: "I inspected both files." },
        toolCalls: [
          { callId: "call-success", ordinal: 0, toolName: "read", inputText: "{\"path\":\"a.ts\"}" },
          { callId: "call-failure", ordinal: 1, toolName: "read", inputText: "{\"path\":\"missing.ts\"}" },
        ],
        toolResults: [
          {
            callId: "call-success",
            ordinal: 0,
            status: "success",
            kind: "normal",
            result: { content: "A" },
            errorText: null,
          },
          {
            callId: "call-failure",
            ordinal: 1,
            status: "failure",
            kind: "error",
            result: { content: "not found" },
            errorText: "not found",
          },
        ],
      },
    ]);
    assert.equal(
      store.loadSession(session.id).messages.find(({ id }) => id === "streaming-message")?.status,
      "interrupted",
    );
  } finally {
    connection.close();
  }
});

test("provider history excludes a persisted rejected candidate after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "awacode-history-rejected-"));
  temporaryDirectories.push(directory);
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: directory } });
  const store = new SessionStore(connection.db, { randomUUID: (() => {
    const ids = ["rejected-session", "rejected-candidate", "accepted-candidate"];
    return () => ids.shift() as string;
  })() });
  try {
    store.upsertProject(identity("rejected-project", directory));
    const session = store.createSession("rejected-project", "Rejected candidate");
    store.insertMessage({ sessionId: session.id, role: "assistant", kind: "text", payload: { text: "old", candidateStatus: "rejected" } });
    store.insertMessage({ sessionId: session.id, role: "assistant", kind: "text", payload: { text: "new", candidateStatus: "accepted" } });
    assert.deepEqual(validateProviderHistory(store, session.id).map((entry) => entry.messageId), ["accepted-candidate"]);
  } finally { connection.close(); }
});

async function validHistoryFixture(label: string) {
  const root = await dataRoot(label);
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const ids = [`session-${label}`, `user-${label}`, `assistant-${label}`];
  const store = new SessionStore(connection.db, { randomUUID: () => ids.shift() as string });
  store.upsertProject(identity(`project-${label}`, "D:\\repo"));
  const session = store.createSession(`project-${label}`, "Corrupt history fixture");
  const user = store.insertMessage({
    sessionId: session.id,
    role: "user",
    kind: "text",
    payload: { text: "run" },
  });
  const block = store.insertAssistantMessageWithToolCalls({
    sessionId: session.id,
    payload: { text: "done" },
    toolCalls: [{ callId: `call-${label}`, ordinal: 0, toolName: "read", inputText: "{}" }],
  });
  assert.equal(transitionToolCall(store, {
    callId: `call-${label}`,
    expectedStatus: "pending",
    status: "failure",
    result: { content: "fixture failure" },
  }).kind, "applied");
  return { connection, store, session, user, block, callId: `call-${label}` };
}

function assertIntegrityFailure(operation: () => unknown, detailPattern?: RegExp): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof HistoryIntegrityError);
    assert.equal(error.code, "history_integrity_error");
    if (detailPattern !== undefined) {
      assert.match(error.message, detailPattern);
    }
    return true;
  });
}

test("history validation rejects every representable persisted integrity violation with a stable typed error", async (t) => {
  const cases: ReadonlyArray<{
    name: string;
    mutate(fixture: Awaited<ReturnType<typeof validHistoryFixture>>): void;
  }> = [
    {
      name: "missing SQL result",
      mutate: ({ connection, callId }) => {
        connection.db.prepare("UPDATE tool_calls SET result_json = NULL WHERE call_id = ?").run(callId);
      },
    },
    {
      name: "JSON null result",
      mutate: ({ connection, callId }) => {
        connection.db.prepare("UPDATE tool_calls SET result_json = 'null' WHERE call_id = ?").run(callId);
      },
    },
    {
      name: "nonterminal call",
      mutate: ({ connection, callId }) => {
        connection.db.prepare("UPDATE tool_calls SET status = 'running' WHERE call_id = ?").run(callId);
      },
    },
    {
      name: "call attached to a user message",
      mutate: ({ connection, callId, user }) => {
        connection.db.prepare("UPDATE tool_calls SET assistant_message_id = ? WHERE call_id = ?").run(user.id, callId);
      },
    },
    {
      name: "call session differs from its assistant session",
      mutate: ({ connection, session, callId }) => {
        connection.db.prepare(`
          INSERT INTO sessions (id, project_id, title, model_json, status, created_at, updated_at)
          SELECT 'other-session', project_id, 'Other', NULL, 'idle', created_at, updated_at
          FROM sessions WHERE id = ?
        `).run(session.id);
        connection.db.prepare(`
          INSERT INTO messages (id, session_id, seq, role, kind, payload_json, status, created_at, updated_at)
          VALUES ('other-assistant', 'other-session', 1, 'assistant', 'tool_calls', '{}', 'complete', 'created', 'updated')
        `).run();
        connection.db.prepare("UPDATE tool_calls SET assistant_message_id = 'other-assistant' WHERE call_id = ?").run(callId);
      },
    },
    {
      name: "malformed message payload",
      mutate: ({ connection, block }) => {
        connection.db.prepare("UPDATE messages SET payload_json = '{bad' WHERE id = ?").run(block.message.id);
      },
    },
    {
      name: "malformed terminal result payload",
      mutate: ({ connection, callId }) => {
        connection.db.prepare("UPDATE tool_calls SET result_json = '{bad' WHERE call_id = ?").run(callId);
      },
    },
    {
      name: "orphan tool-result message",
      mutate: ({ connection, session }) => {
        connection.db.prepare(`
          INSERT INTO messages (id, session_id, seq, role, kind, payload_json, status, created_at, updated_at)
          VALUES ('orphan-result', ?, 3, 'tool', 'result', '{"callId":"missing"}', 'complete', 'created', 'updated')
        `).run(session.id);
      },
    },
    {
      name: "duplicate tool-result message",
      mutate: ({ connection, session, callId }) => {
        connection.db.prepare(`
          INSERT INTO messages (id, session_id, seq, role, kind, payload_json, status, created_at, updated_at)
          VALUES ('duplicate-result', ?, 3, 'tool', 'result', ?, 'complete', 'created', 'updated')
        `).run(session.id, JSON.stringify({ callId }));
      },
    },
  ];

  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async () => {
      const fixture = await validHistoryFixture(`invalid-${index}`);
      try {
        item.mutate(fixture);
        assertIntegrityFailure(() => validateProviderHistory(fixture.store, fixture.session.id));
      } finally {
        fixture.connection.close();
      }
    });
  }
});

test("history validates every attached call before filtering non-complete audit messages", async (t) => {
  const cases: ReadonlyArray<{
    name: string;
    detail: RegExp;
    mutate(fixture: Awaited<ReturnType<typeof validHistoryFixture>>): void;
  }> = [
    {
      name: "interrupted assistant with a nonterminal call",
      detail: /nonterminal/,
      mutate: ({ connection, block, callId }) => {
        connection.db.prepare("UPDATE messages SET status = 'interrupted' WHERE id = ?").run(block.message.id);
        connection.db.prepare(`
          UPDATE tool_calls
          SET status = 'running', result_json = NULL, finished_at = NULL
          WHERE call_id = ?
        `).run(callId);
      },
    },
    {
      name: "streaming assistant with a null terminal result",
      detail: /no terminal result/,
      mutate: ({ connection, block, callId }) => {
        connection.db.prepare("UPDATE messages SET status = 'streaming' WHERE id = ?").run(block.message.id);
        connection.db.prepare("UPDATE tool_calls SET result_json = NULL WHERE call_id = ?").run(callId);
      },
    },
    {
      name: "interrupted assistant with a mismatched call session",
      detail: /wrong session or assistant/,
      mutate: ({ connection, session, block, callId }) => {
        connection.db.prepare(`
          INSERT INTO sessions (id, project_id, title, model_json, status, created_at, updated_at)
          SELECT 'filtered-other-session', project_id, 'Other', NULL, 'idle', created_at, updated_at
          FROM sessions WHERE id = ?
        `).run(session.id);
        connection.db.prepare("UPDATE messages SET status = 'interrupted' WHERE id = ?").run(block.message.id);
        connection.db.prepare("UPDATE tool_calls SET session_id = 'filtered-other-session' WHERE call_id = ?").run(callId);
      },
    },
    {
      name: "interrupted assistant with a negative ordinal",
      detail: /non-contiguous or duplicate ordinal/,
      mutate: ({ connection, block, callId }) => {
        connection.db.prepare("UPDATE messages SET status = 'interrupted' WHERE id = ?").run(block.message.id);
        connection.db.prepare("UPDATE tool_calls SET ordinal = -1 WHERE call_id = ?").run(callId);
      },
    },
    {
      name: "interrupted assistant with the wrong message kind",
      detail: /attached to assistant kind text/,
      mutate: ({ connection, block }) => {
        connection.db.prepare("UPDATE messages SET status = 'interrupted', kind = 'text' WHERE id = ?")
          .run(block.message.id);
      },
    },
    {
      name: "interrupted assistant with an otherwise valid call",
      detail: /non-complete assistant message/,
      mutate: ({ connection, block }) => {
        connection.db.prepare("UPDATE messages SET status = 'interrupted' WHERE id = ?").run(block.message.id);
      },
    },
  ];

  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async () => {
      const fixture = await validHistoryFixture(`filtered-invalid-${index}`);
      try {
        item.mutate(fixture);
        assertIntegrityFailure(() => validateProviderHistory(fixture.store, fixture.session.id), item.detail);
      } finally {
        fixture.connection.close();
      }
    });
  }
});

test("history rejects lossy terminal JSON before filtering complete or interrupted parents", async (t) => {
  const cases = [
    { name: "complete parent with top-level Infinity", parentStatus: "complete", resultJson: "1e400" },
    { name: "complete parent with top-level negative zero", parentStatus: "complete", resultJson: "-0" },
    {
      name: "interrupted parent with nested Infinity",
      parentStatus: "interrupted",
      resultJson: '{"nested":1e400}',
    },
    {
      name: "interrupted parent with nested negative zero",
      parentStatus: "interrupted",
      resultJson: '{"nested":-0}',
    },
  ] as const;

  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async () => {
      const fixture = await validHistoryFixture(`lossy-result-${index}`);
      try {
        fixture.connection.db.prepare("UPDATE messages SET status = ? WHERE id = ?")
          .run(item.parentStatus, fixture.block.message.id);
        fixture.connection.db.prepare("UPDATE tool_calls SET result_json = ? WHERE call_id = ?")
          .run(item.resultJson, fixture.callId);
        assertIntegrityFailure(
          () => validateProviderHistory(fixture.store, fixture.session.id),
          /strict JSON result/,
        );
      } finally {
        fixture.connection.close();
      }
    });
  }
});
