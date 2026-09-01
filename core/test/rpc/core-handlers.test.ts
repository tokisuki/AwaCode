import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import test from "node:test";

import { ModelConfigService } from "../../src/config/model-config.ts";
import { MemoryStore } from "../../src/memory/memory-store.ts";
import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore } from "../../src/persistence/session-store.ts";
import { JsonRpcPeer } from "../../src/protocol/rpc-peer.ts";
import { RpcFault } from "../../src/protocol/json-rpc.ts";
import { registerCoreHandlers } from "../../src/rpc/core-handlers.ts";
import { ContextBudgetError, ContextCompressionError } from "../../src/context/context-manager.ts";
import { ModelRequestError, OpenAIChatClient } from "../../src/llm/openai-chat-client.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-rpc-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|OPENAI|ANTHROPIC|AZURE|AWS)/i.test(name))),
    GIT_TERMINAL_PROMPT: "0",
  };
}

function connectedPeers(): { client: JsonRpcPeer; server: JsonRpcPeer } {
  let client!: JsonRpcPeer;
  let server!: JsonRpcPeer;
  client = new JsonRpcPeer({ idPrefix: "ui-", send: (message) => server.receive(message) });
  server = new JsonRpcPeer({ idPrefix: "core-", send: (message) => client.receive(message) });
  return { client, server };
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("real JsonRpcPeer calls receive the literal results of core and memory handlers", async () => {
  const dataRoot = await temporaryDirectory("data");
  const workspace = await temporaryDirectory("workspace");
  const normalizedWorkspace = normalize(await realpath(workspace));
  const identityPath = process.platform === "win32" ? normalizedWorkspace.toLowerCase() : normalizedWorkspace;
  const projectId = createHash("sha256").update(`path:${identityPath}`).digest("hex");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: dataRoot } });
  const store = new SessionStore(connection.db, {
    now: () => new Date("2026-08-31T07:08:09.123Z"),
    randomUUID: () => "session-rpc-1",
  });
  const { client, server } = connectedPeers();
  const memoryStore = new MemoryStore({ env: { AWACODE_DATA_DIR: dataRoot } });
  registerCoreHandlers(server, {
    store,
    memoryStore,
    configService: new ModelConfigService({ env: { AWACODE_DATA_DIR: dataRoot } }),
    projectIdentityOptions: { env: cleanEnvironment() },
  });

  try {
    assert.deepEqual(await client.request("core/hello", {}), {
      coreVersion: "0.1.0",
      databaseVersion: 1,
      configured: false,
      model: null,
      interruptedCount: 0,
    });
    assert.deepEqual(await client.request("workspace/set", { workspace }), {
      workspace: normalizedWorkspace,
      projectId,
    });
    const created = {
      id: "session-rpc-1",
      projectId,
      title: "RPC session",
      model: null,
      status: "idle",
      createdAt: "2026-08-31T07:08:09.123Z",
      updatedAt: "2026-08-31T07:08:09.123Z",
    };
    assert.deepEqual(await client.request("session/create", { projectId, title: "RPC session" }), created);
    assert.deepEqual(await client.request("session/list", { projectId }), [created]);
    assert.deepEqual(await client.request("session/load", { sessionId: "session-rpc-1" }), {
      session: created,
      messages: [],
      toolCalls: [],
    });
    assert.deepEqual(await client.request("memory/read", { projectId }), { global: "", project: "" });
  } finally {
    client.close();
    server.close();
    connection.close();
  }
});

test("exact parameter validators reject missing, extra, and mistyped fields through the peer", async () => {
  const dataRoot = await temporaryDirectory("invalid-data");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: dataRoot } });
  const store = new SessionStore(connection.db);
  const { client, server } = connectedPeers();
  registerCoreHandlers(server, {
    store,
    memoryStore: new MemoryStore({ env: { AWACODE_DATA_DIR: dataRoot } }),
    configService: new ModelConfigService({ env: { AWACODE_DATA_DIR: dataRoot } }),
    projectIdentityOptions: { env: cleanEnvironment() },
  });

  try {
    const invalidCalls: Array<[string, unknown]> = [
      ["core/hello", undefined],
      ["core/hello", { extra: true }],
      ["workspace/set", { workspace: 7 }],
      ["session/list", { projectId: "missing", extra: true }],
      ["session/create", { projectId: "missing", title: null }],
      ["session/load", []],
      ["memory/read", { projectId: "missing", extra: true }],
    ];
    for (const [method, params] of invalidCalls) {
      await assert.rejects(
        params === undefined ? client.request(method) : client.request(method, params),
        (error: unknown) => error instanceof RpcFault && error.code === -32602 && error.message === "Invalid params",
      );
    }
  } finally {
    client.close();
    server.close();
    connection.close();
  }
});

