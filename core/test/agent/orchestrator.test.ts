import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModelConfigService } from "../../src/config/model-config.ts";
import {
  AgentOrchestrator,
  AgentCancelledError,
  type AgentOrchestratorOptions,
  type AgentNotification,
} from "../../src/agent/orchestrator.ts";
import type {
  AssistantModelMessage,
  ModelProvider,
  ModelStreamRequest,
} from "../../src/llm/types.ts";
import { ModelContextOverflowError } from "../../src/llm/types.ts";
import { ContextCompressionError } from "../../src/context/context-manager.ts";
import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore } from "../../src/persistence/session-store.ts";
import { RpcFault } from "../../src/protocol/json-rpc.ts";
import { JsonRpcPeer } from "../../src/protocol/rpc-peer.ts";
import { registerCoreHandlers } from "../../src/rpc/core-handlers.ts";
import { WorkspaceGuard } from "../../src/security/workspace-guard.ts";
import type { ToolDefinition, ToolResult } from "../../src/tools/contracts.ts";
import type { PermissionClient } from "../../src/tools/permission.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { editFileTool } from "../../src/tools/edit-file.ts";

const temporaryDirectories: string[] = [];

interface AgentFixture {
  connection: Awaited<ReturnType<typeof openDatabase>>;
  store: SessionStore;
  sessionId: string;
  workspace: WorkspaceGuard;
}

async function fixture(label: string): Promise<AgentFixture> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-agent-${label}-`));
  temporaryDirectories.push(directory);
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: join(directory, "data") } });
  let id = 0;
  const store = new SessionStore(connection.db, {
    now: () => new Date("2026-09-01T01:02:03.000Z"),
    randomUUID: () => `durable-${++id}`,
  });
  store.upsertProject({ id: "project", kind: "path", value: directory, rootPath: directory });
  const session = store.createSession("project", label);
  return { connection, store, sessionId: session.id, workspace: await WorkspaceGuard.create(directory) };
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

class ScriptedProvider implements ModelProvider {
  readonly requests: ModelStreamRequest[] = [];
  private readonly script: AssistantModelMessage[];

  constructor(script: AssistantModelMessage[]) {
    this.script = [...script];
  }

  async stream(request: ModelStreamRequest): Promise<AssistantModelMessage> {
    this.requests.push({
      messages: structuredClone(request.messages),
      ...(request.tools === undefined ? {} : { tools: structuredClone(request.tools) }),
    });
    if (request.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const response = this.script.shift();
    if (response === undefined) {
      throw new Error("script exhausted");
    }
    if (response.content.length > 0) {
      request.onTextDelta?.(response.content);
    }
    return structuredClone(response);
  }
}

const allowPermission: PermissionClient = {
  async requestPermission() {
    return "allow_once";
  },
};

function scriptedTool(name: string, order: string[]): ToolDefinition<{ value: string }> {
  return {
    name,
    description: `${name} fixture tool`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string" } },
    },
    approval: "none",
    validate(value) {
      if (
        typeof value !== "object"
        || value === null
        || Array.isArray(value)
        || Object.keys(value).length !== 1
        || typeof (value as { value?: unknown }).value !== "string"
      ) {
        throw new TypeError("invalid fixture input");
      }
      return { value: (value as { value: string }).value };
    },
    async execute(input): Promise<ToolResult> {
      order.push(`${name}:start:${input.value}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      order.push(`${name}:end:${input.value}`);
      return {
        status: "success",
        summary: `${name} completed`,
        content: input.value,
        durationMs: 1,
        metadata: { name },
      };
    },
  };
}

function response(content: string, toolCalls: AssistantModelMessage["toolCalls"] = []): AssistantModelMessage {
  return {
    role: "assistant",
    content,
    toolCalls,
    finishReason: toolCalls.length === 0 ? "stop" : "tool_calls",
  };
}

function connectedPeers(): { client: JsonRpcPeer; server: JsonRpcPeer } {
  let client!: JsonRpcPeer;
  let server!: JsonRpcPeer;
  client = new JsonRpcPeer({ idPrefix: "ui-", send: (message) => server.receive(message) });
  server = new JsonRpcPeer({ idPrefix: "core-", send: (message) => client.receive(message) });
  return { client, server };
}

