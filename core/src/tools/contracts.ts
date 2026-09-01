import type { WorkspaceGuard } from "../security/workspace-guard.ts";
import type { SessionStore } from "../persistence/session-store.ts";
import type { PermissionClient } from "./permission.ts";
import type { MemoryStore } from "../memory/memory-store.ts";

export type ApprovalKind = "none" | "write" | "command";

export interface ToolAccessEvent {
  kind: "file_resolved" | "file_opened" | "directory_resolved" | "directory_opened";
  path: string;
}

export interface ToolContext {
  workspace: WorkspaceGuard;
  signal: AbortSignal;
  now: () => number;
  accessBarrier?: (event: ToolAccessEvent) => Promise<void>;
  approvedToolRuntime?: {
    callId: string;
    store: SessionStore;
    permissionClient: PermissionClient;
  };
  memoryRuntime?: {
    store: MemoryStore;
    projectId: string;
  };
}

export interface ToolResult {
  status: "success" | "failure" | "denied" | "interrupted";
  summary: string;
  content: string;
  durationMs: number;
  metadata: Record<string, unknown>;
}

export interface ToolDefinition<T> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  approval: ApprovalKind;
  validate(value: unknown): T;
  execute(input: T, context: ToolContext): Promise<ToolResult>;
}

export class ToolValidationError extends Error {
  readonly code = "invalid_tool_input" as const;

  constructor(options: ErrorOptions = {}) {
    super("Tool input is invalid.", options);
    this.name = "ToolValidationError";
  }
}

export class ToolExecutionError extends Error {
  readonly code = "tool_execution_failed" as const;

  constructor(options: ErrorOptions = {}) {
    super("Tool execution failed.", options);
    this.name = "ToolExecutionError";
  }
}

export function assertExactPlainObject(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ToolValidationError();
  }
  const allowed = new Set(allowedKeys);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new ToolValidationError();
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new ToolValidationError();
    }
  }
  if (requiredKeys.some((key) => !Object.hasOwn(value, key))) {
    throw new ToolValidationError();
  }
  return Object.fromEntries(ownKeys.map((key) => [key, (value as Record<string, unknown>)[key as string]]));
}
