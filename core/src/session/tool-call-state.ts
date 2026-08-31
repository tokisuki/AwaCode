import {
  type SessionStore,
  type ToolCallRecord,
} from "../persistence/session-store.ts";
import {
  isLegalToolCallTransition,
  isTerminalToolCallStatus,
  type ToolCallStatus,
} from "./tool-call-transition-policy.ts";

export interface ToolCallTransitionInput {
  callId: string;
  expectedStatus: ToolCallStatus;
  status: ToolCallStatus;
  result?: unknown;
  errorText?: string;
}

export type ToolCallTransitionOutcome =
  | { kind: "applied"; call: ToolCallRecord }
  | { kind: "idempotent"; call: ToolCallRecord }
  | { kind: "conflict"; reason: "illegal_transition" | "stale_status"; call: ToolCallRecord };

export function transitionToolCall(
  store: SessionStore,
  input: ToolCallTransitionInput,
): ToolCallTransitionOutcome {
  const terminal = isTerminalToolCallStatus(input.status);
  if (terminal && (input.result === undefined || input.result === null)) {
    throw new TypeError("terminal tool-call transition requires a non-null JSON result");
  }
  if (!isLegalToolCallTransition(input.expectedStatus, input.status)) {
    return { kind: "conflict", reason: "illegal_transition", call: store.loadToolCall(input.callId) };
  }

  const outcome = store.compareAndSwapToolCall({
    callId: input.callId,
    expectedStatus: input.expectedStatus,
    status: input.status,
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.errorText === undefined ? {} : { errorText: input.errorText }),
  });
  if (outcome.applied) {
    return { kind: "applied", call: outcome.call };
  }
  if (terminal && outcome.call.status === input.status) {
    return { kind: "idempotent", call: outcome.call };
  }
  return { kind: "conflict", reason: "stale_status", call: outcome.call };
}