test("Plan, serial tools, provisional Execute text, and valid Reflect complete form one durable committed run", async () => {
  const f = await fixture("happy");
  const order: string[] = [];
  const registry = new ToolRegistry();
  registry.register(scriptedTool("alpha", order));
  registry.register(scriptedTool("beta", order));
  const provider = new ScriptedProvider([
    response("Inspect, then edit."),
    response("", [
      { id: "call-alpha", name: "alpha", arguments: "{\"value\":\"A\"}" },
      { id: "call-beta", name: "beta", arguments: "{\"value\":\"B\"}" },
    ]),
    response("All checks pass."),
    response('{"status":"complete","reason":"verified"}'),
  ]);
  const notifications: AgentNotification[] = [];
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: registry,
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
    createRunId: () => "run-happy",
    notify: async (notification) => { notifications.push(structuredClone(notification)); },
  });

  try {
    assert.deepEqual(await orchestrator.run({ sessionId: f.sessionId, prompt: "Fix it" }), {
      runId: "run-happy",
      finalText: "All checks pass.",
      status: "completed",
      reason: "verified",
      modelTurns: 4,
      toolCalls: 2,
    });
    assert.deepEqual(order, ["alpha:start:A", "alpha:end:A", "beta:start:B", "beta:end:B"]);
    assert.deepEqual(notifications.map((event) => event.params.eventSeq),
      notifications.map((_, index) => index + 1));
    assert.equal(notifications.every((event) => event.params.runId === "run-happy"), true);
    assert.deepEqual(notifications[0], {
      method: "agent/status",
      params: { runId: "run-happy", eventSeq: 1, status: "busy", reason: "run_started" },
    });
    const toolEnds = notifications.filter((event) => event.method === "tool/end");
    assert.deepEqual(toolEnds.map((event) => ({
      callId: event.params.callId,
      ordinal: event.params.ordinal,
      name: event.params.name,
      status: event.params.status,
      durationMs: event.params.durationMs,
      summary: event.params.summary,
      content: event.params.content,
      metadata: event.params.metadata,
    })), [
      {
        callId: "call-alpha",
        ordinal: 0,
        name: "alpha",
        status: "success",
        durationMs: 1,
        summary: "alpha completed",
        content: "A",
        metadata: { name: "alpha" },
      },
      {
        callId: "call-beta",
        ordinal: 1,
        name: "beta",
        status: "success",
        durationMs: 1,
        summary: "beta completed",
        content: "B",
        metadata: { name: "beta" },
      },
    ]);
    assert.equal(notifications.some((event) => event.method === "stream/commit"
      && event.params.messageId === "durable-5"), true);
    assert.deepEqual(notifications.at(-1), {
      method: "agent/status",
      params: { runId: "run-happy", eventSeq: notifications.length, status: "done", reason: "verified" },
    });

    const loaded = f.store.loadSession(f.sessionId);
    assert.equal(loaded.session.status, "completed");
    assert.deepEqual(loaded.toolCalls.map((call) => [call.callId, call.status]), [
      ["call-alpha", "success"],
      ["call-beta", "success"],
    ]);
    assert.equal(loaded.messages.some((message) => message.role === "internal" && message.kind === "reflect"), true);
    assert.equal(loaded.messages.every((message) => message.status === "complete"), true);

    assert.equal(provider.requests.length, 4);
    assert.equal(provider.requests[0]!.tools, undefined);
    assert.deepEqual(provider.requests[1]!.tools?.map((tool) => tool.function.name), ["alpha", "beta"]);
    assert.equal(provider.requests[2]!.messages.some((message) => message.role === "tool" && message.toolCallId === "call-beta"), true);
    assert.equal(provider.requests[3]!.messages.some((message) => message.role === "assistant" && message.content === "All checks pass."), true);
  } finally {
    f.connection.close();
  }
});

