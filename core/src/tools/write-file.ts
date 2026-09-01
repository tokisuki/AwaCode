import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { SessionStore } from "../persistence/session-store.ts";
import { isPathWithinWorkspace, WorkspaceGuardError } from "../security/workspace-guard.ts";
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
  barrier?: (event: WriteFileBarrierEvent) => Promise<void>;
}

export type WriteFileBarrierEvent = "before_temp_create" | "before_publish" | "before_link" | "after_publish";
const WINDOWS_PUBLICATION_GUARD = "windows_retained_temp_handle" as const;

class WriteFileError extends Error {
  readonly code: "target_exists" | "parent_changed" | "temporary_file_changed" | "published_file_changed" | "publication_lock_unavailable" | "unsupported_platform" | "atomic_publish_failed" | "interrupted";
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
  const value = await lstat(path, { bigint: true });
  if (!value.isDirectory() || value.dev === 0n || value.ino === 0n) {
    throw new WriteFileError("parent_changed");
  }
  return { dev: value.dev, ino: value.ino };
}

async function openedDirectoryIdentity(handle: FileHandle): Promise<FileIdentity> {
  const value = await handle.stat({ bigint: true });
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

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function revalidateParent(
  prepared: PreparedWriteFile,
  context: ToolContext,
  parentHandle: FileHandle,
): Promise<void> {
  try {
    const resolvedTarget = await context.workspace.resolveNewFile(prepared.input.path);
    const parentPath = dirname(prepared.absolutePath);
    if (!samePath(resolvedTarget.absolutePath, prepared.absolutePath)) {
      throw new WriteFileError("parent_changed");
    }
    const pathIdentity = await directoryIdentity(parentPath);
    const handleIdentity = await openedDirectoryIdentity(parentHandle);
    if (!sameIdentity(prepared.parentIdentity, pathIdentity) || !sameIdentity(prepared.parentIdentity, handleIdentity)) {
      throw new WriteFileError("parent_changed");
    }
  } catch (error) {
    if (error instanceof WriteFileError) throw error;
    throw new WriteFileError("parent_changed");
  }
}

async function digestOpenedFile(handle: FileHandle, expectedBytes: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expectedBytes + 1));
  let offset = 0;
  while (offset <= expectedBytes) {
    const remaining = expectedBytes + 1 - offset;
    if (remaining === 0) break;
    const chunk = await handle.read(buffer, 0, Math.min(buffer.length, remaining), offset);
    if (chunk.bytesRead === 0) break;
    hash.update(buffer.subarray(0, chunk.bytesRead));
    offset += chunk.bytesRead;
  }
  if (offset !== expectedBytes) {
    throw new WriteFileError("temporary_file_changed");
  }
  return hash.digest("hex");
}

async function validateTemporaryFile(
  prepared: PreparedWriteFile,
  temporaryPath: string,
  handle: FileHandle,
  identity: FileIdentity,
  context: ToolContext,
): Promise<void> {
  try {
    const pathStats = await lstat(temporaryPath, { bigint: true });
    const pathIdentity = { dev: pathStats.dev, ino: pathStats.ino };
    const handleIdentity = await ownedIdentity(handle);
    const physicalPath = await realpath(temporaryPath);
    if (
      !pathStats.isFile()
      || !sameIdentity(identity, pathIdentity)
      || !sameIdentity(identity, handleIdentity)
      || !isPathWithinWorkspace(context.workspace.rootPath, physicalPath)
      || !samePath(dirname(physicalPath), dirname(prepared.absolutePath))
      || await digestOpenedFile(handle, prepared.bytes.length) !== prepared.digest
    ) {
      throw new WriteFileError("temporary_file_changed");
    }
  } catch (error) {
    if (error instanceof WriteFileError) throw error;
    throw new WriteFileError("temporary_file_changed");
  }
}

async function validatePublishedFile(path: string, identity: FileIdentity): Promise<void> {
  try {
    const value = await lstat(path, { bigint: true });
    if (!value.isFile() || !sameIdentity(identity, { dev: value.dev, ino: value.ino })) {
      throw new WriteFileError("published_file_changed");
    }
  } catch (error) {
    if (error instanceof WriteFileError) throw error;
    throw new WriteFileError("published_file_changed");
  }
}

async function acquireWindowsPublicationLock(
  prepared: PreparedWriteFile,
  temporaryPath: string,
  identity: FileIdentity,
  context: ToolContext,
  parentHandle: FileHandle,
): Promise<FileHandle> {
  if (process.platform !== "win32") {
    throw new WriteFileError("unsupported_platform");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "r");
    await revalidateParent(prepared, context, parentHandle);
    await validateTemporaryFile(prepared, temporaryPath, handle, identity, context);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof WriteFileError) throw error;
    throw new WriteFileError("publication_lock_unavailable");
  }
}

