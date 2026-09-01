import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentNotification } from "../../src/agent/orchestrator.ts";
import type { AssistantModelMessage, ModelProvider, ModelStreamRequest } from "../../src/llm/types.ts";
import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore } from "../../src/persistence/session-store.ts";
import { JsonRpcPeer } from "../../src/protocol/rpc-peer.ts";
import { createCoreApplication } from "../../src/runtime/core-application.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-runtime-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function connectedPeers(): { client: JsonRpcPeer; server: JsonRpcPeer } {
  let client!: JsonRpcPeer;
  let server!: JsonRpcPeer;
  client = new JsonRpcPeer({ idPrefix: "ui-", send: (message) => server.receive(message) });
  server = new JsonRpcPeer({ idPrefix: "core-", send: (message) => client.receive(message) });
  return { client, server };
}

function response(
  content: string,
  toolCalls: AssistantModelMessage["toolCalls"] = [],
): AssistantModelMessage {
  return { role: "assistant", content, toolCalls, finishReason: toolCalls.length === 0 ? "stop" : "tool_calls" };
}

class ScriptedProvider implements ModelProvider {
  readonly requests: ModelStreamRequest[] = [];
  private readonly script: AssistantModelMessage[];

  constructor(script: AssistantModelMessage[]) {
    this.script = [...script];
  }

  async stream(request: ModelStreamRequest): Promise<AssistantModelMessage> {
    this.requests.push(request);
    const next = this.script.shift();
    assert.ok(next, "fixture script was exhausted");
    request.onTextDelta?.(next.content);
    return next;
  }
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("startup recovers durable state and composes a configured per-session agent", async () => {
  const dataRoot = await temporaryDirectory("data");
  const workspace = await temporaryDirectory("workspace");
  await writeFile(join(workspace, "demo.txt"), "hello", "utf8");
  const env = {
    AWACODE_DATA_DIR: dataRoot,
    AWACODE_BASE_URL: "http://127.0.0.1:43123/v1",
    AWACODE_MODEL: "fixture-model",
    AWACODE_API_KEY: "fixture-key-not-secret",
    AWACODE_CONTEXT_LIMIT: "32768",
    AWACODE_MAX_OUTPUT_TOKENS: "4096",
  };

  const seed = await openDatabase({ env });
  const seedStore = new SessionStore(seed.db, { randomUUID: (() => {
    const ids = ["seed-session", "seed-message"];
    return () => ids.shift() ?? randomUUID();
  })() });
  const project = seedStore.upsertProject({
    id: "fixture-project",
    kind: "path",
    value: workspace,
    rootPath: workspace,
  });
  const interruptedSession = seedStore.createSession(project.id, "Interrupted");
  seedStore.setSessionStatus(interruptedSession.id, "running");
  seedStore.insertAssistantMessageWithToolCalls({
    sessionId: interruptedSession.id,
    payload: { text: "", phase: "execute" },
    toolCalls: [{ callId: "durable-pending", ordinal: 0, toolName: "read_file", inputText: "{}" }],
  });
  seed.close();

  const provider = new ScriptedProvider([
    response("Plan."),
    response("", [{ id: "read-demo", name: "read_file", arguments: "{\"path\":\"demo.txt\"}" }]),
    response("Done."),
    response('{"status":"complete","reason":"verified"}'),
  ]);
  const { client, server } = connectedPeers();
  const notifications: AgentNotification[] = [];
  for (const method of ["agent/phase", "stream/text", "stream/commit", "tool/start", "tool/end", "agent/status"] as const) {
    client.register(method, (value) => value as AgentNotification["params"], (params) => {
      notifications.push({ method, params } as AgentNotification);
    });
  }
  const application = await createCoreApplication(server, {
    env,
    providerFactory(config) {
      assert.equal(config.model, "fixture-model");
      return provider;
    },
  });

  try {
    assert.deepEqual(await client.request("core/hello", {}), {
      coreVersion: "0.1.0",
      databaseVersion: 1,
      configured: true,
      interruptedCount: 1,
    });
    const recovered = await client.request("session/load", { sessionId: interruptedSession.id }) as {
      session: { status: string };
      toolCalls: Array<{ status: string; result: unknown }>;
    };
    assert.equal(recovered.session.status, "interrupted");
    assert.deepEqual(recovered.toolCalls.map((call) => [call.status, call.result !== null]), [["interrupted", true]]);

    const created = await client.request("session/create", { projectId: project.id, title: "Run" }) as { id: string };
    const result = await client.request("agent/run", { sessionId: created.id, prompt: "Read demo.txt" }) as {
      status: string;
      finalText: string;
    };
    assert.equal(result.status, "completed");
    assert.equal(result.finalText, "Done.");
    const executeRequest = provider.requests.find((request) => request.tools !== undefined);
    assert.deepEqual(executeRequest?.tools?.map((tool) => tool.function.name).sort(), [
      "edit_file",
      "list_files",
      "read_file",
      "run_command",
      "search_text",
      "write_file",
    ]);
    assert.ok(notifications.some((notification) =>
      notification.method === "tool/end"
      && notification.params.name === "read_file"
      && notification.params.status === "success"));
  } finally {
    application.close();
    client.close();
    server.close();
  }
});

test("an incomplete model configuration rejects agent/run without constructing a provider", async () => {
  const dataRoot = await temporaryDirectory("unconfigured-data");
  const workspace = await temporaryDirectory("unconfigured-workspace");
  const { client, server } = connectedPeers();
  let providerFactories = 0;
  const application = await createCoreApplication(server, {
    env: { AWACODE_DATA_DIR: dataRoot },
    providerFactory() {
      providerFactories += 1;
      return new ScriptedProvider([]);
    },
  });
  try {
    const selected = await client.request("workspace/set", { workspace }) as { projectId: string };
    const session = await client.request("session/create", { projectId: selected.projectId }) as { id: string };
    await assert.rejects(client.request("agent/run", { sessionId: session.id, prompt: "Do it" }), (error: unknown) =>
      error instanceof Error
      && "code" in error
      && error.code === -32002);
    assert.equal(providerFactories, 0);
  } finally {
    application.close();
    client.close();
    server.close();
  }
});