test("unknown, invalid, and denied tool calls each persist exactly one terminal result", async () => {
  const f = await fixture("tool-failures");
  await writeFile(join(f.workspace.rootPath, "demo.txt"), "old", "utf8");
  const registry = new ToolRegistry();
  registry.register(scriptedTool("alpha", []));
  registry.register(editFileTool);
  const provider = new ScriptedProvider([
    response("Plan."),
    response("", [
      { id: "unknown", name: "missing_tool", arguments: "{}" },
      { id: "malformed", name: "alpha", arguments: "{" },
      { id: "invalid", name: "alpha", arguments: "{\"wrong\":true}" },
      { id: "denied", name: "edit_file", arguments: "{\"path\":\"demo.txt\",\"old_text\":\"old\",\"new_text\":\"new\"}" },
    ]),
    response("No changes were made."),
    response('{"status":"complete","reason":"handled"}'),
  ]);
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: registry,
    permissionClient: { async requestPermission() { return "deny"; } },
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });

  try {
    const result = await orchestrator.run({ sessionId: f.sessionId, prompt: "Try tools" });
    assert.equal(result.status, "completed");
    assert.equal(await readFile(join(f.workspace.rootPath, "demo.txt"), "utf8"), "old");
    const calls = f.store.loadSession(f.sessionId).toolCalls;
    assert.deepEqual(calls.map((call) => [call.callId, call.status, call.result !== null]), [
      ["unknown", "failure", true],
      ["malformed", "failure", true],
      ["invalid", "failure", true],
      ["denied", "denied", true],
    ]);
    assert.equal(new Set(calls.map((call) => call.callId)).size, 4);
  } finally {
    f.connection.close();
  }
});

test("cancellation interrupts an awaiting approval, settles the call, and never auto-replays it", async () => {
  const f = await fixture("cancel");
  await writeFile(join(f.workspace.rootPath, "demo.txt"), "old", "utf8");
  const registry = new ToolRegistry();
  registry.register(editFileTool);
  const provider = new ScriptedProvider([
    response("Plan."),
    response("", [{
      id: "cancelled-edit",
      name: "edit_file",
      arguments: "{\"path\":\"demo.txt\",\"old_text\":\"old\",\"new_text\":\"new\"}",
    }]),
  ]);
  let approvalEntered!: () => void;
  const entered = new Promise<void>((resolve) => { approvalEntered = resolve; });
  const permissionClient: PermissionClient = {
    requestPermission(_request, options) {
      approvalEntered();
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: registry,
    permissionClient,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });

  try {
    const running = orchestrator.run({ sessionId: f.sessionId, prompt: "Edit it" });
    await entered;
    assert.equal(orchestrator.cancel(), true);
    await assert.rejects(running, (error: unknown) =>
      error instanceof AgentCancelledError && error.result.status === "cancelled");
    assert.equal(orchestrator.cancel(), false);
    const loaded = f.store.loadSession(f.sessionId);
    assert.equal(loaded.session.status, "cancelled");
    assert.deepEqual(loaded.toolCalls.map((call) => [call.callId, call.status, call.result !== null]), [
      ["cancelled-edit", "interrupted", true],
    ]);
    assert.equal(loaded.messages.filter((message) => message.status === "streaming").length, 0);
    assert.equal(await readFile(join(f.workspace.rootPath, "demo.txt"), "utf8"), "old");
  } finally {
    f.connection.close();
  }
});

test("malformed Reflect retries once and continue permits one remedial Execute without recursive reflection", async () => {
  const f = await fixture("reflect-retry");
  const provider = new ScriptedProvider([
    response("Plan once."),
    response("First candidate."),
    response("not-json"),
    response('{"status":"continue","reason":"tests still fail"}'),
    response("Remedial candidate."),
  ]);
  const notifications: AgentNotification[] = [];
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: new ToolRegistry(),
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
    createRunId: () => "run-reflect-retry",
    notify: (notification) => { notifications.push(structuredClone(notification)); },
  });

  try {
    assert.deepEqual(await orchestrator.run({ sessionId: f.sessionId, prompt: "Fix tests" }), {
      runId: "run-reflect-retry",
      finalText: "Remedial candidate.",
      status: "completed",
      reason: "tests still fail",
      modelTurns: 5,
      toolCalls: 0,
    });
    assert.equal(provider.requests.length, 5);
    assert.equal(provider.requests[2]!.tools, undefined);
    assert.equal(provider.requests[3]!.tools, undefined);
    assert.equal(provider.requests[3]!.messages.at(-1)?.role, "system");
    assert.match(provider.requests[3]!.messages.at(-1)!.content as string, /invalid|malformed|exact JSON/i);
    assert.equal(provider.requests.filter((request) =>
      request.messages.at(-1)?.role === "system"
      && (request.messages.at(-1)!.content as string).includes("Review the candidate")).length, 1);
    const remedialRequest = provider.requests[4]!;
    assert.match(remedialRequest.messages.at(-1)!.content as string, /tests still fail/);
    assert.match(remedialRequest.messages.at(-1)!.content as string, /untrusted review text/i);
    assert.equal(remedialRequest.messages.some((message) => message.role === "assistant" && message.content === "First candidate."), false);
    const loaded = f.store.loadSession(f.sessionId);
    assert.equal(loaded.messages.filter((message) => message.role === "internal" && message.kind === "reflect").length, 2);
    const commits = notifications.filter((event) => event.method === "stream/commit");
    assert.equal(commits.length, 1);
    const committed = loaded.messages.find((message) => message.id === commits[0]!.params.messageId);
    assert.deepEqual(committed?.payload, {
      text: "Remedial candidate.", phase: "execute", candidateStatus: "accepted", runId: "run-reflect-retry",
    });
    const rejected = loaded.messages.find((message) => message.payload !== null
      && typeof message.payload === "object"
      && (message.payload as { text?: unknown }).text === "First candidate.");
    assert.equal((rejected?.payload as { candidateStatus?: unknown }).candidateStatus, "rejected");
    assert.equal(notifications.some((event) => event.method === "stream/reject"
      && event.params.messageId === rejected?.id), true);
  } finally {
    f.connection.close();
  }
});

