import { randomUUID } from "node:crypto";

import { ContextCompressionError, ContextManager, SUMMARY_SYSTEM_PROMPT, type BuildContextInput } from "../context/context-manager.ts";
import type {
  AssistantModelMessage,
  FunctionToolDefinition,
  ModelProvider,
} from "../llm/types.ts";
import { ModelContextOverflowError } from "../llm/types.ts";
import type { MessageRecord, SessionStore, SessionStatus } from "../persistence/session-store.ts";
import type { MemoryStore } from "../memory/memory-store.ts";
import type { WorkspaceGuard } from "../security/workspace-guard.ts";
import { HistoryIntegrityError, prepareProviderHistory, validateProviderHistory } from "../session/history.ts";
import { transitionToolCall } from "../session/tool-call-state.ts";
import type { ToolContext, ToolDefinition, ToolResult } from "../tools/contracts.ts";
import type { PermissionClient } from "../tools/permission.ts";
import { ToolRegistry, ToolRegistryError } from "../tools/registry.ts";

export type AgentPhase = "plan" | "execute" | "closing";
export type AgentTerminalStatus = "completed" | "cancelled" | "error";
export type AgentStatusNotificationStatus = "busy" | "done" | "cancelled" | "error";

interface EventBase {
  runId: string;
  eventSeq: number;
}

export type AgentNotification =
  | { method: "agent/phase"; params: EventBase & { phase: AgentPhase } }
  | { method: "stream/text"; params: EventBase & { messageId: string; phase: AgentPhase; delta: string; provisional: boolean } }
  | { method: "stream/commit"; params: EventBase & { messageId: string } }
  | { method: "tool/start"; params: EventBase & { callId: string; ordinal: number; name: string } }
  | { method: "memory/updated"; params: EventBase & { scope: "global" | "project"; operation: string; characters: number } }
  | {
    method: "tool/end";
    params: EventBase & {
      callId: string;
      ordinal: number;
      name: string;
      status: ToolResult["status"];
      durationMs: number;
      summary: string;
      content: string;
      metadata: Record<string, unknown>;
    };
  }
  | { method: "agent/status"; params: EventBase & { status: AgentStatusNotificationStatus; reason: string } };

export interface AgentRunInput {
  readonly sessionId: string;
  readonly prompt: string;
}

export interface AgentRunResult {
  readonly runId: string;
  readonly finalText: string;
  readonly status: AgentTerminalStatus;
  readonly reason: string;
  readonly modelTurns: number;
  readonly toolCalls: number;
}

export interface AgentOrchestratorOptions {
  readonly store: SessionStore;
  readonly provider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly permissionClient: PermissionClient;
  readonly workspace: WorkspaceGuard;
  readonly contextLimit: number;
  readonly maxOutputTokens: number;
  readonly systemPrompt?: string;
  readonly modelMetadata?: { readonly model: string; readonly contextLimit: number; readonly maxOutputTokens: number };
  readonly contextManager?: ContextManager;
  readonly memory?: { store: MemoryStore; projectId: string };
  readonly createRunId?: () => string;
  readonly now?: () => number;
  readonly notify?: (notification: AgentNotification) => void | Promise<void>;
}

export class AgentBusyError extends Error {
  readonly code = "busy" as const;
  constructor() {
    super("Another agent run is active.");
    this.name = "AgentBusyError";
  }
}

export class AgentCancelledError extends Error {
  readonly code = "cancelled" as const;
  readonly result: AgentRunResult;
  constructor(result: AgentRunResult) {
    super("Agent run was cancelled.");
    this.name = "AgentCancelledError";
    this.result = result;
  }
}

export class AgentRunError extends Error {
  readonly code = "agent_run_error" as const;
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "AgentRunError";
  }
}

interface StreamedTurn {
  readonly message: MessageRecord;
  readonly response: AssistantModelMessage;
}

interface ExecuteOutcome {
  readonly turn: StreamedTurn;
  readonly stopReason: "execute_turn_limit" | "tool_call_limit" | "repeated_tool_call" | null;
}

