import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import { WorkspaceGuardError } from "../security/workspace-guard.ts";
import {
  assertExactPlainObject,
  ToolExecutionError,
  ToolValidationError,
  type ToolContext,
  type ToolDefinition,
} from "./contracts.ts";
import { ApprovedToolBindingError, runApprovedTool } from "./approved-tool-runner.ts";
import type { ApprovalInterruptionCode } from "./approved-tool-runner.ts";
import { PERMISSION_TEXT_PREVIEW_BYTES, type PermissionRequest } from "./permission.ts";
import type { PermissionClient } from "./permission.ts";
import type { SessionStore } from "../persistence/session-store.ts";
import { truncateUtf8Output } from "./truncate.ts";

export interface EditFileInput {
  path: string;
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

export type EditFilePreparationErrorCode =
  | "match_not_found"
  | "match_not_unique"
  | "unsupported_encoding"
  | "interrupted";

export class EditFilePreparationError extends Error {
  readonly code: EditFilePreparationErrorCode;

  constructor(code: EditFilePreparationErrorCode) {
    super("File edit could not be prepared.");
    this.name = "EditFilePreparationError";
    this.code = code;
  }
}

export interface EditFileIdentity {
  dev: bigint;
  ino: bigint;
}

export interface PreparedEditFile {
  readonly input: EditFileInput;
  readonly path: string;
  readonly replacementCount: number;
  readonly digest: string;
  readonly identity: EditFileIdentity;
  readonly mode: number;
  readonly permission: Omit<PermissionRequest, "callId">;
}

export interface AppliedEditFile {
  path: string;
  replacementCount: number;
  replaceAll: boolean;
}

export type EditFileApplyErrorCode =
  | "file_changed"
  | "temporary_file_changed"
  | "atomic_replace_failed"
  | "interrupted";

export class EditFileApplyError extends Error {
  readonly code: EditFileApplyErrorCode;
  readonly operation?: "create" | "write" | "sync" | "replace";

  constructor(code: EditFileApplyErrorCode, operation?: EditFileApplyError["operation"]) {
    super("Approved file edit could not be applied.");
    this.name = "EditFileApplyError";
    this.code = code;
    if (operation !== undefined) {
      this.operation = operation;
    }
  }
}

export interface AtomicReplaceAdapter {
  replace(sourcePath: string, targetPath: string): Promise<void>;
}

export interface ApplyPreparedEditFileOptions {
  atomicReplace?: AtomicReplaceAdapter;
  createTemporaryName?: () => string;
  barrier?: (event: "before_replace") => Promise<void>;
  beforeOperation?: (
    operation: "create" | "write" | "sync" | "replace",
  ) => void | Promise<void>;
}

export interface ExecuteEditFileOptions {
  callId: string;
  store: SessionStore;
  permissionClient: PermissionClient;
  context: ToolContext;
  applyOptions?: ApplyPreparedEditFileOptions;
}

const nodeAtomicReplace: AtomicReplaceAdapter = {
  async replace(sourcePath, targetPath) {
    await rename(sourcePath, targetPath);
  },
};

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new EditFilePreparationError("interrupted");
  }
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const match = text.indexOf(search, offset);
    if (match === -1) {
      return count;
    }
    count += 1;
    offset = match + search.length;
  }
}

function previewText(text: string): string {
  return truncateUtf8Output(text, PERMISSION_TEXT_PREVIEW_BYTES).text;
}

function replaceExact(text: string, oldText: string, newText: string, replaceAll: boolean): string {
  if (!replaceAll) {
    const match = text.indexOf(oldText);
    return text.slice(0, match) + newText + text.slice(match + oldText.length);
  }
  return text.split(oldText).join(newText);
}

