import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase, type DatabaseConnection } from "../../src/persistence/database.ts";
import {
  SessionStore,
  StoreNotFoundError,
} from "../../src/persistence/session-store.ts";
import {
  disposeChildChannels,
  spawnChildChannel,
  waitForChildExit,
} from "../support/child-process.ts";
import type { ProjectIdentity } from "../../src/project/project-identity.ts";

const temporaryDirectories: string[] = [];

async function dataRoot(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-store-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function connections(label: string): Promise<[DatabaseConnection, DatabaseConnection]> {
  const root = await dataRoot(label);
  const first = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const second = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  return [first, second];
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

test("revisiting one project identity updates its current path without replacing creation metadata", async () => {
  const root = await dataRoot("project");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  let now = "2026-08-31T03:00:00.000Z";
  const store = new SessionStore(connection.db, { now: () => new Date(now) });
  try {
    const created = store.upsertProject(identity("project-1", "D:\\clone-one"));
    now = "2026-08-31T04:00:00.000Z";
    const revisited = store.upsertProject(identity("project-1", "D:\\clone-two"));

    assert.deepEqual(created, {
      id: "project-1",
      identityKind: "remote",
      identityValue: "github.com/openai/awacode",
      remote: "github.com/openai/awacode",
      rootPath: "D:\\clone-one",
      createdAt: "2026-08-31T03:00:00.000Z",
      updatedAt: "2026-08-31T03:00:00.000Z",
    });
    assert.deepEqual(revisited, {
      ...created,
      rootPath: "D:\\clone-two",
      updatedAt: "2026-08-31T04:00:00.000Z",
    });
    assert.equal(connection.db.prepare("SELECT COUNT(*) AS count FROM projects").get()?.count, 1);
  } finally {
    connection.close();
  }
});

test("creates sessions for existing projects and lists newest updates first", async () => {
  const root = await dataRoot("sessions");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  let now = "2026-08-31T05:00:00.000Z";
  const ids = ["session-old", "session-new"];
  const store = new SessionStore(connection.db, {
    now: () => new Date(now),
    randomUUID: () => ids.shift() as string,
  });
  try {
    store.upsertProject(identity("project-1", "D:\\repo"));
    const first = store.createSession("project-1");
    now = "2026-08-31T06:00:00.000Z";
    const second = store.createSession("project-1", "Investigate persistence");

    assert.deepEqual(first, {
      id: "session-old",
      projectId: "project-1",
      title: "New session",
      model: null,
      status: "idle",
      createdAt: "2026-08-31T05:00:00.000Z",
      updatedAt: "2026-08-31T05:00:00.000Z",
    });
    assert.deepEqual(store.listSessions("project-1"), [second, first]);
    assert.throws(() => store.createSession("missing"), StoreNotFoundError);
    assert.throws(() => store.listSessions("missing"), StoreNotFoundError);
  } finally {
    connection.close();
  }
});

test("loads messages and tool calls in protocol order after two stores allocate unique sequences", async () => {
  const [firstConnection, secondConnection] = await connections("load");
  const firstIds = ["session-1", "message-1", "message-3"];
  const secondIds = ["message-2"];
  const first = new SessionStore(firstConnection.db, { randomUUID: () => firstIds.shift() as string });
  const second = new SessionStore(secondConnection.db, { randomUUID: () => secondIds.shift() as string });
  try {
    first.upsertProject(identity("project-1", "D:\\repo"));
    const session = first.createSession("project-1", "Ordered history");
    const message1 = first.insertMessage({
      sessionId: session.id,
      role: "assistant",
      kind: "text",
      payload: { text: "first" },
    });
    const message2 = second.insertMessage({
      sessionId: session.id,
      role: "user",
      kind: "text",
      payload: { text: "second" },
    });
    const message3 = first.insertMessage({
      sessionId: session.id,
      role: "assistant",
      kind: "tool_calls",
      payload: { text: "third" },
      status: "complete",
    });

    second.insertToolCall({
      callId: "call-late",
      sessionId: session.id,
      assistantMessageId: message3.id,
      ordinal: 0,
      toolName: "shell",
      inputText: "{\"command\":\"npm test\"}",
      status: "pending",
    });
    first.insertToolCall({
      callId: "call-second",
      sessionId: session.id,
      assistantMessageId: message1.id,
      ordinal: 1,
      toolName: "read",
      inputText: "{\"path\":\"b.ts\"}",
      status: "success",
      result: { text: "B" },
    });
    first.insertToolCall({
      callId: "call-first",
      sessionId: session.id,
      assistantMessageId: message1.id,
      ordinal: 0,
      toolName: "read",
      inputText: "{\"path\":\"a.ts\"}",
      status: "failure",
      result: { error: "not found" },
      errorText: "not found",
    });

    const loaded = second.loadSession(session.id);
    assert.deepEqual(loaded.messages.map(({ id, seq, status, payload }) => ({ id, seq, status, payload })), [
      { id: "message-1", seq: 1, status: "complete", payload: { text: "first" } },
      { id: "message-2", seq: 2, status: "complete", payload: { text: "second" } },
      { id: "message-3", seq: 3, status: "complete", payload: { text: "third" } },
    ]);
    assert.deepEqual(loaded.toolCalls.map(({ callId, assistantMessageId, ordinal, result, errorText }) => ({
      callId,
      assistantMessageId,
      ordinal,
      result,
      errorText,
    })), [
      {
        callId: "call-first", assistantMessageId: "message-1", ordinal: 0,
        result: { error: "not found" }, errorText: "not found",
      },
      {
        callId: "call-second", assistantMessageId: "message-1", ordinal: 1, result: { text: "B" }, errorText: null,
      },
      {
        callId: "call-late", assistantMessageId: "message-3", ordinal: 0, result: null, errorText: null,
      },
    ]);
    assert.throws(() => second.loadSession("missing"), StoreNotFoundError);

    assert.throws(() => second.insertToolCall({
      callId: "different-call",
      sessionId: session.id,
      assistantMessageId: message1.id,
      ordinal: 0,
      toolName: "write",
      inputText: "{}",
    }), /UNIQUE constraint failed/);
    assert.throws(() => second.insertToolCall({
      callId: "call-first",
      sessionId: session.id,
      assistantMessageId: message3.id,
      ordinal: 1,
      toolName: "write",
      inputText: "{}",
    }), /UNIQUE constraint failed/);

    assert.deepEqual([message1.seq, message2.seq, message3.seq], [1, 2, 3]);
  } finally {
    secondConnection.close();
    firstConnection.close();
  }
});

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|OPENAI|ANTHROPIC|AZURE|AWS)/i.test(name)));
}