const PLAN_PROMPT = "Inspect the workspace with the available read-only tools when useful, then return a concise actionable plan.";
const EXECUTE_PROMPT = "Execute the coding task using tools when useful. Return the final answer when work is complete.";
const PLAN_TOOL_NAMES = new Set(["list_files", "read_file", "search_text"]);
const MAX_PLAN_TURNS = 12;
const MAX_EXECUTE_TURNS = 12;
const MAX_TOOL_EXECUTIONS = 24;
const DEFAULT_SYSTEM_PROMPT = "You are AwaCode, a careful coding agent. Call memory_write only when the current user explicitly asks to remember, update, or forget information. Never infer or automatically write memory. Default unspecified memory scope to project; use global only for explicit cross-project preferences.";
const PLAIN_TEXT_SYSTEM_PROMPT = "All user-facing prose must be plain text. Do not use Markdown syntax, including headings, bullets, numbered lists, emphasis, block quotes, links, tables, or fenced code blocks.";
const AUTO_ALLOW_WRITE_PERMISSION: PermissionClient = {
  async requestPermission(request) {
    if (request.kind !== "write") {
      throw new TypeError("Only write permissions can be auto-allowed.");
    }
    return "allow_once";
  },
};

function isContextOverflow(error: unknown): boolean {
  return error instanceof ModelContextOverflowError
    || (typeof error === "object" && error !== null && "code" in error && error.code === "context_overflow");
}

