import type { ToolCallStatus } from "../persistence/session-store.ts";

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

export function isLegalToolCallTransition(from: ToolCallStatus, to: ToolCallStatus): boolean {
  return LEGAL_TRANSITIONS[from].has(to);
}

export function isTerminalToolCallStatus(status: ToolCallStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