test("missing workspaces, projects, and sessions become application not-found faults", async () => {
  const dataRoot = await temporaryDirectory("missing-data");
  const missingWorkspace = join(await temporaryDirectory("missing-parent"), "absent");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: dataRoot } });
  const store = new SessionStore(connection.db);
  const { client, server } = connectedPeers();
  registerCoreHandlers(server, {
    store,
    configService: new ModelConfigService({ env: { AWACODE_DATA_DIR: dataRoot } }),
    projectIdentityOptions: { env: cleanEnvironment() },
  });

  try {
    const calls: Array<[string, unknown, string, unknown]> = [
      ["workspace/set", { workspace: missingWorkspace }, "Workspace not found", { workspace: missingWorkspace }],
      ["session/list", { projectId: "missing-project" }, "Project not found", { projectId: "missing-project" }],
      ["session/create", { projectId: "missing-project" }, "Project not found", { projectId: "missing-project" }],
      ["session/load", { sessionId: "missing-session" }, "Session not found", { sessionId: "missing-session" }],
    ];
    for (const [method, params, message, data] of calls) {
      await assert.rejects(
        client.request(method, params),
        (error: unknown) =>
          error instanceof RpcFault
          && error.code === -32003
          && error.message === message
          && assert.deepEqual(error.data, data) === undefined,
      );
    }
  } finally {
    client.close();
    server.close();
    connection.close();
  }
});

test("context compression exhaustion becomes an explicit RPC error", async () => {
  const dataRoot = await temporaryDirectory("context-overflow-data");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: dataRoot } });
  const store = new SessionStore(connection.db);
  const { client, server } = connectedPeers();
  registerCoreHandlers(server, {
    store,
    configService: new ModelConfigService({ env: { AWACODE_DATA_DIR: dataRoot } }),
    agent: {
      async run() { throw new ContextCompressionError("context_overflow_after_compression"); },
      cancel() { return false; },
    },
  });
  try {
    await assert.rejects(client.request("agent/run", { sessionId: "session", prompt: "continue" }),
      (error: unknown) => error instanceof RpcFault
        && error.code === -32007
        && error.message.includes("context")
        && error.data !== undefined);
  } finally {
    client.close();
    server.close();
    connection.close();
  }
});

test("required context that cannot fit becomes the same explicit RPC boundary", async () => {
  const dataRoot = await temporaryDirectory("required-context-data");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: dataRoot } });
  const store = new SessionStore(connection.db);
  const { client, server } = connectedPeers();
  registerCoreHandlers(server, {
    store,
    configService: new ModelConfigService({ env: { AWACODE_DATA_DIR: dataRoot } }),
    agent: {
      async run() { throw new ContextBudgetError(); },
      cancel() { return false; },
    },
  });
  try {
    await assert.rejects(client.request("agent/run", { sessionId: "session", prompt: "continue" }),
      (error: unknown) => error instanceof RpcFault
        && error.code === -32007
        && (error.data as { reason?: unknown }).reason === "required_context_too_large");
  } finally {
    client.close();
    server.close();
    connection.close();
  }
});

test("model request failures cross RPC with a bounded safe diagnostic instead of Internal error", async () => {
  const dataRoot = await temporaryDirectory("model-request-error-data");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: dataRoot } });
  const store = new SessionStore(connection.db);
  const { client, server } = connectedPeers();
  registerCoreHandlers(server, {
    store,
    configService: new ModelConfigService({ env: { AWACODE_DATA_DIR: dataRoot } }),
    agent: {
      async run() {
        throw new ModelRequestError("request_failed", "Model request failed", {
          status: 400,
          error: { message: "reasoning_content must be passed back" },
        });
      },
      cancel() { return false; },
    },
  });
  try {
    await assert.rejects(client.request("agent/run", { sessionId: "session", prompt: "continue" }),
      (error: unknown) => error instanceof RpcFault
        && error.code === -32008
        && error.message === "Model request failed"
        && (error.data as { reason?: unknown }).reason === "request_failed"
        && (error.data as { detail?: unknown }).detail === "reasoning_content must be passed back");
  } finally {
    client.close();
    server.close();
    connection.close();
  }
});

test("real provider failures are redacted and bounded before crossing RPC", async () => {
  const activeKey = "fixture-active-super-secret-key";
  const longPrefix = "provider detail ".repeat(100);
  const providerServer = createServer((request, response) => {
    request.resume();
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: {
        message: `api_key=${activeKey} authorization=Bearer ${activeKey} ${longPrefix}`,
        details: { api_key: activeKey },
      },
    }));
  });
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  const address = providerServer.address();
  assert.ok(address !== null && typeof address !== "string");

  const dataRoot = await temporaryDirectory("real-model-request-error-data");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: dataRoot } });
  const store = new SessionStore(connection.db);
  const { client, server } = connectedPeers();
  const provider = new OpenAIChatClient({
    runnable: true,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "deepseek-v4-flash",
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
    apiKey: activeKey,
    sources: {
      baseUrl: "file",
      model: "file",
      contextLimit: "file",
      maxOutputTokens: "file",
      apiKey: "file",
    },
    issues: [],
  });
  registerCoreHandlers(server, {
    store,
    configService: new ModelConfigService({ env: { AWACODE_DATA_DIR: dataRoot } }),
    agent: {
      async run() {
        await provider.stream({ messages: [{ role: "user", content: "Trigger provider failure" }] });
        throw new Error("unreachable");
      },
      cancel() { return false; },
    },
  });
  try {
    await assert.rejects(client.request("agent/run", { sessionId: "session", prompt: "continue" }),
      (error: unknown) => {
        if (!(error instanceof RpcFault) || error.code !== -32008) return false;
        const detail = (error.data as { detail?: unknown }).detail;
        assert.equal(typeof detail, "string");
        assert.ok((detail as string).length <= 1_000);
        assert.equal((detail as string).includes(activeKey), false);
        assert.match(detail as string, /\[REDACTED\]/);
        return true;
      });
  } finally {
    client.close();
    server.close();
    connection.close();
    providerServer.close();
    await once(providerServer, "close");
  }
});