function toolDefinitions(registry: ToolRegistry, allowedNames?: ReadonlySet<string>): FunctionToolDefinition[] {
  return registry.list().filter((tool) => allowedNames === undefined || allowedNames.has(tool.name)).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function failureResult(summary: string, code: string): ToolResult {
  return {
    status: "failure",
    summary,
    content: summary,
    durationMs: 0,
    metadata: { error: code, sideEffects: "none" },
  };
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, stableJson((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function canonicalToolCall(name: string, argumentsText: string): string {
  try {
    return JSON.stringify({ name, arguments: stableJson(JSON.parse(argumentsText)) });
  } catch {
    return JSON.stringify({ name, arguments: argumentsText });
  }
}

export class AgentOrchestrator {
  private readonly options: AgentOrchestratorOptions;
  private readonly contextManager: ContextManager;
  private active: AbortController | undefined;
  private activeRunId: string | undefined;
  private eventSeq = 0;
  private notificationQueue: Promise<void> = Promise.resolve();
  private modelTurns = 0;
  private executedToolCalls = 0;
  private executeTurns = 0;
  private previousCanonicalCall: string | undefined;
  private consecutiveCanonicalCalls = 0;

  constructor(options: AgentOrchestratorOptions) {
    this.options = options;
    this.contextManager = options.contextManager ?? new ContextManager(options.store, {
      summaryGenerator: async (request) => {
        this.modelTurns += 1;
        const response = await this.options.provider.stream({
          messages: [
            { role: "system", content: SUMMARY_SYSTEM_PROMPT },
            ...(request.previousSummary === null
              ? []
              : [{ role: "system" as const, content: `Previous rolling summary:\n${request.previousSummary}` }]),
            ...request.messages,
          ],
          maxOutputTokens: request.maxOutputTokens,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (response.toolCalls.length > 0) {
          throw new Error("Summary generation returned tool calls.");
        }
        return response.content;
      },
    });
  }

  cancel(): boolean {
    if (this.active === undefined) {
      return false;
    }
    this.active.abort(new Error("cancelled"));
    return true;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.active !== undefined) {
      throw new AgentBusyError();
    }
    const controller = new AbortController();
    const runId = this.options.createRunId?.() ?? randomUUID();
    this.notificationQueue = Promise.resolve();
    this.active = controller;
    this.activeRunId = runId;
    this.eventSeq = 0;
    this.modelTurns = 0;
    this.executedToolCalls = 0;
    this.executeTurns = 0;
    this.previousCanonicalCall = undefined;
    this.consecutiveCanonicalCalls = 0;
    let finalText = "";
    let sessionLoaded = false;
    let finalMessageId: string | undefined;
    try {
      this.options.store.loadSession(input.sessionId);
      sessionLoaded = true;
      prepareProviderHistory(this.options.store, input.sessionId);
      if (this.options.modelMetadata !== undefined) {
        this.options.store.bindSessionModel(input.sessionId, this.options.modelMetadata);
      }
      const user = this.options.store.insertMessage({
        sessionId: input.sessionId,
        role: "user",
        kind: "text",
        payload: this.messagePayload(input.prompt, "user"),
      });
      this.options.store.setSessionStatus(input.sessionId, "running");
      await this.status("busy", "run_started");

      await this.phase("plan");
      await this.planUntilReady(input.sessionId, user.id);

      await this.phase("execute");
      const execution = await this.executeUntilFinal(input.sessionId, user.id);
      const finalTurn = execution.turn;
      finalText = finalTurn.response.content;
      if (execution.stopReason !== null) {
        const result = this.result(runId, finalText, "completed", execution.stopReason);
        this.options.store.setSessionStatus(input.sessionId, "completed");
        await this.status("done", result.reason);
        return result;
      }
      finalMessageId = finalTurn.message.id;
      await this.commit(finalTurn.message.id);
      const result = this.result(runId, finalText, "completed", "model_stop");
      this.options.store.setSessionStatus(input.sessionId, "completed");
      await this.status("done", result.reason);
      return result;
    } catch (error) {
      if (!sessionLoaded) {
        throw error;
      }
      if (finalMessageId !== undefined) {
        try { this.options.store.setAssistantCandidateStatus(finalMessageId, "rejected"); } catch { /* Preserve the original failure. */ }
      }
      this.options.store.interruptSessionState(input.sessionId);
      if (controller.signal.aborted) {
        const result = this.result(runId, finalText, "cancelled", "cancelled");
        this.options.store.setSessionStatus(input.sessionId, "cancelled");
        await this.status("cancelled", result.reason).catch(() => undefined);
        throw new AgentCancelledError(result);
      }
      this.options.store.setSessionStatus(input.sessionId, "error");
      await this.status("error", error instanceof HistoryIntegrityError ? error.code : "agent_run_error")
        .catch(() => undefined);
      throw error;
    } finally {
      try {
        await this.notificationQueue.catch(() => undefined);
      } finally {
        this.active = undefined;
        this.activeRunId = undefined;
      }
    }
  }

  private result(runId: string, finalText: string, status: AgentTerminalStatus, reason: string): AgentRunResult {
    return { runId, finalText, status, reason, modelTurns: this.modelTurns, toolCalls: this.executedToolCalls };
  }

  private async planUntilReady(sessionId: string, currentUserMessageId: string): Promise<void> {
    const definitions = toolDefinitions(this.options.tools, PLAN_TOOL_NAMES);
    const availableNames = new Set(definitions.map((definition) => definition.function.name));
    for (let turnNumber = 1; turnNumber <= MAX_PLAN_TURNS; turnNumber += 1) {
      const plan = await this.providerTurn(
        sessionId,
        currentUserMessageId,
        "plan",
        definitions,
        PLAN_PROMPT,
        false,
      );
      if (plan.response.toolCalls.length === 0) {
        if (plan.response.finishReason !== "stop") {
          throw new AgentRunError(`Plan response ended with unsupported finish reason: ${plan.response.finishReason ?? "missing"}.`);
        }
        this.options.store.finalizeStreamingAssistantMessage({
          messageId: plan.message.id,
          kind: "plan",
          payload: this.messagePayload(plan.response.content, "plan", this.reasoningPayload(plan.response)),
        });
        return;
      }
      if (plan.response.toolCalls.some((call) => !availableNames.has(call.name))) {
        await this.persistRejectedToolCalls(plan, sessionId, "Only advertised read-only tools are allowed during Plan.");
        throw new AgentRunError("Plan returned an unavailable tool call.");
      }
      this.options.store.finalizeStreamingAssistantWithToolCalls({
        messageId: plan.message.id,
        payload: this.messagePayload(plan.response.content, "plan", this.reasoningPayload(plan.response)),
        toolCalls: plan.response.toolCalls.map((call, ordinal) => ({
          callId: call.id,
          ordinal,
          toolName: call.name,
          inputText: call.arguments,
        })),
      });
      let limitReached = false;
      for (const [ordinal, call] of plan.response.toolCalls.entries()) {
        if (this.executedToolCalls >= MAX_TOOL_EXECUTIONS) {
          limitReached = true;
          await this.settleNonExecuted(call.id, ordinal, call.name, "tool_call_limit");
          continue;
        }
        await this.executeTool(sessionId, call.id, ordinal, call.name, call.arguments);
      }
      if (limitReached) {
        throw new AgentRunError("Plan reached the tool call limit.");
      }
    }
    throw new AgentRunError("Plan reached the model turn limit.");
  }

  private async executeUntilFinal(
    sessionId: string,
    currentUserMessageId: string,
  ): Promise<ExecuteOutcome> {
    while (true) {
      if (this.executeTurns >= MAX_EXECUTE_TURNS) {
        return { turn: await this.closingTurn(sessionId, currentUserMessageId, "execute_turn_limit"), stopReason: "execute_turn_limit" };
      }
      this.executeTurns += 1;
      const turn = await this.providerTurn(
        sessionId,
        currentUserMessageId,
        "execute",
        toolDefinitions(this.options.tools),
        EXECUTE_PROMPT,
        true,
      );
      if (turn.response.toolCalls.length === 0) {
        if (turn.response.finishReason !== "stop") {
          throw new AgentRunError(`Execute response ended with unsupported finish reason: ${turn.response.finishReason ?? "missing"}.`);
        }
        this.options.store.finalizeStreamingAssistantMessage({
          messageId: turn.message.id,
          kind: "text",
          payload: this.messagePayload(turn.response.content, "execute", {
            candidateStatus: "accepted",
            ...this.reasoningPayload(turn.response),
          }),
        });
        return { turn, stopReason: null };
      }
      this.options.store.finalizeStreamingAssistantWithToolCalls({
        messageId: turn.message.id,
        payload: this.messagePayload(turn.response.content, "execute", this.reasoningPayload(turn.response)),
        toolCalls: turn.response.toolCalls.map((call, ordinal) => ({
          callId: call.id,
          ordinal,
          toolName: call.name,
          inputText: call.arguments,
        })),
      });
      let stopReason: ExecuteOutcome["stopReason"] = null;
      for (const [ordinal, call] of turn.response.toolCalls.entries()) {
        const canonical = canonicalToolCall(call.name, call.arguments);
        if (canonical === this.previousCanonicalCall) {
          this.consecutiveCanonicalCalls += 1;
        } else {
          this.previousCanonicalCall = canonical;
          this.consecutiveCanonicalCalls = 1;
        }
        if (stopReason !== null) {
          await this.settleNonExecuted(call.id, ordinal, call.name, stopReason);
        } else if (this.consecutiveCanonicalCalls >= 3) {
          stopReason = "repeated_tool_call";
          await this.settleNonExecuted(call.id, ordinal, call.name, stopReason);
        } else if (this.executedToolCalls >= MAX_TOOL_EXECUTIONS) {
          stopReason = "tool_call_limit";
          await this.settleNonExecuted(call.id, ordinal, call.name, stopReason);
        } else {
          await this.executeTool(sessionId, call.id, ordinal, call.name, call.arguments);
        }
      }
      if (stopReason === null && this.executedToolCalls >= MAX_TOOL_EXECUTIONS) {
        stopReason = "tool_call_limit";
      }
      if (stopReason === null && this.executeTurns >= MAX_EXECUTE_TURNS) {
        stopReason = "execute_turn_limit";
      }
      if (stopReason !== null) {
        return { turn: await this.closingTurn(sessionId, currentUserMessageId, stopReason), stopReason };
      }
    }
  }

  private async settleNonExecuted(
    callId: string,
    ordinal: number,
    name: string,
    reason: Exclude<ExecuteOutcome["stopReason"], null>,
  ): Promise<void> {
    await this.emit("tool/start", { callId, ordinal, name });
    const result = failureResult("Tool call was not executed because the agent reached a safety bound.", reason);
    transitionToolCall(this.options.store, {
      callId,
      expectedStatus: "pending",
      status: "failure",
      result,
    });
    await this.toolEnd(callId, ordinal, name, result);
  }

  private async closingTurn(
    sessionId: string,
    currentUserMessageId: string,
    reason: Exclude<ExecuteOutcome["stopReason"], null>,
  ): Promise<StreamedTurn> {
    await this.phase("closing");
    const instruction = `Tools are disabled because execution stopped with ${reason}. State completed work, unfinished work, and the stop reason.`;
    const closing = await this.providerTurn(sessionId, currentUserMessageId, "closing", [], instruction, true);
    if (closing.response.toolCalls.length > 0) {
      await this.persistRejectedToolCalls(closing, sessionId, "Tools are disabled during closing.");
      throw new AgentRunError("Closing response returned unexpected tool calls.");
    }
    this.options.store.finalizeStreamingAssistantMessage({
      messageId: closing.message.id,
      kind: "text",
      payload: this.messagePayload(closing.response.content, "closing", {
        stopReason: reason,
        candidateStatus: "accepted",
        ...this.reasoningPayload(closing.response),
      }),
    });
    await this.commit(closing.message.id);
    return closing;
  }

  private async executeTool(
    _sessionId: string,
    callId: string,
    ordinal: number,
    name: string,
    argumentsText: string,
  ): Promise<ToolResult> {
    await this.emit("tool/start", { callId, ordinal, name });
    let definition: ToolDefinition<unknown>;
    let input: unknown;
    try {
      definition = this.options.tools.get(name);
      input = definition.validate(JSON.parse(argumentsText));
    } catch (error) {
      const result = failureResult(
        error instanceof ToolRegistryError ? "Unknown tool." : "Tool input is invalid.",
        error instanceof ToolRegistryError ? "unknown_tool" : "invalid_tool_input",
      );
      transitionToolCall(this.options.store, {
        callId,
        expectedStatus: "pending",
        status: "failure",
        result,
      });
      await this.toolEnd(callId, ordinal, name, result);
      return result;
    }
    this.executedToolCalls += 1;
    const context: ToolContext = {
      workspace: this.options.workspace,
      signal: this.active!.signal,
      now: this.options.now ?? (() => Date.now()),
      ...(definition.approval === "none" ? {} : {
        approvedToolRuntime: {
          callId,
          store: this.options.store,
          permissionClient: definition.approval === "write"
            ? AUTO_ALLOW_WRITE_PERMISSION
            : this.options.permissionClient,
        },
      }),
      ...(this.options.memory === undefined ? {} : { memoryRuntime: this.options.memory }),
    };
    let result: ToolResult;
    if (definition.approval === "none") {
      transitionToolCall(this.options.store, { callId, expectedStatus: "pending", status: "running" });
      try {
        result = await definition.execute(input, context);
      } catch {
        result = failureResult("Tool execution failed.", "tool_execution_failed");
      }
      transitionToolCall(this.options.store, {
        callId,
        expectedStatus: "running",
        status: result.status,
        result,
      });
    } else {
      result = await definition.execute(input, context);
    }
    await this.toolEnd(callId, ordinal, name, result);
    if (
      name === "memory_write"
      && result.status === "success"
      && (result.metadata.scope === "global" || result.metadata.scope === "project")
      && typeof result.metadata.operation === "string"
      && typeof result.metadata.characters === "number"
    ) {
      await this.emit("memory/updated", {
        scope: result.metadata.scope,
        operation: result.metadata.operation,
        characters: result.metadata.characters,
      });
    }
    return result;
  }

  private async providerTurn(
    sessionId: string,
    currentUserMessageId: string,
    phase: AgentPhase,
    tools: readonly FunctionToolDefinition[],
    instruction: string,
    provisional: boolean,
    protectedMessageIds: readonly string[] = [currentUserMessageId],
  ): Promise<StreamedTurn> {
    const history = validateProviderHistory(this.options.store, sessionId);
    let memory;
    if (this.options.memory !== undefined) {
      try {
        memory = await this.options.memory.store.read(this.options.memory.projectId);
      } catch {
        memory = null;
      }
    }
    const buildInput: BuildContextInput = {
      sessionId,
      history,
      currentUserMessageId,
      protectedMessageIds,
      systemText: `${this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT}\n${PLAIN_TEXT_SYSTEM_PROMPT}`,
      transientSystemText: instruction,
      tools,
      contextLimit: this.options.contextLimit,
      maxOutputTokens: this.options.maxOutputTokens,
      ...(memory === undefined ? {} : { memory }),
      signal: this.active!.signal,
    };
    let built = await this.contextManager.build(buildInput);
    const message = this.options.store.createStreamingAssistantMessage({
      sessionId,
      kind: phase,
      payload: this.messagePayload("", phase),
    });
    let compressedRetry = false;
    try {
      while (true) {
        try {
          this.modelTurns += 1;
          const response = await this.options.provider.stream({
            messages: built.messages,
            ...(tools.length === 0 ? {} : { tools }),
            signal: this.active!.signal,
            onTextDelta: (delta) => {
              void this.emit("stream/text", {
                messageId: message.id,
                phase,
                delta,
                provisional,
              }).catch(() => undefined);
            },
          });
          await this.notificationQueue;
          return { message, response };
        } catch (error) {
          if (!isContextOverflow(error)) {
            throw error;
          }
          if (compressedRetry) {
            throw new ContextCompressionError("context_overflow_after_compression", { cause: error });
          }
          const compressed = await this.contextManager.compressForOverflow(buildInput);
          if (!compressed) {
            throw new ContextCompressionError("context_overflow_after_compression", { cause: error });
          }
          compressedRetry = true;
          built = await this.contextManager.build(buildInput);
        }
      }
    } catch (error) {
      this.options.store.interruptStreamingAssistantMessage(message.id);
      throw error;
    }
  }

  private messagePayload(text: string, phase: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      text,
      phase,
      ...extra,
      ...(this.activeRunId === undefined ? {} : { runId: this.activeRunId }),
      ...(this.options.modelMetadata === undefined ? {} : { model: this.options.modelMetadata.model }),
    };
  }

  private reasoningPayload(response: AssistantModelMessage): Record<string, string> {
    return response.reasoningContent === undefined ? {} : { reasoningContent: response.reasoningContent };
  }

  private async persistRejectedToolCalls(turn: StreamedTurn, _sessionId: string, message: string): Promise<void> {
    this.options.store.finalizeStreamingAssistantWithToolCalls({
      messageId: turn.message.id,
      payload: { text: turn.response.content, phase: turn.message.kind, ...this.reasoningPayload(turn.response) },
      toolCalls: turn.response.toolCalls.map((call, ordinal) => ({
        callId: call.id,
        ordinal,
        toolName: call.name,
        inputText: call.arguments,
      })),
    });
    for (const call of turn.response.toolCalls) {
      transitionToolCall(this.options.store, {
        callId: call.id,
        expectedStatus: "pending",
        status: "failure",
        result: failureResult(message, "tool_not_allowed"),
      });
    }
  }

  private async phase(phase: AgentPhase): Promise<void> {
    await this.emit("agent/phase", { phase });
  }

  private async commit(messageId: string): Promise<void> {
    await this.emit("stream/commit", { messageId });
  }

  private async toolEnd(
    callId: string,
    ordinal: number,
    name: string,
    result: ToolResult,
  ): Promise<void> {
    await this.emit("tool/end", {
      callId,
      ordinal,
      name,
      status: result.status,
      durationMs: result.durationMs,
      summary: result.summary,
      content: result.content,
      metadata: result.metadata,
    });
  }

  private async status(status: AgentStatusNotificationStatus, reason: string): Promise<void> {
    await this.emit("agent/status", { status, reason });
  }

  private emit(
    method: AgentNotification["method"],
    params: Omit<AgentNotification["params"], "runId" | "eventSeq">,
  ): Promise<void> {
    const notification = {
      method,
      params: {
        ...params,
        runId: this.activeRunId!,
        eventSeq: ++this.eventSeq,
      },
    } as AgentNotification;
    const send = this.options.notify;
    this.notificationQueue = this.notificationQueue.then(async () => {
      await send?.(notification);
    });
    return this.notificationQueue;
  }
}
