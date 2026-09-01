import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";

const MAX_ATTEMPTS = 3;

function isInterruptedStreamTransportError(error: unknown): boolean {
  if (!(error instanceof TypeError) || typeof error.cause !== "object" || error.cause === null) {
    return false;
  }
  return "code" in error.cause && error.cause.code === "UND_ERR_SOCKET";
}

export function isRetryableModelError(error: unknown): boolean {
  if (error instanceof APIConnectionError
    || error instanceof APIConnectionTimeoutError
    || isInterruptedStreamTransportError(error)) {
    return true;
  }
  return error instanceof APIError
    && (error.status === 429 || error.status >= 500);
}

export function retryDelayMilliseconds(error: unknown, attempt: number): number {
  if (error instanceof APIError && error.headers !== undefined) {
    const retryAfter = error.headers.get("retry-after");
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.round(seconds * 1000);
      }
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) {
        return Math.max(0, date - Date.now());
      }
    }
  }
  return 250 * attempt;
}

export function canRetryModelError(error: unknown, attempts: number, emittedOutput: boolean): boolean {
  return attempts < MAX_ATTEMPTS && !emittedOutput && isRetryableModelError(error);
}
