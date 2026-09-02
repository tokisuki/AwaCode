import { RpcFault } from "../protocol/json-rpc.ts";

function diagnostic(data: unknown, key: "reason" | "detail" | "suggestion"): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function formatCliError(error: unknown): string {
  if (error instanceof RpcFault) {
    const reason = diagnostic(error.data, "reason");
    const detail = diagnostic(error.data, "detail");
    const suggestion = diagnostic(error.data, "suggestion");
    return [
      error.message,
      ...(reason === undefined ? [] : [`Reason: ${reason}`]),
      ...(detail === undefined ? [] : [`Detail: ${detail}`]),
      ...(suggestion === undefined ? [] : [`Suggestion: ${suggestion}`]),
    ].join("\n");
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "AwaCode CLI failed.";
}
