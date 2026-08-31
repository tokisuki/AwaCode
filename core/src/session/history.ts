import {
  type MessageRecord,
  type SessionStore,
  type ToolCallRecord,
  type ToolCallStatus,
} from "../persistence/session-store.ts";
import { recoverInterruptedState } from "./recovery.ts";

type ProviderRole = "system" | "user" | "assistant";
type TerminalToolCallStatus = "success" | "failure" | "denied" | "interrupted";

export interface ProviderHistoryMessage {
  type: "message";
  messageId: string;
  seq: number;
  role: ProviderRole;
  kind: string;
  payload: unknown;
}

export interface ProviderToolCall {
  callId: string;
  ordinal: number;
  toolName: string;
  inputText: string;
}

export interface ProviderToolResult {
  callId: string;
  ordinal: number;
  status: TerminalToolCallStatus;
  kind: "normal" | "error";
  result: unknown;
  errorText: string | null;
}

export interface ProviderAssistantToolBlock {
  type: "assistant_tool_block";
  messageId: string;
  seq: number;
  kind: string;
  payload: unknown;
  toolCalls: ProviderToolCall[];
  toolResults: ProviderToolResult[];
}

export type ProviderHistoryEntry = ProviderHistoryMessage | ProviderAssistantToolBlock;

export class HistoryIntegrityError extends Error {
  readonly code = "history_integrity_error" as const;

  constructor(detail: string, options: ErrorOptions = {}) {
    super(`provider history integrity failure: ${detail}`, options);
    this.name = "HistoryIntegrityError";
  }
}

const TERMINAL_STATUSES: ReadonlySet<ToolCallStatus> = new Set([
  "success",
  "failure",
  "denied",
  "interrupted",
]);

function integrity(detail: string): never {
  throw new HistoryIntegrityError(detail);
}

function toolBlock(message: MessageRecord, calls: readonly ToolCallRecord[]): ProviderAssistantToolBlock {
  if (message.kind !== "tool_calls") {
    integrity(`assistant message ${message.id} has tool calls but kind ${message.kind}`);
  }
  if (calls.length === 0) {
    integrity(`assistant tool-call message ${message.id} has no calls`);
  }
  const toolCalls: ProviderToolCall[] = [];
  const toolResults: ProviderToolResult[] = [];
  for (const [index, call] of calls.entries()) {
    if (call.ordinal !== index) {
      integrity(`assistant message ${message.id} has a non-contiguous or duplicate ordinal`);
    }
    if (!TERMINAL_STATUSES.has(call.status)) {
      integrity(`tool call ${call.callId} is nonterminal`);
    }
    if (call.result === null) {
      integrity(`tool call ${call.callId} has no terminal result`);
    }
    const status = call.status as TerminalToolCallStatus;
    toolCalls.push({
      callId: call.callId,
      ordinal: call.ordinal,
      toolName: call.toolName,
      inputText: call.inputText,
    });
    toolResults.push({
      callId: call.callId,
      ordinal: call.ordinal,
      status,
      kind: status === "success" ? "normal" : "error",
      result: call.result,
      errorText: call.errorText,
    });
  }
  return {
    type: "assistant_tool_block",
    messageId: message.id,
    seq: message.seq,
    kind: message.kind,
    payload: message.payload,
    toolCalls,
    toolResults,
  };
}

export function validateProviderHistory(store: SessionStore, sessionId: string): ProviderHistoryEntry[] {
  try {
    const loaded = store.loadSession(sessionId);
    const messages = new Map(loaded.messages.map((message) => [message.id, message]));
    const callsByMessage = new Map<string, ToolCallRecord[]>();
    for (const call of loaded.toolCalls) {
      const message = messages.get(call.assistantMessageId);
      if (call.sessionId !== sessionId || message === undefined || message.sessionId !== sessionId) {
        integrity(`tool call ${call.callId} is attached to the wrong session or assistant`);
      }
      if (message.role !== "assistant") {
        integrity(`tool call ${call.callId} is not attached to an assistant message`);
      }
      if (!TERMINAL_STATUSES.has(call.status)) {
        integrity(`tool call ${call.callId} is nonterminal`);
      }
      if (call.result === null) {
        integrity(`tool call ${call.callId} has no terminal result`);
      }
      const calls = callsByMessage.get(message.id) ?? [];
      calls.push(call);
      callsByMessage.set(message.id, calls);
    }

    const history: ProviderHistoryEntry[] = [];
    for (const message of loaded.messages) {
      if (message.status !== "complete") {
        continue;
      }
      if (message.role === "tool") {
        integrity(`orphan or duplicate tool-result message ${message.id}`);
      }
      if (message.role === "internal") {
        continue;
      }
      const calls = callsByMessage.get(message.id) ?? [];
      if (message.role === "assistant" && (message.kind === "tool_calls" || calls.length > 0)) {
        history.push(toolBlock(message, calls));
        continue;
      }
      if (calls.length > 0) {
        integrity(`non-assistant message ${message.id} has tool calls`);
      }
      history.push({
        type: "message",
        messageId: message.id,
        seq: message.seq,
        role: message.role,
        kind: message.kind,
        payload: message.payload,
      });
    }
    return history;
  } catch (error) {
    if (error instanceof HistoryIntegrityError) {
      throw error;
    }
    throw new HistoryIntegrityError("persisted payload could not be loaded", { cause: error });
  }
}

export function prepareProviderHistory(store: SessionStore, sessionId: string): ProviderHistoryEntry[] {
  try {
    recoverInterruptedState(store);
    return validateProviderHistory(store, sessionId);
  } catch (error) {
    if (error instanceof HistoryIntegrityError) {
      throw error;
    }
    throw new HistoryIntegrityError("startup convergence failed", { cause: error });
  }
}