test("two store processes released together allocate distinct message sequences", async () => {
  const root = await dataRoot("message-race");
  const setupConnection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const setup = new SessionStore(setupConnection.db, { randomUUID: () => "session-race" });
  setup.upsertProject(identity("project-race", "D:\\race"));
  setup.createSession("project-race");
  setupConnection.close();

  const fixture = join(import.meta.dirname, "..", "..", "test-fixtures", "message-insert-child.ts");
  const channels = ["left", "right"].map((marker) => {
    const channel = spawnChildChannel(process.execPath, [fixture, root, "session-race", marker], {
      env: cleanEnvironment(),
    });
    return { ...channel, ready: channel.lines.nextLine() };
  });
  try {
    assert.deepEqual(await Promise.all(channels.map((channel) => channel.ready)), ["READY", "READY"]);
    const results = channels.map((channel) => channel.lines.nextLine());
    for (const channel of channels) {
      channel.child.stdin.end("GO\n");
    }
    const inserted = (await Promise.all(results)).map((line) => JSON.parse(line) as { seq: number; marker: string });
    assert.deepEqual(inserted.map(({ seq }) => seq).sort(), [1, 2]);
    assert.deepEqual(inserted.map(({ marker }) => marker).sort(), ["left", "right"]);
    assert.deepEqual(
      (await Promise.all(channels.map((channel, index) =>
        waitForChildExit(channel, 5000, `message insert ${index} completion`)))).map(([code]) => code),
      [0, 0],
    );
  } finally {
    await disposeChildChannels(channels, "message-insert child cleanup");
  }

  const verifiedConnection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  try {
    const loaded = new SessionStore(verifiedConnection.db).loadSession("session-race");
    assert.deepEqual(loaded.messages.map(({ seq }) => seq), [1, 2]);
    assert.deepEqual(
      loaded.messages.map((message) => (message.payload as { marker: string }).marker).sort(),
      ["left", "right"],
    );
  } finally {
    verifiedConnection.close();
  }
});
