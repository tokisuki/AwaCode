import {
  type RecoverySummary,
  type SessionStore,
} from "../persistence/session-store.ts";
import { createToolCallRecoveryRecords } from "./tool-call-recovery-records.ts";

const recoveryRecords = createToolCallRecoveryRecords();

export const NOT_STARTED_RECOVERY_RESULT = recoveryRecords.notStarted.result;
export const OUTCOME_UNKNOWN_RECOVERY_RESULT = recoveryRecords.outcomeUnknown.result;

export function recoverInterruptedState(store: SessionStore): RecoverySummary {
  return store.convergeInterruptedState();
}
