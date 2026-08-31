import {
  type SessionStore,
  type ToolCallRecord,
  type ToolCallStatus,
} from "../persistence/session-store.ts";

const LEGAL_TRANSITIONS: Readonly<Record<ToolCallStatus, ReadonlySet<ToolCallStatus>>> = {
  pending: new Set(["running", "awaiting_approval", "failure", "interrupted"]),
  awaiting_approval: new Set(["running", "denied", "interrupted"]),
  running: new Set(["success", "failure", "interrupted"]),
  success: new Set(),
  failure: new Set(),
  denied: new Set(),
  interrupted: new Set(),
};

const TERMINAL_STATUSES: ReadonlySet<ToolCallStatus> = new Set([
  "success",
  "failure",
  "denied",
  "interrupted",
]);

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

function sanitizeErrorText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 4000);
}

export function transitionToolCall(
  store: SessionStore,
  input: ToolCallTransitionInput,
): ToolCallTransitionOutcome {
  const terminal = TERMINAL_STATUSES.has(input.status);
  if (terminal && (input.result === undefined || input.result === null)) {
    throw new TypeError("terminal tool-call transition requires a non-null JSON result");
  }
  if (!LEGAL_TRANSITIONS[input.expectedStatus].has(input.status)) {
    return { kind: "conflict", reason: "illegal_transition", call: store.loadToolCall(input.callId) };
  }

  const errorText = sanitizeErrorText(input.errorText);
  const outcome = store.compareAndSwapToolCall({
    callId: input.callId,
    expectedStatus: input.expectedStatus,
    status: input.status,
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(errorText === undefined ? {} : { errorText }),
  });
  if (outcome.applied) {
    return { kind: "applied", call: outcome.call };
  }
  if (terminal && outcome.call.status === input.status) {
    return { kind: "idempotent", call: outcome.call };
  }
  return { kind: "conflict", reason: "stale_status", call: outcome.call };
}