test("Reflect overflow protects the pending candidate from summaries before rejecting it", async () => {
  const f = await fixture("reflect-overflow-protection");
  f.store.insertMessage({
    sessionId: f.sessionId,
    role: "assistant",
    kind: "text",
    payload: { text: "old context that may be summarized" },
  });
  const requests: ModelStreamRequest[] = [];
  let ordinaryCall = 0;
  let reflectOverflowed = false;
  const provider: ModelProvider = {
    async stream(request) {
      requests.push({
        messages: structuredClone(request.messages),
        ...(request.tools === undefined ? {} : { tools: structuredClone(request.tools) }),
      });
      const last = request.messages.at(-1)?.content ?? "";
      if (request.messages[0]?.content.includes("structured rolling summary")) {
        assert.equal(JSON.stringify(request.messages).includes("pending candidate secret"), false);
        return response("summary of old context only");
      }
      if (last.includes("Review the candidate") && !reflectOverflowed) {
        reflectOverflowed = true;
        throw new ModelContextOverflowError();
      }
      ordinaryCall += 1;
      return [
        response("Plan."),
        response("pending candidate secret"),
        response('{"status":"continue","reason":"tests fail"}'),
        response("fixed candidate"),
      ][ordinaryCall - 1]!;
    },
  };
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: new ToolRegistry(),
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });
  try {
    const result = await orchestrator.run({ sessionId: f.sessionId, prompt: "Fix it" });
    assert.equal(result.finalText, "fixed candidate");
    const summaryRequest = requests.find((request) => request.messages[0]?.content.includes("structured rolling summary"));
    assert.ok(summaryRequest);
    const remedialRequest = requests.at(-1)!;
    assert.equal(JSON.stringify(remedialRequest.messages).includes("pending candidate secret"), false);
    assert.equal(f.store.loadContextSnapshot(f.sessionId)?.summary?.includes("pending candidate secret"), false);
  } finally {
    f.connection.close();
  }
});

test("Reflect continue after the twelfth Execute request closes without a thirteenth remedial Execute", async () => {
  const f = await fixture("remedial-turn-bound");
  const registry = new ToolRegistry();
  registry.register(scriptedTool("alpha", []));
  const script = [response("Plan.")];
  for (let index = 1; index <= 11; index += 1) {
    script.push(response("", [{ id: `bounded-${index}`, name: "alpha", arguments: `{"value":"${index}"}` }]));
  }
  script.push(response("Twelfth-turn candidate."));
  script.push(response('{"status":"continue","reason":"one more change is needed"}'));
  script.push(response("Stopped at the Execute limit; remedial work was not started."));
  const provider = new ScriptedProvider(script);
  const orchestrator = new AgentOrchestrator({
    store: f.store, provider, tools: registry, permissionClient: allowPermission, workspace: f.workspace,
    contextLimit: 32_768, maxOutputTokens: 4_096,
  });
  try {
    const result = await orchestrator.run({ sessionId: f.sessionId, prompt: "Bound remediation" });
    assert.equal(result.reason, "execute_turn_limit");
    assert.equal(result.finalText, "Stopped at the Execute limit; remedial work was not started.");
    assert.equal(provider.requests.length, 15);
    assert.equal(provider.requests.at(-1)!.tools, undefined);
    assert.match(provider.requests.at(-1)!.messages.at(-1)!.content as string, /execute_turn_limit/);
  } finally { f.connection.close(); }
});

