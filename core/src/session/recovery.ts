import {
  type RecoverySummary,
  type SessionStore,
} from "../persistence/session-store.ts";

export const NOT_STARTED_RECOVERY_RESULT = {
  status: "interrupted",
  summary: "Tool execution was interrupted before it began.",
  content: "Execution never began and no local side effect occurred.",
  durationMs: 0,
  metadata: {
    recovery: "not_started",
    sideEffects: "none",
  },
} as const;

export const OUTCOME_UNKNOWN_RECOVERY_RESULT = {
  status: "interrupted",
  summary: "Tool execution was interrupted while running.",
  content: "The durable outcome is unknown; local side effects may have occurred. Inspect the workspace before retrying.",
  durationMs: 0,
  metadata: {
    recovery: "outcome_unknown",
    sideEffects: "may_have_occurred",
    retry: "inspect_workspace_first",
  },
} as const;

export function recoverInterruptedState(store: SessionStore): RecoverySummary {
  return store.convergeInterruptedState({
    notStarted: NOT_STARTED_RECOVERY_RESULT,
    outcomeUnknown: OUTCOME_UNKNOWN_RECOVERY_RESULT,
    notStartedErrorText: "Tool execution never began; no local side effect occurred.",
    outcomeUnknownErrorText: "Durable outcome unknown; local side effects may have occurred. Inspect the workspace before retrying.",
  });
}
