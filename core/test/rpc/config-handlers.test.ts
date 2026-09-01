import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ModelConfigService } from "../../src/config/model-config.ts";
import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore } from "../../src/persistence/session-store.ts";
import { RpcFault } from "../../src/protocol/json-rpc.ts";
import { JsonRpcPeer } from "../../src/protocol/rpc-peer.ts";
import { StdioRpc } from "../../src/protocol/stdio-rpc.ts";
import { registerCoreHandlers } from "../../src/rpc/core-handlers.ts";

const temporaryDirectories: string[] = [];

async function dataRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `awacode-config-rpc-${label}-`));
  temporaryDirectories.push(root);
  return root;
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

test("config/status, config/save, and config/test return their exact public JSON-RPC results", async () => {
  const root = await dataRoot("results");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const configService = new ModelConfigService({
    env: { AWACODE_DATA_DIR: root },
    connectionTester: { async test() { return { message: "connection accepted" }; } },
  });
  const { client, server } = connectedPeers();
  registerCoreHandlers(server, { store: new SessionStore(connection.db), configService });

  try {
    assert.deepEqual(await client.request("config/status", {}), {
      runnable: false,
      baseUrl: null,
      model: null,
      contextLimit: 32768,
      maxOutputTokens: 4096,
      hasApiKey: false,
      sources: {
        baseUrl: "absent",
        model: "absent",
        contextLimit: "default",
        maxOutputTokens: "default",
        apiKey: "absent",
      },
      issues: [
        { code: "missing_base_url", field: "baseUrl" },
        { code: "missing_model", field: "model" },
        { code: "missing_api_key", field: "apiKey" },
      ],
    });
    const secret = "fixture-rpc-api-key";
    const saved = await client.request("config/save", {
      baseUrl: "https://rpc.example/v1",
      model: "rpc-model",
      contextLimit: 48000,
      maxOutputTokens: 4000,
      credential: { action: "store", apiKey: secret },
    });
    assert.deepEqual(saved, {
      runnable: true,
      baseUrl: "https://rpc.example/v1",
      model: "rpc-model",
      contextLimit: 48000,
      maxOutputTokens: 4000,
      hasApiKey: true,
      sources: {
        baseUrl: "file",
        model: "file",
        contextLimit: "file",
        maxOutputTokens: "file",
        apiKey: "file",
      },
      issues: [],
    });
    assert.equal(JSON.stringify(saved).includes(secret), false);
    assert.deepEqual(await client.request("config/test", {}), {
      ok: true,
      message: "connection accepted",
      model: "rpc-model",
    });
  } finally {
    client.close();
    server.close();
    connection.close();
  }
});

test("config handlers reject missing, extra, and mistyped params as invalid params", async () => {
  const root = await dataRoot("invalid");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const { client, server } = connectedPeers();
  registerCoreHandlers(server, {
    store: new SessionStore(connection.db),
    configService: new ModelConfigService({ env: { AWACODE_DATA_DIR: root } }),
  });
  const invalidCalls: Array<[string, unknown | undefined]> = [
    ["config/status", undefined],
    ["config/status", { extra: true }],
    ["config/test", undefined],
    ["config/test", { extra: true }],
    ["config/save", {}],
    ["config/save", {
      baseUrl: "https://rpc.example/v1",
      model: "rpc-model",
      contextLimit: 48000,
      maxOutputTokens: 4000,
      credential: { action: "keep" },
      extra: true,
    }],
    ["config/save", {
      baseUrl: "https://rpc.example/v1",
      model: "rpc-model",
      contextLimit: 48000,
      maxOutputTokens: 48000,
      credential: { action: "store", apiKey: "" },
    }],
  ];

  try {
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

test("config operational failures use stable sanitized application faults", async () => {
  const root = await dataRoot("faults");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const { client, server } = connectedPeers();
  registerCoreHandlers(server, {
    store: new SessionStore(connection.db),
    configService: new ModelConfigService({
      env: { AWACODE_DATA_DIR: root },
      connectionTester: { async test() { return {}; } },
      testHooks: { beforeRename() { throw new Error("fixture path and secret detail"); } },
    }),
  });

  try {
    await assert.rejects(client.request("config/test", {}), (error: unknown) =>
      error instanceof RpcFault
      && error.code === -32002
      && error.message === "Model configuration is not runnable"
      && error.data === undefined);
    await assert.rejects(client.request("config/save", {
      baseUrl: "https://rpc.example/v1",
      model: "rpc-model",
      contextLimit: 48000,
      maxOutputTokens: 4000,
      credential: { action: "keep" },
    }), (error: unknown) =>
      error instanceof RpcFault
      && error.code === -32006
      && error.message === "Model configuration operation failed"
      && error.data === undefined);
  } finally {
    client.close();
    server.close();
    connection.close();
  }
});

test("stdio config responses contain one protocol line and no diagnostic or secret output", async () => {
  const root = await dataRoot("stdio");
  const secret = "fixture-stdio-api-key";
  await writeFile(join(root, "config.json"), JSON.stringify({
    baseUrl: "https://stdio.example/v1",
    model: "stdio-model",
    contextLimit: 32768,
    maxOutputTokens: 4096,
  }), "utf8");
  await writeFile(join(root, "auth.json"), JSON.stringify({ apiKey: secret }), "utf8");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output: Buffer[] = [];
  const diagnostics: Buffer[] = [];
  stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  stderr.on("data", (chunk) => diagnostics.push(Buffer.from(chunk)));
  const rpc = new StdioRpc({ stdin, stdout, stderr, idPrefix: "core-" });
  registerCoreHandlers(rpc.peer, {
    store: new SessionStore(connection.db),
    configService: new ModelConfigService({ env: { AWACODE_DATA_DIR: root } }),
  });

  stdin.end(Buffer.from('{"jsonrpc":"2.0","id":"ui-config","method":"config/status","params":{}}\n'));
  await rpc.done;
  connection.close();

  const lines = Buffer.concat(output).toString("utf8").trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] as string), {
    jsonrpc: "2.0",
    id: "ui-config",
    result: {
      runnable: true,
      baseUrl: "https://stdio.example/v1",
      model: "stdio-model",
      contextLimit: 32768,
      maxOutputTokens: 4096,
      hasApiKey: true,
      sources: {
        baseUrl: "file",
        model: "file",
        contextLimit: "file",
        maxOutputTokens: "file",
        apiKey: "file",
      },
      issues: [],
    },
  });
  assert.equal(Buffer.concat(output).includes(Buffer.from(secret)), false);
  assert.deepEqual(diagnostics, []);
});