function editFileFailure(error: unknown, phase: "preparation" | "execution") {
  if (error instanceof ApprovedToolBindingError) {
    return {
      status: "failure" as const,
      summary: "Unable to edit workspace file.",
      content: error.code === "persisted_tool_mismatch"
        ? "Persisted tool call does not match edit_file."
        : "Persisted tool input is malformed.",
      metadata: { tool: "edit_file", phase, error: error.code },
    };
  }
  if (error instanceof ToolValidationError) {
    return {
      status: "failure" as const,
      summary: "Unable to edit workspace file.",
      content: "Tool input is invalid.",
      metadata: { tool: "edit_file", phase, error: error.code },
    };
  }
  if (error instanceof EditFilePreparationError) {
    if (error.code === "interrupted") {
      return {
        status: "interrupted" as const,
        summary: "File edit was interrupted.",
        content: "The file edit was interrupted before approval and no local side effect occurred.",
        metadata: { tool: "edit_file", phase, error: "cancelled", sideEffects: "none" },
      };
    }
    const content = error.code === "match_not_found"
      ? "The exact old text was not found."
      : error.code === "match_not_unique"
        ? "The exact old text matched more than once; provide more context or set replace_all."
        : "File is binary or is not valid UTF-8.";
    return {
      status: "failure" as const,
      summary: "Unable to edit workspace file.",
      content,
      metadata: { tool: "edit_file", phase, error: error.code },
    };
  }
  if (error instanceof WorkspaceGuardError) {
    return {
      status: "failure" as const,
      summary: "Unable to edit workspace file.",
      content: error.message,
      metadata: { tool: "edit_file", phase, error: error.code },
    };
  }
  if (error instanceof EditFileApplyError) {
    if (error.code === "interrupted") {
      return {
        status: "interrupted" as const,
        summary: "File edit was interrupted.",
        content: "The running file edit was interrupted before atomic replacement.",
        metadata: { tool: "edit_file", phase, error: "cancelled" },
      };
    }
    return {
      status: "failure" as const,
      summary: "Unable to edit workspace file.",
      content: error.code === "file_changed"
        ? "The file changed after approval; no replacement was performed."
        : error.code === "temporary_file_changed"
          ? "The prepared replacement changed before use; no replacement was performed."
          : "Atomic file replacement failed; the original target was preserved.",
      metadata: {
        tool: "edit_file",
        phase,
        error: error.code,
        ...(error.operation === undefined ? {} : { operation: error.operation }),
      },
    };
  }
  return {
    status: contextSignalAborted(error) ? "interrupted" as const : "failure" as const,
    summary: contextSignalAborted(error) ? "File edit was interrupted." : "Unable to edit workspace file.",
    content: contextSignalAborted(error)
      ? "The file edit was interrupted."
      : "The file could not be edited.",
    metadata: {
      tool: "edit_file",
      phase,
      error: contextSignalAborted(error) ? "cancelled" : "filesystem_error",
    },
  };
}

function contextSignalAborted(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function editApprovalInterrupted(code: ApprovalInterruptionCode) {
  const content: Record<ApprovalInterruptionCode, string> = {
    approval_timeout: "Approval request timed out; no local side effect occurred.",
    approval_cancelled: "Approval request was cancelled; no local side effect occurred.",
    approval_disconnected: "Approval client disconnected; no local side effect occurred.",
    approval_protocol_failure: "Approval protocol failed; no local side effect occurred.",
  };
  return {
    status: "interrupted" as const,
    summary: "File edit approval was interrupted.",
    content: content[code],
    metadata: {
      tool: "edit_file",
      phase: "approval",
      error: code,
      sideEffects: "none",
    },
  };
}

function throwIfApplyAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new EditFileApplyError("interrupted");
  }
}