test("a run atomically binds non-secret model metadata to its session and persisted messages", async () => {
  const f = await fixture("model-binding");
  const provider = new ScriptedProvider([
    response("Plan."), response("Candidate."), response('{"status":"complete","reason":"done"}'),
  ]);
  const options: AgentOrchestratorOptions & { modelMetadata: { model: string; contextLimit: number; maxOutputTokens: number } } = {
    store: f.store, provider, tools: new ToolRegistry(), permissionClient: allowPermission, workspace: f.workspace,
    contextLimit: 32_768, maxOutputTokens: 4_096, createRunId: () => "run-model-binding",
    modelMetadata: { model: "fixture-model", contextLimit: 32_768, maxOutputTokens: 4_096 },
  };
  const orchestrator = new AgentOrchestrator(options);
  try {
    await orchestrator.run({ sessionId: f.sessionId, prompt: "Bind model" });
    const loaded = f.store.loadSession(f.sessionId);
    assert.deepEqual(loaded.session.model, options.modelMetadata);
    assert.equal(loaded.messages.every((message) => {
      const payload = message.payload as { runId?: unknown; model?: unknown };
      return message.role === "internal" || (payload.runId === "run-model-binding" && payload.model === "fixture-model");
    }), true);
  } finally { f.connection.close(); }
});

test("a second malformed Reflect response ends explicitly after exactly one retry", async () => {
  const f = await fixture("reflect-twice-invalid");
  const provider = new ScriptedProvider([
    response("Plan."),
    response("Candidate."),
    response("invalid one"),
    response('{"status":"complete","reason":7}'),
  ]);
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: new ToolRegistry(),
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });

  try {
    await assert.rejects(orchestrator.run({ sessionId: f.sessionId, prompt: "Reflect" }),
      (error: unknown) => error instanceof Error && error.message === "Reflect output was malformed twice.");
    assert.equal(provider.requests.length, 4);
    const loaded = f.store.loadSession(f.sessionId);
    assert.equal(loaded.session.status, "error");
    assert.equal(loaded.messages.filter((message) => message.role === "internal" && message.kind === "reflect").length, 2);
  } finally {
    f.connection.close();
  }
});

test("unexpected Plan tool calls are rejected but first settled into complete history", async () => {
  const f = await fixture("plan-tool-call");
  const provider = new ScriptedProvider([
    response("", [{ id: "plan-call", name: "missing_tool", arguments: "{}" }]),
  ]);
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: new ToolRegistry(),
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });

  try {
    await assert.rejects(orchestrator.run({ sessionId: f.sessionId, prompt: "Plan" }),
      (error: unknown) => error instanceof Error && error.message === "Plan returned unexpected tool calls.");
    const loaded = f.store.loadSession(f.sessionId);
    assert.equal(loaded.session.status, "error");
    assert.deepEqual(loaded.toolCalls.map((call) => [call.callId, call.status, call.result !== null]), [
      ["plan-call", "failure", true],
    ]);
    assert.equal(provider.requests.length, 1);
  } finally {
    f.connection.close();
  }
});

test("a failed required notification settles the run without side effects and does not poison the next run", async () => {
  const f = await fixture("notification-failure");
  const order: string[] = [];
  const registry = new ToolRegistry();
  registry.register(scriptedTool("alpha", order));
  const provider = new ScriptedProvider([
    response("Plan."),
    response("", [{ id: "notify-call", name: "alpha", arguments: "{\"value\":\"A\"}" }]),
    response("Second plan."),
    response("Second candidate."),
    response('{"status":"complete","reason":"second run completed"}'),
  ]);
  let failToolStart = true;
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: registry,
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
    notify(notification) {
      if (failToolStart && notification.method === "tool/start") {
        throw new Error("fixture notification failure");
      }
    },
  });

  try {
    await assert.rejects(orchestrator.run({ sessionId: f.sessionId, prompt: "Notify" }), /notification failure/);
    const loaded = f.store.loadSession(f.sessionId);
    assert.equal(loaded.session.status, "error");
    assert.deepEqual(loaded.toolCalls.map((call) => [call.callId, call.status, call.result !== null]), [
      ["notify-call", "interrupted", true],
    ]);
    assert.equal(loaded.messages.filter((message) => message.status === "streaming").length, 0);
    assert.deepEqual(order, []);
    assert.equal(orchestrator.cancel(), false);

    failToolStart = false;
    const second = await orchestrator.run({ sessionId: f.sessionId, prompt: "Try again" });
    assert.equal(second.status, "completed");
    assert.equal(second.finalText, "Second candidate.");
    assert.equal(orchestrator.cancel(), false);
  } finally {
    f.connection.close();
  }
});

