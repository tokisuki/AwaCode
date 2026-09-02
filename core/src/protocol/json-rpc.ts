export const JSON_RPC_VERSION = "2.0" as const;

export const RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  busy: -32001,
  notConfigured: -32002,
  notFound: -32003,
  historyIntegrity: -32004,
  cancelled: -32005,
  configurationOperation: -32006,
  contextLimit: -32007,
  modelRequest: -32008,
  agentRun: -32009,
} as const;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export type ValidatedJsonRpcValue =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }
  | { kind: "success"; message: JsonRpcSuccessResponse }
  | { kind: "error"; message: JsonRpcErrorResponse }
  | { kind: "invalidRequest"; id: string | null }
  | { kind: "invalidResponse"; id: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isJsonRpcErrorObject(value: unknown): value is JsonRpcErrorObject {
  return isRecord(value) && typeof value.code === "number" && typeof value.message === "string";
}

export function validateJsonRpcValue(value: unknown): ValidatedJsonRpcValue {
  if (!isRecord(value)) {
    return { kind: "invalidRequest", id: null };
  }

  const hasId = hasOwn(value, "id");
  const hasMethod = hasOwn(value, "method");
  const hasResult = hasOwn(value, "result");
  const hasError = hasOwn(value, "error");
  const recoveredId = typeof value.id === "string" ? value.id : null;

  if (hasMethod) {
    if (
      value.jsonrpc !== JSON_RPC_VERSION
      || typeof value.method !== "string"
      || (hasId && typeof value.id !== "string")
      || hasResult
      || hasError
    ) {
      return { kind: "invalidRequest", id: recoveredId };
    }
    const base = hasOwn(value, "params")
      ? { jsonrpc: JSON_RPC_VERSION, method: value.method, params: value.params }
      : { jsonrpc: JSON_RPC_VERSION, method: value.method };
    if (hasId) {
      return { kind: "request", message: { ...base, id: value.id as string } };
    }
    return { kind: "notification", message: base };
  }

  if (hasId || hasResult || hasError) {
    if (value.jsonrpc !== JSON_RPC_VERSION || hasResult === hasError) {
      return { kind: "invalidResponse", id: recoveredId };
    }
    if (hasResult && typeof value.id === "string") {
      return {
        kind: "success",
        message: { jsonrpc: JSON_RPC_VERSION, id: value.id, result: value.result },
      };
    }
    if (hasError && (typeof value.id === "string" || value.id === null) && isJsonRpcErrorObject(value.error)) {
      return {
        kind: "error",
        message: { jsonrpc: JSON_RPC_VERSION, id: value.id, error: value.error },
      };
    }
    return { kind: "invalidResponse", id: recoveredId };
  }

  return { kind: "invalidRequest", id: null };
}

export class RpcFault extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcFault";
    this.code = code;
    if (data !== undefined) {
      this.data = data;
    }
  }
}

export class RpcDisconnectedError extends Error {
  readonly reason?: unknown;

  constructor(reason?: unknown) {
    super("JSON-RPC peer is disconnected", reason === undefined ? undefined : { cause: reason });
    this.name = "RpcDisconnectedError";
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
}
