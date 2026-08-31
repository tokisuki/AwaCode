import type { SessionStore } from "../persistence/session-store.ts";
import { RpcDisconnectedError } from "../protocol/json-rpc.ts";
import {
  transitionToolCall,
  type ToolCallTransitionOutcome,
} from "../session/tool-call-state.ts";
import type { ToolContext, ToolResult } from "./contracts.ts";
import {
  PermissionProtocolError,
  PermissionTimeoutError,
  type PermissionClient,
  type PermissionRequest,
} from "./permission.ts";

export type ToolResultDraft = Omit<ToolResult, "durationMs">;
export type ApprovalInterruptionCode =
  | "approval_timeout"
  | "approval_cancelled"
  | "approval_disconnected"
  | "approval_protocol_failure";

export class ApprovedToolBindingError extends Error {
  readonly code: "persisted_tool_mismatch" | "persisted_input_malformed";

  constructor(code: ApprovedToolBindingError["code"]) {
    super("Persisted approved tool call is invalid.");
    this.name = "ApprovedToolBindingError";
    this.code = code;
  }
}

function parsePersistedInput(inputText: string): unknown {
  try {
    return JSON.parse(inputText);
  } catch {
    throw new ApprovedToolBindingError("persisted_input_malformed");
  }
}

export interface ApprovedToolSpec<TInput, TPrepared> {
  name: string;
  validate(value: unknown): TInput;
  prepare(input: TInput, context: ToolContext): Promise<TPrepared>;
  permission(prepared: TPrepared): Omit<PermissionRequest, "callId">;
  denied(): ToolResultDraft;
  approvalInterrupted(code: ApprovalInterruptionCode): ToolResultDraft;
  failed(error: unknown, phase: "preparation" | "execution"): ToolResultDraft;
  execute(prepared: TPrepared, context: ToolContext): Promise<ToolResultDraft>;
}

export interface ApprovedToolRunOptions<TInput, TPrepared> {
  callId: string;
  store: SessionStore;
  permissionClient: PermissionClient;
  context: ToolContext;
  tool: ApprovedToolSpec<TInput, TPrepared>;
}

function persistedResult(result: unknown): ToolResult {
  if (typeof result !== "object" || result === null) {
    throw new TypeError("terminal approved tool call is missing its result");
  }
  return result as ToolResult;
}

async function observeDurableResult(store: SessionStore, callId: string): Promise<ToolResult> {
  let call = store.loadToolCall(callId);
  while (call.result === null) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    call = store.loadToolCall(callId);
  }
  return persistedResult(call.result);
}

async function resultAfterTerminalTransition(
  store: SessionStore,
  callId: string,
  outcome: ToolCallTransitionOutcome,
): Promise<ToolResult> {
  if (outcome.call.result === null) {
    return observeDurableResult(store, callId);
  }
  return persistedResult(outcome.call.result);
}

function approvalInterruption(error: unknown, signal: AbortSignal): ApprovalInterruptionCode {
  if (signal.aborted) {
    return "approval_cancelled";
  }
  if (error instanceof PermissionTimeoutError) {
    return "approval_timeout";
  }
  if (error instanceof RpcDisconnectedError) {
    return "approval_disconnected";
  }
  if (error instanceof PermissionProtocolError) {
    return "approval_protocol_failure";
  }
  return "approval_protocol_failure";
}

export async function runApprovedTool<TInput, TPrepared>(
  options: ApprovedToolRunOptions<TInput, TPrepared>,
): Promise<ToolResult> {
  const startedAt = options.context.now();
  const complete = (draft: ToolResultDraft): ToolResult => ({
    ...draft,
    durationMs: Math.max(0, options.context.now() - startedAt),
  });
  let input: TInput;
  let prepared: TPrepared;
  try {
    const persistedCall = options.store.loadToolCall(options.callId);
    if (persistedCall.toolName !== options.tool.name) {
      throw new ApprovedToolBindingError("persisted_tool_mismatch");
    }
    input = options.tool.validate(parsePersistedInput(persistedCall.inputText));
    prepared = await options.tool.prepare(input, options.context);
  } catch (error) {
    const result = complete(options.tool.failed(error, "preparation"));
    const terminal = transitionToolCall(options.store, {
      callId: options.callId,
      expectedStatus: "pending",
      status: result.status,
      result,
    });
    return resultAfterTerminalTransition(options.store, options.callId, terminal);
  }
  const awaiting = transitionToolCall(options.store, {
    callId: options.callId,
    expectedStatus: "pending",
    status: "awaiting_approval",
  });
  if (awaiting.kind !== "applied") {
    return observeDurableResult(options.store, options.callId);
  }
  let decision;
  try {
    decision = await options.permissionClient.requestPermission({
      callId: options.callId,
      ...options.tool.permission(prepared),
    }, { signal: options.context.signal });
  } catch (error) {
    const code = approvalInterruption(error, options.context.signal);
    const result = complete(options.tool.approvalInterrupted(code));
    const interrupted = transitionToolCall(options.store, {
      callId: options.callId,
      expectedStatus: "awaiting_approval",
      status: "interrupted",
      result,
    });
    return resultAfterTerminalTransition(options.store, options.callId, interrupted);
  }
  if (decision === "deny") {
    const result = complete(options.tool.denied());
    const denied = transitionToolCall(options.store, {
      callId: options.callId,
      expectedStatus: "awaiting_approval",
      status: "denied",
      result,
    });
    return resultAfterTerminalTransition(options.store, options.callId, denied);
  }
  const running = transitionToolCall(options.store, {
    callId: options.callId,
    expectedStatus: "awaiting_approval",
    status: "running",
  });
  if (running.kind !== "applied") {
    return observeDurableResult(options.store, options.callId);
  }
  let draft: ToolResultDraft;
  try {
    draft = await options.tool.execute(prepared, options.context);
  } catch (error) {
    draft = options.tool.failed(error, "execution");
  }
  const result = complete(draft);
  const terminal = transitionToolCall(options.store, {
    callId: options.callId,
    expectedStatus: "running",
    status: result.status,
    result,
  });
  return resultAfterTerminalTransition(options.store, options.callId, terminal);
}