test("a failed fire-and-forget text notification is observed by the run without an unhandled rejection", async () => {
  const f = await fixture("text-notification-failure");
  let providerCalls = 0;
  const provider: ModelProvider = {
    async stream(request) {
      providerCalls += 1;
      const scripted = providerCalls === 1
        ? response("first plan")
        : providerCalls === 2
          ? response("second plan")
          : providerCalls === 3
            ? response("second candidate")
            : response('{"status":"complete","reason":"recovered"}');
      request.onTextDelta?.(scripted.content);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return scripted;
    },
  };
  let failText = true;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: new ToolRegistry(),
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
    notify(notification) {
      if (failText && notification.method === "stream/text") {
        throw new Error("fixture text notification failure");
      }
    },
  });

  try {
    await assert.rejects(orchestrator.run({ sessionId: f.sessionId, prompt: "First" }), /text notification failure/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(orchestrator.cancel(), false);
    failText = false;
    assert.equal((await orchestrator.run({ sessionId: f.sessionId, prompt: "Second" })).status, "completed");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    f.connection.close();
  }
});

test("a session-load failure is not masked by cleanup for a session that was never opened", async () => {
  const f = await fixture("load-failure");
  const originalError = new Error("fixture original load failure");
  let cleanupCalls = 0;
  Object.defineProperty(f.store, "loadSession", {
    configurable: true,
    value() { throw originalError; },
  });
  Object.defineProperty(f.store, "interruptSessionState", {
    configurable: true,
    value() {
      cleanupCalls += 1;
      throw new Error("fixture cleanup failure");
    },
  });
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider: new ScriptedProvider([]),
    tools: new ToolRegistry(),
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });

  try {
    await assert.rejects(orchestrator.run({ sessionId: f.sessionId, prompt: "Load" }),
      (error: unknown) => error === originalError);
    assert.equal(cleanupCalls, 0);
    assert.equal(orchestrator.cancel(), false);
  } finally {
    f.connection.close();
  }
});

test("the twelfth Execute tool turn closes with one no-tools summary instead of requesting a thirteenth tool turn", async () => {
  const f = await fixture("turn-limit");
  const registry = new ToolRegistry();
  registry.register(scriptedTool("alpha", []));
  const script = [response("Plan.")];
  for (let index = 1; index <= 12; index += 1) {
    script.push(response("", [{ id: `turn-${index}`, name: "alpha", arguments: `{"value":"${index}"}` }]));
  }
  script.push(response("Stopped after twelve Execute turns; remaining work is reported."));
  const provider = new ScriptedProvider(script);
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: registry,
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });

  try {
    const result = await orchestrator.run({ sessionId: f.sessionId, prompt: "Loop" });
    assert.deepEqual({
      finalText: result.finalText,
      status: result.status,
      reason: result.reason,
      modelTurns: result.modelTurns,
      toolCalls: result.toolCalls,
    }, {
      finalText: "Stopped after twelve Execute turns; remaining work is reported.",
      status: "completed",
      reason: "execute_turn_limit",
      modelTurns: 14,
      toolCalls: 12,
    });
    assert.equal(provider.requests.length, 14);
    assert.equal(provider.requests.at(-1)!.tools, undefined);
    assert.match(provider.requests.at(-1)!.messages.at(-1)!.content as string, /completed work/i);
    assert.match(provider.requests.at(-1)!.messages.at(-1)!.content as string, /unfinished work/i);
    assert.match(provider.requests.at(-1)!.messages.at(-1)!.content as string, /execute_turn_limit/);
  } finally {
    f.connection.close();
  }
});

