import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SessionStore } from "../persistence/session-store.ts";
import { WorkspaceGuardError } from "../security/workspace-guard.ts";
import {
  assertExactPlainObject,
  ToolExecutionError,
  ToolValidationError,
  type ToolContext,
  type ToolDefinition,
} from "./contracts.ts";
import {
  ApprovedToolBindingError,
  runApprovedTool,
  type ApprovalInterruptionCode,
} from "./approved-tool-runner.ts";
import { PERMISSION_TEXT_PREVIEW_BYTES, type PermissionClient, type WritePermissionRequest } from "./permission.ts";
import { truncateUtf8Output } from "./truncate.ts";

export interface WriteFileInput {
  path: string;
  content: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface PreparedWriteFile {
  input: WriteFileInput;
  path: string;
  absolutePath: string;
  parentIdentity: FileIdentity;
  digest: string;
  bytes: Buffer;
  permission: Omit<WritePermissionRequest, "callId">;
}

export interface ExecuteWriteFileOptions {
  callId: string;
  store: SessionStore;
  permissionClient: PermissionClient;
  context: ToolContext;
  createTemporaryName?: () => string;
}

class WriteFileError extends Error {
  readonly code: "target_exists" | "parent_changed" | "temporary_file_changed" | "atomic_publish_failed" | "interrupted";
  constructor(code: WriteFileError["code"]) {
    super("Workspace file could not be created.");
    this.name = "WriteFileError";
    this.code = code;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WriteFileError("interrupted");
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev !== 0n && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

async function requireMissing(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new WriteFileError("target_exists");
  } catch (error) {
    if (error instanceof WriteFileError) {
      throw error;
    }
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function directoryIdentity(path: string): Promise<FileIdentity> {
  const value = await stat(path, { bigint: true });
  if (!value.isDirectory() || value.dev === 0n || value.ino === 0n) {
    throw new WriteFileError("parent_changed");
  }
  return { dev: value.dev, ino: value.ino };
}

async function ownedIdentity(handle: FileHandle): Promise<FileIdentity> {
  const value = await handle.stat({ bigint: true });
  if (!value.isFile() || value.dev === 0n || value.ino === 0n) {
    throw new WriteFileError("temporary_file_changed");
  }
  return { dev: value.dev, ino: value.ino };
}

async function removeOwnedTemporary(path: string, identity: FileIdentity | undefined): Promise<void> {
  if (identity === undefined) {
    return;
  }
  try {
    const current = await lstat(path, { bigint: true });
    if (current.isFile() && sameIdentity(identity, { dev: current.dev, ino: current.ino })) {
      await unlink(path);
    }
  } catch {
    // Cleanup is best effort and never targets an unverified path entry.
  }
}

function preview(content: string): string {
  return truncateUtf8Output(content, PERMISSION_TEXT_PREVIEW_BYTES).text;
}

async function prepareWriteFile(input: WriteFileInput, context: ToolContext): Promise<PreparedWriteFile> {
  throwIfAborted(context.signal);
  const resolved = await context.workspace.resolveNewFile(input.path);
  await context.accessBarrier?.({ kind: "file_resolved", path: resolved.relativePath });
  throwIfAborted(context.signal);
  await requireMissing(resolved.absolutePath);
  const parentIdentity = await directoryIdentity(dirname(resolved.absolutePath));
  const bytes = Buffer.from(input.content, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    input,
    path: resolved.relativePath,
    absolutePath: resolved.absolutePath,
    parentIdentity,
    digest,
    bytes,
    permission: {
      kind: "write",
      title: `Create ${resolved.relativePath}`,
      preview: {
        path: resolved.relativePath,
        replacementCount: 1,
        before: "",
        after: preview(input.content),
        sha256: digest,
      },
    },
  };
}

async function applyPreparedWrite(
  prepared: PreparedWriteFile,
  context: ToolContext,
  createTemporaryName: () => string,
): Promise<void> {
  throwIfAborted(context.signal);
  const revalidated = await context.workspace.resolveNewFile(prepared.input.path);
  if (revalidated.absolutePath !== prepared.absolutePath) {
    throw new WriteFileError("parent_changed");
  }
  await requireMissing(prepared.absolutePath);
  if (!sameIdentity(prepared.parentIdentity, await directoryIdentity(dirname(prepared.absolutePath)))) {
    throw new WriteFileError("parent_changed");
  }

  const temporaryPath = join(dirname(prepared.absolutePath), `.awacode-write-${createTemporaryName()}.tmp`);
  let handle: FileHandle | undefined;
  let identity: FileIdentity | undefined;
  try {
    handle = await open(temporaryPath, "wx");
    identity = await ownedIdentity(handle);
    throwIfAborted(context.signal);
    await handle.writeFile(prepared.bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const verify = await open(temporaryPath, "r");
    try {
      const verifyIdentity = await ownedIdentity(verify);
      const verifyBytes = await verify.readFile();
      if (!sameIdentity(identity, verifyIdentity) || createHash("sha256").update(verifyBytes).digest("hex") !== prepared.digest) {
        throw new WriteFileError("temporary_file_changed");
      }
    } finally {
      await verify.close().catch(() => undefined);
    }
    throwIfAborted(context.signal);
    try {
      await link(temporaryPath, prepared.absolutePath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new WriteFileError("target_exists");
      }
      throw new WriteFileError("atomic_publish_failed");
    }
  } finally {
    if (identity === undefined && handle !== undefined) {
      identity = await ownedIdentity(handle).catch(() => undefined);
    }
    await handle?.close().catch(() => undefined);
    await removeOwnedTemporary(temporaryPath, identity);
  }
}

function failedWrite(error: unknown, phase: "preparation" | "execution") {
  const code = error instanceof ApprovedToolBindingError
    ? error.code
    : error instanceof ToolValidationError
      ? error.code
      : error instanceof WorkspaceGuardError
        ? error.code
        : error instanceof WriteFileError
          ? error.code
          : "filesystem_error";
  if (code === "interrupted") {
    return {
      status: "interrupted" as const,
      summary: "File creation was interrupted.",
      content: "File creation was interrupted before atomic publication.",
      metadata: { tool: "write_file", phase, error: "cancelled" },
    };
  }
  return {
    status: "failure" as const,
    summary: "Unable to create workspace file.",
    content: code === "target_exists"
      ? "The target already exists; use edit_file to change it."
      : code === "persisted_tool_mismatch"
        ? "Persisted tool call does not match write_file."
        : code === "persisted_input_malformed"
          ? "Persisted tool input is malformed."
          : code === "parent_changed"
            ? "The target parent directory changed after approval."
            : code === "temporary_file_changed"
              ? "The prepared file changed before publication."
              : code === "atomic_publish_failed"
                ? "Atomic file publication failed."
                : error instanceof WorkspaceGuardError
                  ? error.message
                  : "The workspace file could not be created.",
    metadata: { tool: "write_file", phase, error: code },
  };
}

function approvalInterrupted(code: ApprovalInterruptionCode) {
  return {
    status: "interrupted" as const,
    summary: "File creation approval was interrupted.",
    content: "Approval did not complete and no workspace file was created.",
    metadata: { tool: "write_file", phase: "approval", error: code, sideEffects: "none" },
  };
}

export function executeWriteFile(options: ExecuteWriteFileOptions) {
  return runApprovedTool({
    callId: options.callId,
    store: options.store,
    permissionClient: options.permissionClient,
    context: options.context,
    tool: {
      name: writeFileTool.name,
      validate: writeFileTool.validate,
      prepare: prepareWriteFile,
      permission: (prepared) => prepared.permission,
      denied: () => ({
        status: "denied",
        summary: "File creation was denied.",
        content: "The file creation was not authorized and no local side effect occurred.",
        metadata: { tool: "write_file", approval: "denied", sideEffects: "none" },
      }),
      approvalInterrupted,
      failed: failedWrite,
      async execute(prepared, context) {
        await applyPreparedWrite(prepared, context, options.createTemporaryName ?? randomUUID);
        return {
          status: "success",
          summary: "Created a new workspace file.",
          content: `Created ${prepared.path}.`,
          metadata: { path: prepared.path, bytes: prepared.bytes.length, sha256: prepared.digest },
        };
      },
    },
  });
}

function validateWriteFileInput(value: unknown): WriteFileInput {
  const input = assertExactPlainObject(value, ["path", "content"], ["path", "content"]);
  if (typeof input.path !== "string" || input.path.trim().length === 0 || typeof input.content !== "string") {
    throw new ToolValidationError();
  }
  return { path: input.path, content: input.content };
}

export const writeFileTool: ToolDefinition<WriteFileInput> = {
  name: "write_file",
  description: "Create a new UTF-8 workspace file after one-shot approval; never overwrite an existing target.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: { path: { type: "string", minLength: 1 }, content: { type: "string" } },
  },
  approval: "write",
  validate: validateWriteFileInput,
  execute(_input, context) {
    const runtime = context.approvedToolRuntime;
    if (runtime === undefined) {
      throw new ToolExecutionError();
    }
    return executeWriteFile({
      callId: runtime.callId,
      store: runtime.store,
      permissionClient: runtime.permissionClient,
      context,
    });
  },
};
