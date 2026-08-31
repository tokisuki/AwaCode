import { Buffer } from "node:buffer";

import { JsonRpcPeer } from "../protocol/rpc-peer.ts";

export const DEFAULT_PERMISSION_TIMEOUT_MS = 10 * 60 * 1_000;
export const PERMISSION_TEXT_PREVIEW_BYTES = 4 * 1024;

export type PermissionKind = "write" | "command";
export type PermissionDecision = "allow_once" | "deny";

export interface PermissionPreview {
  path: string;
  replacementCount: number;
  before: string;
  after: string;
  sha256: string;
}

export interface PermissionRequest {
  callId: string;
  kind: PermissionKind;
  title: string;
  preview: PermissionPreview;
}

export interface PermissionRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PermissionClient {
  requestPermission(
    request: PermissionRequest,
    options?: PermissionRequestOptions,
  ): Promise<PermissionDecision>;
}

export interface PermissionTimer {
  schedule(delayMs: number, callback: () => void): () => void;
}

const systemPermissionTimer: PermissionTimer = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export class PermissionProtocolError extends Error {
  readonly code = "approval_protocol_failure" as const;

  constructor(options: ErrorOptions = {}) {
    super("Approval protocol failed.", options);
    this.name = "PermissionProtocolError";
  }
}

export class PermissionTimeoutError extends Error {
  readonly code = "approval_timeout" as const;

  constructor() {
    super("Approval request timed out.");
    this.name = "PermissionTimeoutError";
  }
}

function exactDataObject(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return undefined;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    return undefined;
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return undefined;
    }
  }
  return value as Record<string, unknown>;
}

function safeRelativeDisplayPath(value: string): boolean {
  const components = value.split("/");
  return value.length > 0
    && value.length <= 4_096
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes(":")
    && !value.includes("\0")
    && components.every((component) => component.length > 0 && component !== "." && component !== "..");
}

function validatedPermissionRequest(value: PermissionRequest): PermissionRequest {
  const input = exactDataObject(value, ["callId", "kind", "title", "preview"]);
  const preview = exactDataObject(input?.preview, ["path", "replacementCount", "before", "after", "sha256"]);
  if (
    input === undefined
    || preview === undefined
    || typeof input.callId !== "string"
    || input.callId.trim().length === 0
    || (input.kind !== "write" && input.kind !== "command")
    || typeof input.title !== "string"
    || input.title.trim().length === 0
    || input.title.length > 160
    || /[\r\n\u0000-\u001f\u007f]/.test(input.title)
    || typeof preview.path !== "string"
    || !safeRelativeDisplayPath(preview.path)
    || typeof preview.replacementCount !== "number"
    || !Number.isSafeInteger(preview.replacementCount)
    || preview.replacementCount < 1
    || typeof preview.before !== "string"
    || Buffer.byteLength(preview.before) > PERMISSION_TEXT_PREVIEW_BYTES
    || typeof preview.after !== "string"
    || Buffer.byteLength(preview.after) > PERMISSION_TEXT_PREVIEW_BYTES
    || typeof preview.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(preview.sha256)
  ) {
    throw new PermissionProtocolError();
  }
  return {
    callId: input.callId,
    kind: input.kind,
    title: input.title,
    preview: {
      path: preview.path,
      replacementCount: preview.replacementCount,
      before: preview.before,
      after: preview.after,
      sha256: preview.sha256,
    },
  };
}

export class JsonRpcPermissionClient implements PermissionClient {
  private readonly peer: JsonRpcPeer;
  private readonly timer: PermissionTimer;

  constructor(peer: JsonRpcPeer, timer: PermissionTimer = systemPermissionTimer) {
    this.peer = peer;
    this.timer = timer;
  }

  async requestPermission(
    request: PermissionRequest,
    options: PermissionRequestOptions = {},
  ): Promise<PermissionDecision> {
    const safeRequest = validatedPermissionRequest(request);
    const timeoutMs = options.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let cancelTimer = () => {};
    try {
      if (options.signal?.aborted === true) {
        onAbort();
      }
      cancelTimer = this.timer.schedule(timeoutMs, () => {
        controller.abort(new PermissionTimeoutError());
      });
      const result = await this.peer.request("permission/request", safeRequest, { signal: controller.signal });
      if (result !== "allow_once" && result !== "deny") {
        throw new PermissionProtocolError();
      }
      return result;
    } finally {
      cancelTimer();
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}