test("only twenty-four tools execute and later calls in the persisted block receive non-executed failures", async () => {
  const f = await fixture("tool-limit");
  const registry = new ToolRegistry();
  registry.register(scriptedTool("alpha", []));
  const calls = Array.from({ length: 25 }, (_, index) => ({
    id: `tool-${index + 1}`,
    name: "alpha",
    arguments: `{"value":"${index + 1}"}`,
  }));
  const provider = new ScriptedProvider([
    response("Plan."),
    response("", calls),
    response("Stopped at the tool limit."),
  ]);
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: registry,
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });

  try {
    const result = await orchestrator.run({ sessionId: f.sessionId, prompt: "Many tools" });
    assert.equal(result.reason, "tool_call_limit");
    assert.equal(result.toolCalls, 24);
    assert.equal(provider.requests.length, 3);
    assert.equal(provider.requests[2]!.tools, undefined);
    const persisted = f.store.loadSession(f.sessionId).toolCalls;
    assert.equal(persisted.length, 25);
    assert.equal(persisted[23]!.status, "success");
    assert.equal(persisted[24]!.status, "failure");
    assert.deepEqual((persisted[24]!.result as ToolResult).metadata, {
      error: "tool_call_limit",
      sideEffects: "none",
    });
  } finally {
    f.connection.close();
  }
});

test("the third consecutive identical canonical call is persisted as a non-executed failure and closes the run", async () => {
  const f = await fixture("repeat-limit");
  const order: string[] = [];
  const registry = new ToolRegistry();
  registry.register(scriptedTool("alpha", order));
  const provider = new ScriptedProvider([
    response("Plan."),
    response("", [
      { id: "repeat-1", name: "alpha", arguments: "{\"value\":\"same\"}" },
      { id: "repeat-2", name: "alpha", arguments: "{ \"value\" : \"same\" }" },
      { id: "repeat-3", name: "alpha", arguments: "{\"value\":\"same\"}" },
    ]),
    response("Stopped because the same call repeated."),
  ]);
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: registry,
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });

  try {
    const result = await orchestrator.run({ sessionId: f.sessionId, prompt: "Repeat" });
    assert.equal(result.reason, "repeated_tool_call");
    assert.equal(result.toolCalls, 2);
    assert.deepEqual(order, ["alpha:start:same", "alpha:end:same", "alpha:start:same", "alpha:end:same"]);
    const third = f.store.loadToolCall("repeat-3");
    assert.equal(third.status, "failure");
    assert.deepEqual((third.result as ToolResult).metadata, {
      error: "repeated_tool_call",
      sideEffects: "none",
    });
  } finally {
    f.connection.close();
  }
});