async function verifyWindowsPublicationLock(
  prepared: PreparedWriteFile,
  temporaryPath: string,
  identity: FileIdentity,
  context: ToolContext,
  parentHandle: FileHandle,
  lockHandle: FileHandle,
): Promise<void> {
  if (process.platform !== "win32") {
    throw new WriteFileError("unsupported_platform");
  }
  await revalidateParent(prepared, context, parentHandle);
  await validateTemporaryFile(prepared, temporaryPath, lockHandle, identity, context);
}

function preview(content: string): string {
  return truncateUtf8Output(content, PERMISSION_TEXT_PREVIEW_BYTES).text;
}

async function prepareWriteFile(input: WriteFileInput, context: ToolContext): Promise<PreparedWriteFile> {
  throwIfAborted(context.signal);
  if (process.platform !== "win32") {
    throw new WriteFileError("unsupported_platform");
  }
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
      title: `Create ${resolved.relativePath} (${bytes.length} bytes)`,
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
  options: Pick<ExecuteWriteFileOptions, "createTemporaryName" | "barrier">,
): Promise<void> {
  throwIfAborted(context.signal);
  const revalidated = await context.workspace.resolveNewFile(prepared.input.path);
  if (!samePath(revalidated.absolutePath, prepared.absolutePath)) {
    throw new WriteFileError("parent_changed");
  }
  await requireMissing(prepared.absolutePath);
  const parentPath = dirname(prepared.absolutePath);
  const temporaryPath = join(parentPath, `.awacode-write-${(options.createTemporaryName ?? randomUUID)()}.tmp`);
  let parentHandle: FileHandle | undefined;
  let handle: FileHandle | undefined;
  let publicationLock: FileHandle | undefined;
  let identity: FileIdentity | undefined;
  try {
    parentHandle = await open(parentPath, "r");
    await revalidateParent(prepared, context, parentHandle);
    await options.barrier?.("before_temp_create");
    await revalidateParent(prepared, context, parentHandle);
    throwIfAborted(context.signal);
    handle = await open(temporaryPath, "wx");
    identity = await ownedIdentity(handle);
    throwIfAborted(context.signal);
    await handle.writeFile(prepared.bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    publicationLock = await acquireWindowsPublicationLock(
      prepared,
      temporaryPath,
      identity,
      context,
      parentHandle,
    );
    await options.barrier?.("before_publish");
    await verifyWindowsPublicationLock(
      prepared,
      temporaryPath,
      identity,
      context,
      parentHandle,
      publicationLock,
    );
    throwIfAborted(context.signal);
    await options.barrier?.("before_link");
    await verifyWindowsPublicationLock(
      prepared,
      temporaryPath,
      identity,
      context,
      parentHandle,
      publicationLock,
    );
    throwIfAborted(context.signal);
    try {
      await link(temporaryPath, prepared.absolutePath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new WriteFileError("target_exists");
      }
      throw new WriteFileError("atomic_publish_failed");
    }
    await options.barrier?.("after_publish");
    try {
      await verifyWindowsPublicationLock(
        prepared,
        temporaryPath,
        identity,
        context,
        parentHandle,
        publicationLock,
      );
      await validatePublishedFile(prepared.absolutePath, identity);
    } catch (error) {
      await removeOwnedTemporary(prepared.absolutePath, identity);
      throw error;
    }
  } finally {
    if (identity === undefined && handle !== undefined) {
      identity = await ownedIdentity(handle).catch(() => undefined);
    }
    await handle?.close().catch(() => undefined);
    await publicationLock?.close().catch(() => undefined);
    await parentHandle?.close().catch(() => undefined);
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
              : code === "published_file_changed"
                ? "The published file changed before final validation."
                : code === "publication_lock_unavailable"
                  ? "The Windows publication lock could not be acquired."
                  : code === "unsupported_platform"
                    ? "Safe create-only publication is unavailable on this platform."
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
        await applyPreparedWrite(prepared, context, options);
        return {
          status: "success",
          summary: "Created a new workspace file.",
          content: `Created ${prepared.path}.`,
          metadata: {
            path: prepared.path,
            bytes: prepared.bytes.length,
            sha256: prepared.digest,
            publicationGuard: WINDOWS_PUBLICATION_GUARD,
          },
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
