import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModelConfigService } from "../../src/config/model-config.ts";
import {
  AgentOrchestrator,
  AgentCancelledError,
  AgentRunError,
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
import { readFileTool } from "../../src/tools/read-file.ts";
import { runCommandTool } from "../../src/tools/run-command.ts";
import { writeFileTool } from "../../src/tools/write-file.ts";

const temporaryDirectories: string[] = [];

interface AgentFixture {
  connection: Awaited<ReturnType<typeof openDatabase>>;
  dataRoot: string;
  store: SessionStore;
  sessionId: string;
  workspace: WorkspaceGuard;
}

async function fixture(label: string): Promise<AgentFixture> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-agent-${label}-`));
  temporaryDirectories.push(directory);
  const dataRoot = join(directory, "data");
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: dataRoot } });
  let id = 0;
  const store = new SessionStore(connection.db, {
    now: () => new Date("2026-09-01T01:02:03.000Z"),
    randomUUID: () => `durable-${++id}`,
  });
  store.upsertProject({ id: "project", kind: "path", value: directory, rootPath: directory });
  const session = store.createSession("project", label);
  return { connection, dataRoot, store, sessionId: session.id, workspace: await WorkspaceGuard.create(directory) };
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

function response(
  content: string,
  toolCalls: AssistantModelMessage["toolCalls"] = [],
  reasoningContent?: string,
): AssistantModelMessage {
  return {
    role: "assistant",
    content,
    toolCalls,
    finishReason: toolCalls.length === 0 ? "stop" : "tool_calls",
    ...(reasoningContent === undefined ? {} : { reasoningContent }),
  };
}

function connectedPeers(): { client: JsonRpcPeer; server: JsonRpcPeer } {
  let client!: JsonRpcPeer;
  let server!: JsonRpcPeer;
  client = new JsonRpcPeer({ idPrefix: "ui-", send: (message) => server.receive(message) });
  server = new JsonRpcPeer({ idPrefix: "core-", send: (message) => client.receive(message) });
  return { client, server };
}

test("Plan and serial tools commit the first tool-free Execute response without a Reflect request", async () => {
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
      reason: "model_stop",
      modelTurns: 3,
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
      params: { runId: "run-happy", eventSeq: notifications.length, status: "done", reason: "model_stop" },
    });

    const loaded = f.store.loadSession(f.sessionId);
    assert.equal(loaded.session.status, "completed");
    assert.deepEqual(loaded.toolCalls.map((call) => [call.callId, call.status]), [
      ["call-alpha", "success"],
      ["call-beta", "success"],
    ]);
    assert.equal(loaded.messages.some((message) => message.role === "internal" && message.kind === "reflect"), false);
    assert.equal(loaded.messages.every((message) => message.status === "complete"), true);

    assert.equal(provider.requests.length, 3);
    assert.equal(provider.requests[0]!.tools, undefined);
    assert.deepEqual(provider.requests[1]!.tools?.map((tool) => tool.function.name), ["alpha", "beta"]);
    assert.equal(provider.requests[2]!.messages.some((message) => message.role === "tool" && message.toolCallId === "call-beta"), true);
    assert.equal(notifications.some((event) => event.method === "agent/phase" && (event.params.phase as string) === "reflect"), false);
  } finally {
    f.connection.close();
  }
});

test("Plan exhausts its read turns by forcing one tool-free plan before Execute", async () => {
  const f = await fixture("plan-finalization");
  const order: string[] = [];
  const registry = new ToolRegistry();
  registry.register(scriptedTool("read_file", order));
  const provider = new ScriptedProvider([
    ...Array.from({ length: 12 }, (_, index) => response("", [{
      id: `plan-read-${index + 1}`,
      name: "read_file",
      arguments: JSON.stringify({ value: `file-${index + 1}` }),
    }])),
    response("Inspect the memory files, then explain their lifecycle."),
    response("The memory module stores durable project facts."),
  ]);
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: registry,
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
    createRunId: () => "run-plan-finalization",
  });

  try {
    assert.deepEqual(await orchestrator.run({ sessionId: f.sessionId, prompt: "Explain memory" }), {
      runId: "run-plan-finalization",
      finalText: "The memory module stores durable project facts.",
      status: "completed",
      reason: "model_stop",
      modelTurns: 14,
      toolCalls: 12,
    });
    assert.equal(provider.requests[12]?.tools, undefined);
    assert.equal(provider.requests[13]?.tools?.[0]?.function.name, "read_file");
    assert.equal(f.store.loadSession(f.sessionId).session.status, "completed");
  } finally {
    f.connection.close();
  }
});

test("Plan executes only advertised structured read calls and never treats DSML text as a tool", async () => {
  const f = await fixture("plan-read-loop");
  await writeFile(join(f.workspace.rootPath, "README.md"), "AwaCode fixture", "utf8");
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(editFileTool);
  registry.register(writeFileTool);
  registry.register(runCommandTool);
  const provider = new ScriptedProvider([
    response("<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"read_file\"><｜｜DSML｜｜parameter name=\"path\" string=\"true\">README.md</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>", [
      { id: "plan-read", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
    ]),
    response("Inspect README, then report the project purpose."),
    response("AwaCode fixture is a small coding-agent project."),
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
    const result = await orchestrator.run({ sessionId: f.sessionId, prompt: "Describe this project" });
    assert.equal(result.status, "completed");
    assert.equal(result.modelTurns, 3);
    assert.equal(result.toolCalls, 1);
    assert.deepEqual(provider.requests[0]!.tools?.map((tool) => tool.function.name), ["read_file"]);
    assert.deepEqual(provider.requests[1]!.tools?.map((tool) => tool.function.name), ["read_file"]);
    const planFollowUp = provider.requests[1]!.messages;
    assert.equal(planFollowUp.some((message) => message.role === "tool"
      && message.toolCallId === "plan-read"
      && message.content.includes("AwaCode fixture")), true);
    const loaded = f.store.loadSession(f.sessionId);
    assert.deepEqual(loaded.toolCalls.map((call) => [call.toolName, call.status]), [["read_file", "success"]]);
    assert.equal(loaded.messages.some((message) => message.kind === "plan"
      && (message.payload as { text?: unknown }).text === "Inspect README, then report the project purpose."), true);
  } finally {
    f.connection.close();
  }
});

test("every user-facing model request requires plain text without Markdown", async () => {
  const f = await fixture("plain-text");
  const provider = new ScriptedProvider([response("Plan."), response("Done.")]);
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: new ToolRegistry(),
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
    systemPrompt: "Custom project instructions.",
  });

  try {
    await orchestrator.run({ sessionId: f.sessionId, prompt: "Explain it" });
    assert.equal(provider.requests.length, 2);
    for (const request of provider.requests) {
      const systemText = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      assert.match(systemText, /plain text/i);
      assert.match(systemText, /do not use Markdown/i);
    }
  } finally {
    f.connection.close();
  }
});

test("a tool-free Execute response completes only with the stop finish reason", async (t) => {
  for (const finishReason of ["tool_calls", "unknown", "length", "content_filter", null] as const) {
    await t.test(String(finishReason), async () => {
      const f = await fixture(`finish-${String(finishReason)}`);
      const provider = new ScriptedProvider([
        response("Plan."),
        { ...response("Partial answer."), finishReason },
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
        notify: (notification) => { notifications.push(structuredClone(notification)); },
      });

      try {
        await assert.rejects(orchestrator.run({ sessionId: f.sessionId, prompt: "Explain it" }),
          (error: unknown) => error instanceof AgentRunError && /finish reason/i.test(error.message));
        assert.equal(f.store.loadSession(f.sessionId).session.status, "error");
        assert.equal(notifications.some((event) => event.method === "stream/commit"), false);
      } finally {
        f.connection.close();
      }
    });
  }
});

test("tool-free completion is accepted in the same write that finalizes its stream", async () => {
  const f = await fixture("atomic-final");
  const provider = new ScriptedProvider([response("Plan."), response("Done.")]);
  const finalize = f.store.finalizeStreamingAssistantMessage.bind(f.store);
  let statusAtFinalization: unknown;
  f.store.finalizeStreamingAssistantMessage = (input) => {
    const message = finalize(input);
    if (input.kind === "text" && (input.payload as { phase?: unknown }).phase === "execute") {
      statusAtFinalization = (message.payload as { candidateStatus?: unknown }).candidateStatus;
    }
    return message;
  };
  const orchestrator = new AgentOrchestrator({
    store: f.store, provider, tools: new ToolRegistry(), permissionClient: allowPermission, workspace: f.workspace,
    contextLimit: 32_768, maxOutputTokens: 4_096,
  });

  try {
    await orchestrator.run({ sessionId: f.sessionId, prompt: "Finish" });
    assert.equal(statusAtFinalization, "accepted");
  } finally {
    f.connection.close();
  }
});

test("a failed final commit notification rejects the durably finalized answer", async () => {
  const f = await fixture("commit-failure");
  const provider = new ScriptedProvider([response("Plan."), response("Done.")]);
  const orchestrator = new AgentOrchestrator({
    store: f.store, provider, tools: new ToolRegistry(), permissionClient: allowPermission, workspace: f.workspace,
    contextLimit: 32_768, maxOutputTokens: 4_096,
    notify(notification) {
      if (notification.method === "stream/commit") throw new Error("commit notification failed");
    },
  });

  try {
    await assert.rejects(orchestrator.run({ sessionId: f.sessionId, prompt: "Finish" }), /commit notification failed/);
    const final = f.store.loadSession(f.sessionId).messages.find((message) =>
      message.role === "assistant" && (message.payload as { text?: unknown }).text === "Done.");
    assert.equal((final?.payload as { candidateStatus?: unknown }).candidateStatus, "rejected");
    assert.equal(f.store.loadSession(f.sessionId).session.status, "error");
  } finally {
    f.connection.close();
  }
});

test("persists reasoning content and replays it across DeepSeek-style tool turns", async () => {
  const f = await fixture("reasoning-replay");
  const order: string[] = [];
  const registry = new ToolRegistry();
  registry.register(scriptedTool("alpha", order));
  const provider = new ScriptedProvider([
    response("Plan.", [], "plan reasoning"),
    response("", [{ id: "reason-call", name: "alpha", arguments: "{\"value\":\"A\"}" }], "tool reasoning"),
    response("Done.", [], "final reasoning"),
  ]);
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: registry,
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
    createRunId: () => "run-reasoning-replay",
  });

  try {
    await orchestrator.run({ sessionId: f.sessionId, prompt: "Inspect it" });
    const firstExecuteAssistants = provider.requests[1]!.messages.filter((message) => message.role === "assistant");
    assert.equal(firstExecuteAssistants.at(-1)?.reasoningContent, "plan reasoning");
    const secondExecuteAssistants = provider.requests[2]!.messages.filter((message) => message.role === "assistant");
    assert.equal(secondExecuteAssistants.at(-1)?.reasoningContent, "tool reasoning");

    const persisted = f.store.loadSession(f.sessionId).messages
      .filter((message) => message.role === "assistant")
      .map((message) => (message.payload as { reasoningContent?: unknown }).reasoningContent);
    assert.deepEqual(persisted, ["plan reasoning", "tool reasoning", "final reasoning"]);
    assert.equal(f.store.loadSession(f.sessionId).messages.some((message) => message.role === "internal"), false);
  } finally {
    f.connection.close();
  }
});

test("replays persisted reasoning and tool history after the database is reopened", async () => {
  const f = await fixture("reasoning-restart");
  const firstRegistry = new ToolRegistry();
  firstRegistry.register(scriptedTool("alpha", []));
  firstRegistry.register(scriptedTool("beta", []));
  const firstProvider = new ScriptedProvider([
    response("Plan.", [], "plan reasoning"),
    response("", [
      { id: "restart-alpha", name: "alpha", arguments: "{\"value\":\"A\"}" },
      { id: "restart-beta", name: "beta", arguments: "{\"value\":\"B\"}" },
    ], "tool reasoning"),
    response("Done.", [], "final reasoning"),
  ]);
  await new AgentOrchestrator({
    store: f.store,
    provider: firstProvider,
    tools: firstRegistry,
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  }).run({ sessionId: f.sessionId, prompt: "First run" });
  f.connection.close();

  const reopened = await openDatabase({ env: { AWACODE_DATA_DIR: f.dataRoot } });
  const secondProvider = new ScriptedProvider([
    response("Next plan.", [], "next plan reasoning"),
    response("Still done.", [], "next answer reasoning"),
  ]);
  const secondRegistry = new ToolRegistry();
  secondRegistry.register(scriptedTool("alpha", []));
  secondRegistry.register(scriptedTool("beta", []));
  try {
    await new AgentOrchestrator({
      store: new SessionStore(reopened.db),
      provider: secondProvider,
      tools: secondRegistry,
      permissionClient: allowPermission,
      workspace: f.workspace,
      contextLimit: 32_768,
      maxOutputTokens: 4_096,
    }).run({ sessionId: f.sessionId, prompt: "Continue after restart" });

    const replayed = secondProvider.requests[1]!.messages;
    const replayedToolBlock = replayed.find((message) => message.role === "assistant"
      && message.reasoningContent === "tool reasoning");
    assert.ok(replayedToolBlock?.role === "assistant");
    assert.deepEqual(replayedToolBlock.toolCalls.map((call) => call.id), ["restart-alpha", "restart-beta"]);
    assert.deepEqual(replayed
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId), ["restart-alpha", "restart-beta"]);
  } finally {
    reopened.close();
  }
});

test("unknown, invalid, and denied tool calls each persist exactly one terminal result", async () => {
  const f = await fixture("tool-failures");
  await writeFile(join(f.workspace.rootPath, "demo.txt"), "old", "utf8");
  const registry = new ToolRegistry();
  registry.register(scriptedTool("alpha", []));
  registry.register(runCommandTool);
  const provider = new ScriptedProvider([
    response("Plan."),
    response("", [
      { id: "unknown", name: "missing_tool", arguments: "{}" },
      { id: "malformed", name: "alpha", arguments: "{" },
      { id: "invalid", name: "alpha", arguments: "{\"wrong\":true}" },
      { id: "denied", name: "run_command", arguments: "{\"command\":\"echo never\"}" },
    ]),
    response("No changes were made."),
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

test("Execute auto-allows file edits and creates without calling the external permission client", async () => {
  const f = await fixture("auto-allow-edit");
  await writeFile(join(f.workspace.rootPath, "demo.txt"), "before old after", "utf8");
  const registry = new ToolRegistry();
  registry.register(editFileTool);
  registry.register(writeFileTool);
  const provider = new ScriptedProvider([
    response("Replace the requested text."),
    response("", [
      {
        id: "auto-edit",
        name: "edit_file",
        arguments: "{\"path\":\"demo.txt\",\"old_text\":\"old\",\"new_text\":\"new\"}",
      },
      {
        id: "auto-create",
        name: "write_file",
        arguments: "{\"path\":\"created.txt\",\"content\":\"created\"}",
      },
    ]),
    response("The file was updated."),
  ]);
  let externalPermissionRequests = 0;
  const orchestrator = new AgentOrchestrator({
    store: f.store,
    provider,
    tools: registry,
    permissionClient: {
      async requestPermission() {
        externalPermissionRequests += 1;
        throw new Error("write approval must be automatic");
      },
    },
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });

  try {
    const result = await orchestrator.run({ sessionId: f.sessionId, prompt: "Edit demo.txt" });
    assert.equal(result.status, "completed");
    assert.equal(externalPermissionRequests, 0);
    assert.equal(await readFile(join(f.workspace.rootPath, "demo.txt"), "utf8"), "before new after");
    assert.equal(await readFile(join(f.workspace.rootPath, "created.txt"), "utf8"), "created");
    assert.equal(f.store.loadToolCall("auto-edit").status, "success");
    assert.equal(f.store.loadToolCall("auto-create").status, "success");
  } finally {
    f.connection.close();
  }
});

test("cancellation interrupts an awaiting approval, settles the call, and never auto-replays it", async () => {
  const f = await fixture("cancel");
  await writeFile(join(f.workspace.rootPath, "demo.txt"), "old", "utf8");
  const registry = new ToolRegistry();
  registry.register(runCommandTool);
  const provider = new ScriptedProvider([
    response("Plan."),
    response("", [{
      id: "cancelled-command",
      name: "run_command",
      arguments: "{\"command\":\"echo never\"}",
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
      ["cancelled-command", "interrupted", true],
    ]);
    assert.equal(loaded.messages.filter((message) => message.status === "streaming").length, 0);
    assert.equal(await readFile(join(f.workspace.rootPath, "demo.txt"), "utf8"), "old");
  } finally {
    f.connection.close();
  }
});

test("a run atomically binds non-secret model metadata to its session and persisted messages", async () => {
  const f = await fixture("model-binding");
  const provider = new ScriptedProvider([
    response("Plan."), response("Candidate."),
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
      (error: unknown) => error instanceof Error && error.message === "Plan returned an unavailable tool call.");
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
          : response("second candidate");
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

test("Plan reaching the global tool limit closes with one no-tools summary instead of failing the run", async () => {
  const f = await fixture("plan-tool-limit");
  const registry = new ToolRegistry();
  registry.register(scriptedTool("list_files", []));
  const calls = Array.from({ length: 25 }, (_, index) => ({
    id: `plan-tool-${index + 1}`,
    name: "list_files",
    arguments: `{"value":"${index + 1}"}`,
  }));
  const provider = new ScriptedProvider([
    response("", calls),
    response("Stopped at the tool limit after reporting completed and unfinished work."),
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
    const result = await orchestrator.run({ sessionId: f.sessionId, prompt: "Inspect many files" });
    assert.deepEqual({
      finalText: result.finalText,
      status: result.status,
      reason: result.reason,
      modelTurns: result.modelTurns,
      toolCalls: result.toolCalls,
    }, {
      finalText: "Stopped at the tool limit after reporting completed and unfinished work.",
      status: "completed",
      reason: "tool_call_limit",
      modelTurns: 2,
      toolCalls: 24,
    });
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests[1]!.tools, undefined);
    assert.match(provider.requests[1]!.messages.at(-1)!.content as string, /completed work/i);
    assert.match(provider.requests[1]!.messages.at(-1)!.content as string, /unfinished work/i);
    assert.match(provider.requests[1]!.messages.at(-1)!.content as string, /tool_call_limit/);
    const persisted = f.store.loadSession(f.sessionId).toolCalls;
    assert.equal(persisted.length, 25);
    assert.equal(persisted[23]!.status, "success");
    assert.equal(persisted[24]!.status, "failure");
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

test("provider context overflow compacts through active completed tools and retries with one verbatim current user", async () => {
  const f = await fixture("overflow-retry");
  f.store.insertMessage({ sessionId: f.sessionId, role: "assistant", kind: "text", payload: { text: "older context" } });
  const order: string[] = [];
  const registry = new ToolRegistry();
  registry.register(scriptedTool("alpha", order));
  const requests: ModelStreamRequest[] = [];
  const script: Array<AssistantModelMessage | Error> = [
    response("Plan."),
    response("", [{ id: "active-tool", name: "alpha", arguments: "{\"value\":\"evidence\"}" }]),
    new ModelContextOverflowError(),
    response("Goal: finish the request. Current state: tool evidence collected."),
    response("Candidate complete."),
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
    tools: registry,
    permissionClient: allowPermission,
    workspace: f.workspace,
    contextLimit: 32_768,
    maxOutputTokens: 4_096,
  });
  try {
    const result = await orchestrator.run({ sessionId: f.sessionId, prompt: "Do it" });
    assert.equal(result.status, "completed");
    assert.equal(requests.length, 5);
    assert.match(requests[3]?.messages[0]?.content ?? "", /structured rolling summary/i);
    assert.equal(requests[3]?.maxOutputTokens, 4_096);
    assert.ok(requests[3]?.messages.some((message) => message.role === "assistant"
      && message.toolCalls?.some((call) => call.name === "alpha")));
    assert.ok(requests[3]?.messages.some((message) => message.role === "tool" && message.toolCallId === "active-tool"));
    const toolMessage = f.store.loadSession(f.sessionId).messages.find((message) => message.kind === "tool_calls");
    assert.ok(toolMessage);
    assert.equal(f.store.loadContextSnapshot(f.sessionId)?.summaryUptoSeq, toolMessage.seq);
    assert.equal(f.store.loadContextSnapshot(f.sessionId)?.summary, "Goal: finish the request. Current state: tool evidence collected.");
    assert.ok(requests[4]?.messages.some((message) => message.role === "system" && message.content.includes("Conversation summary")));
    assert.equal(requests[4]?.messages.filter((message) => message.role === "user" && message.content === "Do it").length, 1);
  } finally {
    f.connection.close();
  }
});

test("a second provider overflow after compression fails explicitly without a third original attempt", async () => {
  const f = await fixture("overflow-twice");
  f.store.insertMessage({ sessionId: f.sessionId, role: "assistant", kind: "text", payload: { text: "older context" } });
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
