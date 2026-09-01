import { randomUUID } from "node:crypto";

import { ContextCompressionError, ContextManager, type BuildContextInput } from "../context/context-manager.ts";
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

export type AgentPhase = "plan" | "execute" | "reflect" | "closing";
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

const PLAN_PROMPT = "Plan the requested coding task. Do not call tools. Return a concise actionable plan.";
const EXECUTE_PROMPT = "Execute the coding task using tools when useful. Return a candidate final answer when work is complete.";
const REFLECT_PROMPT = 'Review the candidate. Return exactly {"status":"complete"|"continue","reason":string}. Do not call tools.';
const REFLECT_CORRECTION_PROMPT = 'The previous Reflect output was invalid or malformed. Return only the exact JSON object {"status":"complete"|"continue","reason":string}. Do not call tools.';
const MAX_EXECUTE_TURNS = 12;
const MAX_TOOL_EXECUTIONS = 24;
const DEFAULT_SYSTEM_PROMPT = "You are AwaCode, a careful coding agent. Call memory_write only when the current user explicitly asks to remember, update, or forget information. Never infer or automatically write memory. Default unspecified memory scope to project; use global only for explicit cross-project preferences.";
const SUMMARY_PROMPT = "Generate a structured rolling summary of the conversation. Cover: goal; constraints and decisions; completed work; current state; blockers; next steps; relevant files. Replace, do not merely append to, any previous summary. Do not call tools.";

function isContextOverflow(error: unknown): boolean {
  return error instanceof ModelContextOverflowError
    || (typeof error === "object" && error !== null && "code" in error && error.code === "context_overflow");
}

function toolDefinitions(registry: ToolRegistry): FunctionToolDefinition[] {
  return registry.list().map((tool) => ({
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

function parseReflect(text: string): { status: "complete" | "continue"; reason: string } | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.keys(value).length !== 2
      || !Object.hasOwn(value, "status")
      || !Object.hasOwn(value, "reason")
    ) {
      return null;
    }
    const record = value as { status?: unknown; reason?: unknown };
    return (record.status === "complete" || record.status === "continue") && typeof record.reason === "string"
      ? { status: record.status, reason: record.reason }
      : null;
  } catch {
    return null;
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
            { role: "system", content: SUMMARY_PROMPT },
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
    try {
      this.options.store.loadSession(input.sessionId);
      sessionLoaded = true;
      prepareProviderHistory(this.options.store, input.sessionId);
      const user = this.options.store.insertMessage({
        sessionId: input.sessionId,
        role: "user",
        kind: "text",
        payload: { text: input.prompt, phase: "user" },
      });
      this.options.store.setSessionStatus(input.sessionId, "running");
      await this.status("busy", "run_started");

      await this.phase("plan");
      const plan = await this.providerTurn(input.sessionId, user.id, "plan", [], PLAN_PROMPT, false);
      if (plan.response.toolCalls.length > 0) {
        await this.persistRejectedToolCalls(plan, input.sessionId, "Tools are not allowed during Plan.");
        throw new AgentRunError("Plan returned unexpected tool calls.");
      }
      this.options.store.finalizeStreamingAssistantMessage({
        messageId: plan.message.id,
        kind: "plan",
        payload: { text: plan.response.content, phase: "plan" },
      });

      await this.phase("execute");
      const execution = await this.executeUntilCandidate(input.sessionId, user.id, false);
      const candidate = execution.turn;
      finalText = candidate.response.content;
      if (execution.stopReason !== null) {
        const result = this.result(runId, finalText, "completed", execution.stopReason);
        this.options.store.setSessionStatus(input.sessionId, "completed");
        await this.status("done", result.reason);
        return result;
      }

      await this.phase("reflect");
      const reflected = await this.providerTurn(input.sessionId, user.id, "reflect", [], REFLECT_PROMPT, false);
      if (reflected.response.toolCalls.length > 0) {
        await this.persistRejectedToolCalls(reflected, input.sessionId, "Tools are not allowed during Reflect.");
        throw new AgentRunError("Reflect returned unexpected tool calls.");
      }
      this.options.store.finalizeStreamingAssistantMessage({
        messageId: reflected.message.id,
        role: "internal",
        kind: "reflect",
        payload: { text: reflected.response.content, phase: "reflect" },
      });
      let decision = parseReflect(reflected.response.content);
      if (decision === null) {
        const corrected = await this.providerTurn(
          input.sessionId,
          user.id,
          "reflect",
          [],
          REFLECT_CORRECTION_PROMPT,
          false,
        );
        if (corrected.response.toolCalls.length > 0) {
          await this.persistRejectedToolCalls(corrected, input.sessionId, "Tools are not allowed during Reflect.");
          throw new AgentRunError("Reflect returned unexpected tool calls.");
        }
        this.options.store.finalizeStreamingAssistantMessage({
          messageId: corrected.message.id,
          role: "internal",
          kind: "reflect",
          payload: { text: corrected.response.content, phase: "reflect" },
        });
        decision = parseReflect(corrected.response.content);
        if (decision === null) {
          throw new AgentRunError("Reflect output was malformed twice.");
        }
      }
      if (decision.status === "continue") {
        await this.phase("execute");
        const remedialExecution = await this.executeUntilCandidate(input.sessionId, user.id, true);
        const remedial = remedialExecution.turn;
        finalText = remedial.response.content;
        if (remedialExecution.stopReason !== null) {
          const result = this.result(runId, finalText, "completed", remedialExecution.stopReason);
          this.options.store.setSessionStatus(input.sessionId, "completed");
          await this.status("done", result.reason);
          return result;
        }
        await this.commit(remedial.message.id);
      } else {
        await this.commit(candidate.message.id);
      }
      const result = this.result(runId, finalText, "completed", decision.reason);
      this.options.store.setSessionStatus(input.sessionId, "completed");
      await this.status("done", result.reason);
      return result;
    } catch (error) {
      if (!sessionLoaded) {
        throw error;
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

  private async executeUntilCandidate(
    sessionId: string,
    currentUserMessageId: string,
    remedial: boolean,
  ): Promise<ExecuteOutcome> {
    while (true) {
      this.executeTurns += 1;
      const turn = await this.providerTurn(
        sessionId,
        currentUserMessageId,
        "execute",
        toolDefinitions(this.options.tools),
        remedial ? `${EXECUTE_PROMPT} This is the one remedial pass requested by Reflect.` : EXECUTE_PROMPT,
        true,
      );
      if (turn.response.toolCalls.length === 0) {
        this.options.store.finalizeStreamingAssistantMessage({
          messageId: turn.message.id,
          kind: "text",
          payload: { text: turn.response.content, phase: "execute" },
        });
        return { turn, stopReason: null };
      }
      this.options.store.finalizeStreamingAssistantWithToolCalls({
        messageId: turn.message.id,
        payload: { text: turn.response.content, phase: "execute" },
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
      payload: { text: closing.response.content, phase: "closing", stopReason: reason },
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
          permissionClient: this.options.permissionClient,
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
      systemText: this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
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
      payload: { text: "", phase },
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

  private async persistRejectedToolCalls(turn: StreamedTurn, _sessionId: string, message: string): Promise<void> {
    this.options.store.finalizeStreamingAssistantWithToolCalls({
      messageId: turn.message.id,
      payload: { text: turn.response.content, phase: turn.message.kind },
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
