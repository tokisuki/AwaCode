export function createToolCallRecoveryRecords() {
  return {
    notStarted: {
      result: {
        status: "interrupted",
        summary: "Tool execution was interrupted before it began.",
        content: "Execution never began and no local side effect occurred.",
        durationMs: 0,
        metadata: {
          recovery: "not_started",
          sideEffects: "none",
        },
      },
      errorText: "Tool execution never began; no local side effect occurred.",
    },
    outcomeUnknown: {
      result: {
        status: "interrupted",
        summary: "Tool execution was interrupted while running.",
        content: "The durable outcome is unknown; local side effects may have occurred. Inspect the workspace before retrying.",
        durationMs: 0,
        metadata: {
          recovery: "outcome_unknown",
          sideEffects: "may_have_occurred",
          retry: "inspect_workspace_first",
        },
      },
      errorText: "Durable outcome unknown; local side effects may have occurred. Inspect the workspace before retrying.",
    },
  } as const;
}