async function readApprovedSnapshot(
  prepared: PreparedEditFile,
  context: ToolContext,
): Promise<{ absolutePath: string; text: string }> {
  let handle: FileHandle | undefined;
  try {
    throwIfApplyAborted(context.signal);
    const opened = await context.workspace.openFileForReplacement(prepared.input.path);
    handle = opened.handle;
    const bytes = await handle.readFile();
    throwIfApplyAborted(context.signal);
    const stats = await handle.stat({ bigint: true });
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (
      !stats.isFile()
      || stats.dev === 0n
      || stats.ino === 0n
      || stats.dev !== prepared.identity.dev
      || stats.ino !== prepared.identity.ino
      || digest !== prepared.digest
    ) {
      throw new EditFileApplyError("file_changed");
    }
    return {
      absolutePath: opened.resolved.absolutePath,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    };
  } catch (error) {
    if (error instanceof EditFileApplyError) {
      throw error;
    }
    if (context.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new EditFileApplyError("interrupted");
    }
    throw new EditFileApplyError("file_changed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function runAtomicOperation<T>(
  operation: NonNullable<EditFileApplyError["operation"]>,
  context: ToolContext,
  options: ApplyPreparedEditFileOptions,
  action: () => Promise<T>,
): Promise<T> {
  try {
    await options.beforeOperation?.(operation);
    throwIfApplyAborted(context.signal);
    return await action();
  } catch (error) {
    if (error instanceof EditFileApplyError) {
      throw error;
    }
    if (context.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new EditFileApplyError("interrupted");
    }
    throw new EditFileApplyError("atomic_replace_failed", operation);
  }
}

function hasIdentity(
  stats: { dev: bigint; ino: bigint; isFile(): boolean },
  identity: EditFileIdentity,
): boolean {
  return stats.isFile()
    && stats.dev !== 0n
    && stats.ino !== 0n
    && stats.dev === identity.dev
    && stats.ino === identity.ino;
}

async function verifyTemporarySnapshot(
  temporaryPath: string,
  identity: EditFileIdentity,
  expectedDigest: string,
  context: ToolContext,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    throwIfApplyAborted(context.signal);
    const beforeOpen = await lstat(temporaryPath, { bigint: true });
    if (!hasIdentity(beforeOpen, identity)) {
      throw new EditFileApplyError("temporary_file_changed");
    }
    handle = await open(temporaryPath, "r");
    const bytes = await handle.readFile();
    const openedStats = await handle.stat({ bigint: true });
    const afterRead = await lstat(temporaryPath, { bigint: true });
    throwIfApplyAborted(context.signal);
    if (
      !hasIdentity(openedStats, identity)
      || !hasIdentity(afterRead, identity)
      || createHash("sha256").update(bytes).digest("hex") !== expectedDigest
    ) {
      throw new EditFileApplyError("temporary_file_changed");
    }
  } catch (error) {
    if (error instanceof EditFileApplyError) {
      throw error;
    }
    if (context.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new EditFileApplyError("interrupted");
    }
    throw new EditFileApplyError("temporary_file_changed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeOwnedTemporary(
  temporaryPath: string,
  identity: EditFileIdentity | undefined,
): Promise<void> {
  if (identity === undefined) {
    return;
  }
  try {
    const current = await lstat(temporaryPath, { bigint: true });
    if (hasIdentity(current, identity)) {
      await unlink(temporaryPath);
    }
  } catch {
    // Cleanup is best-effort; never delete a path whose owned identity cannot be proven.
  }
}

async function readRegularFileIdentity(handle: FileHandle): Promise<EditFileIdentity | undefined> {
  const stats = await handle.stat({ bigint: true });
  if (!stats.isFile() || stats.dev === 0n || stats.ino === 0n) {
    return undefined;
  }
  return { dev: stats.dev, ino: stats.ino };
}

export async function prepareEditFile(input: EditFileInput, context: ToolContext): Promise<PreparedEditFile> {
  let handle: FileHandle | undefined;
  try {
    throwIfAborted(context.signal);
    const opened = await context.workspace.openFileForReplacement(
      input.path,
      async (resolved) => {
        await context.accessBarrier?.({ kind: "file_resolved", path: resolved.relativePath });
        throwIfAborted(context.signal);
      },
      async (resolved) => {
        await context.accessBarrier?.({ kind: "file_opened", path: resolved.relativePath });
        throwIfAborted(context.signal);
      },
    );
    handle = opened.handle;
    throwIfAborted(context.signal);
    const bytes = await handle.readFile();
    throwIfAborted(context.signal);
    if (bytes.includes(0)) {
      throw new EditFilePreparationError("unsupported_encoding");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new EditFilePreparationError("unsupported_encoding");
      }
      throw error;
    }
    const replacementCount = countOccurrences(text, input.oldText);
    if (!input.replaceAll && replacementCount !== 1) {
      throw new EditFilePreparationError(replacementCount === 0 ? "match_not_found" : "match_not_unique");
    }
    if (input.replaceAll && replacementCount === 0) {
      throw new EditFilePreparationError("match_not_found");
    }
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || stats.dev === 0n || stats.ino === 0n) {
      throw new EditFilePreparationError("interrupted");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const safeInput = { ...input };
    return {
      input: safeInput,
      path: opened.resolved.relativePath,
      replacementCount,
      digest,
      identity: { dev: stats.dev, ino: stats.ino },
      mode: Number(stats.mode),
      permission: {
        kind: "write",
        title: "Edit workspace file",
        preview: {
          path: opened.resolved.relativePath,
          replacementCount,
          before: previewText(safeInput.oldText),
          after: previewText(safeInput.newText),
          sha256: digest,
        },
      },
    };
  } catch (error) {
    if (context.signal.aborted) {
      throw new EditFilePreparationError("interrupted");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function applyPreparedEditFile(
  prepared: PreparedEditFile,
  context: ToolContext,
  options: ApplyPreparedEditFileOptions = {},
): Promise<AppliedEditFile> {
  let temporaryHandle: FileHandle | undefined;
  let temporaryPath: string | undefined;
  let temporaryIdentity: EditFileIdentity | undefined;
  let temporaryCreated = false;
  let replaced = false;
  try {
    const opened = await readApprovedSnapshot(prepared, context);
    const replacement = replaceExact(
      opened.text,
      prepared.input.oldText,
      prepared.input.newText,
      prepared.input.replaceAll,
    );
    const replacementBytes = Buffer.from(replacement, "utf8");
    const replacementDigest = createHash("sha256").update(replacementBytes).digest("hex");

    const name = options.createTemporaryName?.() ?? randomUUID();
    const createdPath = join(dirname(opened.absolutePath), `.awacode-edit-${name}.tmp`);
    temporaryPath = createdPath;
    const created = await runAtomicOperation("create", context, options, async () => {
      const handle = await open(createdPath, "wx", prepared.mode & 0o777);
      temporaryHandle = handle;
      temporaryCreated = true;
      const identity = await readRegularFileIdentity(handle);
      if (identity === undefined) {
        throw new EditFileApplyError("atomic_replace_failed", "create");
      }
      temporaryIdentity = identity;
      return { handle, identity };
    });
    const createdHandle = created.handle;
    await runAtomicOperation("write", context, options, async () => {
      await createdHandle.writeFile(replacementBytes);
      await createdHandle.chmod(prepared.mode & 0o777);
    });
    await runAtomicOperation("sync", context, options, async () => {
      await createdHandle.sync();
    });
    await createdHandle.close();
    temporaryHandle = undefined;
    throwIfApplyAborted(context.signal);
    await options.barrier?.("before_replace");
    throwIfApplyAborted(context.signal);
    const pathToReplace = temporaryPath;
    const identityToReplace = created.identity;
    await runAtomicOperation("replace", context, options, async () => {
      await verifyTemporarySnapshot(
        pathToReplace,
        identityToReplace,
        replacementDigest,
        context,
      );
      const finalSnapshot = await readApprovedSnapshot(prepared, context);
      throwIfApplyAborted(context.signal);
      await (options.atomicReplace ?? nodeAtomicReplace).replace(pathToReplace, finalSnapshot.absolutePath);
    });
    replaced = true;
    return {
      path: prepared.path,
      replacementCount: prepared.replacementCount,
      replaceAll: prepared.input.replaceAll,
    };
  } finally {
    if (temporaryIdentity === undefined && temporaryHandle !== undefined) {
      temporaryIdentity = await readRegularFileIdentity(temporaryHandle).catch(() => undefined);
    }
    await temporaryHandle?.close().catch(() => undefined);
    if (temporaryPath !== undefined && temporaryCreated && !replaced) {
      await removeOwnedTemporary(temporaryPath, temporaryIdentity);
    }
  }
}

export function executeEditFile(options: ExecuteEditFileOptions) {
  return runApprovedTool({
    callId: options.callId,
    store: options.store,
    permissionClient: options.permissionClient,
    context: options.context,
    tool: {
      name: editFileTool.name,
      validate: editFileTool.validate,
      prepare: prepareEditFile,
      permission: (prepared) => prepared.permission,
      denied: () => ({
        status: "denied",
        summary: "File edit was denied.",
        content: "The file edit was not authorized and no local side effect occurred.",
        metadata: { tool: "edit_file", approval: "denied", sideEffects: "none" },
      }),
      approvalInterrupted: editApprovalInterrupted,
      failed: editFileFailure,
      async execute(prepared, context) {
        const applied = await applyPreparedEditFile(prepared, context, options.applyOptions);
        return {
          status: "success",
          summary: `Edited ${applied.replacementCount} ${applied.replacementCount === 1 ? "occurrence" : "occurrences"} in the workspace file.`,
          content: `Updated ${applied.path} with ${applied.replacementCount} exact ${applied.replacementCount === 1 ? "replacement" : "replacements"}.`,
          metadata: {
            path: applied.path,
            replacementCount: applied.replacementCount,
            replaceAll: applied.replaceAll,
          },
        };
      },
    },
  });
}

function validateEditFileInput(value: unknown): EditFileInput {
  const input = assertExactPlainObject(
    value,
    ["path", "old_text", "new_text", "replace_all"],
    ["path", "old_text", "new_text"],
  );
  const path = input.path;
  const oldText = input.old_text;
  const newText = input.new_text;
  const replaceAll = Object.hasOwn(input, "replace_all") ? input.replace_all : false;
  if (
    typeof path !== "string"
    || path.trim().length === 0
    || typeof oldText !== "string"
    || oldText.length === 0
    || typeof newText !== "string"
    || typeof replaceAll !== "boolean"
  ) {
    throw new ToolValidationError();
  }
  return { path, oldText, newText, replaceAll };
}

export const editFileTool: ToolDefinition<EditFileInput> = {
  name: "edit_file",
  description: "Replace exact text in an existing UTF-8 workspace file after one-shot approval.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "old_text", "new_text"],
    properties: {
      path: { type: "string", minLength: 1 },
      old_text: { type: "string", minLength: 1 },
      new_text: { type: "string" },
      replace_all: { type: "boolean" },
    },
  },
  approval: "write",
  validate: validateEditFileInput,
  execute(_input, context) {
    const runtime = context.approvedToolRuntime;
    if (runtime === undefined) {
      throw new ToolExecutionError();
    }
    return executeEditFile({
      callId: runtime.callId,
      store: runtime.store,
      permissionClient: runtime.permissionClient,
      context,
    });
  },
};