test("agent RPC validates exact params, reports busy, signals cancellation, and maps cancellation stably", async () => {
  const f = await fixture("rpc-busy");
  let entered!: () => void;
  const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
  const blockingProvider: ModelProvider = {
    async stream(request): Promise<AssistantModelMessage> {
      entered();
      return new Promise<AssistantModelMessage>((_resolve, reject) => {
        const rejectAbort = () => reject(request.signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (request.signal?.aborted) {
          rejectAbort();
        } else {
          request.signal?.addEventListener("abort", rejectAbort, { once: true });
        }
      });
    },
  };
  const agent = new AgentOrchestrator({
    store: f.store,
    provider: blockingProvider,
    tools: new ToolRegistry(),
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });
  const { client, server } = connectedPeers();
  registerCoreHandlers(server, {
    store: f.store,
    configService: new ModelConfigService({ env: { AWACODE_DATA_DIR: join(f.workspace.rootPath, "config") } }),
    agent,
  });

  try {
    for (const params of [undefined, {}, { sessionId: f.sessionId, prompt: "" }, { sessionId: f.sessionId, prompt: "go", extra: true }]) {
      await assert.rejects(
        params === undefined ? client.request("agent/run") : client.request("agent/run", params),
        (error: unknown) => error instanceof RpcFault && error.code === -32602,
      );
    }
    await assert.rejects(client.request("agent/cancel", { extra: true }),
      (error: unknown) => error instanceof RpcFault && error.code === -32602);

    const running = client.request("agent/run", { sessionId: f.sessionId, prompt: "go" });
    await providerEntered;
    await assert.rejects(client.request("agent/run", { sessionId: f.sessionId, prompt: "second" }),
      (error: unknown) => error instanceof RpcFault && error.code === -32001 && error.message === "Agent is busy");
    assert.deepEqual(await client.request("agent/cancel", {}), { signalled: true });
    await assert.rejects(running,
      (error: unknown) => error instanceof RpcFault && error.code === -32005 && error.message === "Agent run cancelled");
    assert.deepEqual(await client.request("agent/cancel", {}), { signalled: false });
  } finally {
    client.close();
    server.close();
    f.connection.close();
  }
});

test("agent RPC maps persisted incomplete tool history to history-integrity without calling the provider", async () => {
  const f = await fixture("rpc-history");
  f.store.insertAssistantMessageWithToolCalls({
    sessionId: f.sessionId,
    payload: { text: "orphan pending", phase: "execute" },
    toolCalls: [{ callId: "pending-before-run", ordinal: 0, toolName: "alpha", inputText: "{}" }],
  });
  f.connection.db.prepare(`
    UPDATE tool_calls
    SET status = 'failure', result_json = NULL, finished_at = '2026-09-01T01:02:03.000Z'
    WHERE call_id = 'pending-before-run'
  `).run();
  let providerCalls = 0;
  const agent = new AgentOrchestrator({
    store: f.store,
    provider: { async stream() { providerCalls += 1; return response("must not run"); } },
    tools: new ToolRegistry(),
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });
  const { client, server } = connectedPeers();
  registerCoreHandlers(server, {
    store: f.store,
    configService: new ModelConfigService({ env: { AWACODE_DATA_DIR: join(f.workspace.rootPath, "config") } }),
    agent,
  });

  try {
    await assert.rejects(client.request("agent/run", { sessionId: f.sessionId, prompt: "resume" }),
      (error: unknown) => error instanceof RpcFault
        && error.code === -32004
        && error.message === "Session history is incomplete");
    assert.equal(providerCalls, 0);
    assert.equal(f.store.loadSession(f.sessionId).session.status, "error");
  } finally {
    client.close();
    server.close();
    f.connection.close();
  }
});

test("provider context overflow triggers one persisted compression and retries the original turn once", async () => {
  const f = await fixture("overflow-retry");
  const requests: ModelStreamRequest[] = [];
  const script: Array<AssistantModelMessage | Error> = [
    response("Plan."),
    new ModelContextOverflowError(),
    response("Goal: finish the request.\nCurrent state: planned."),
    response("Candidate complete."),
    response('{"status":"complete","reason":"verified"}'),
  ];
  const provider: ModelProvider = {
    async stream(request) {
      requests.push({
        messages: structuredClone(request.messages),
        ...(request.tools === undefined ? {} : { tools: structuredClone(request.tools) }),
        ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
      });
      const next = script.shift();
      assert.ok(next);
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: new ToolRegistry(),
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });
  try {
    const result = await orchestrator.run({ sessionId: f.sessionId, prompt: "Do it" });
    assert.equal(result.status, "completed");
    assert.equal(requests.length, 5);
    assert.match(requests[2]?.messages[0]?.content ?? "", /structured rolling summary/i);
    assert.equal(requests[2]?.maxOutputTokens, 4_096);
    assert.equal(f.store.loadContextSnapshot(f.sessionId)?.summary, "Goal: finish the request.\nCurrent state: planned.");
    assert.ok(requests[3]?.messages.some((message) => message.role === "system" && message.content.includes("Conversation summary")));
  } finally {
    f.connection.close();
  }
});

test("a second provider overflow after compression fails explicitly without a third original attempt", async () => {
  const f = await fixture("overflow-twice");
  let calls = 0;
  const script: Array<AssistantModelMessage | Error> = [
    response("Plan."),
    new ModelContextOverflowError(),
    response("compressed"),
    new ModelContextOverflowError(),
  ];
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider: {
      async stream() {
        calls += 1;
        const next = script.shift();
        assert.ok(next);
        if (next instanceof Error) throw next;
        return next;
      },
    },
    tools: new ToolRegistry(),
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });
  try {
    await assert.rejects(
      orchestrator.run({ sessionId: f.sessionId, prompt: "Do it" }),
      (error: unknown) => error instanceof ContextCompressionError && error.code === "context_overflow_after_compression",
    );
    assert.equal(calls, 4);
    assert.ok(f.store.loadSession(f.sessionId).messages.length >= 2);
  } finally {
    f.connection.close();
  }
});
