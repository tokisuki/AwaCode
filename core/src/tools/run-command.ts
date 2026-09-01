import { Buffer } from "node:buffer";
import { constants as osConstants } from "node:os";
import { open, stat, type FileHandle } from "node:fs/promises";

import { WorkspaceGuardError } from "../security/workspace-guard.ts";
import type { SessionStore } from "../persistence/session-store.ts";
import {
  assertExactPlainObject,
  ToolExecutionError,
  ToolValidationError,
  type ToolDefinition,
  type ToolContext,
} from "./contracts.ts";
import {
  ApprovedToolBindingError,
  runApprovedTool,
  type ApprovalInterruptionCode,
  type ToolResultDraft,
} from "./approved-tool-runner.ts";
import type { PermissionClient } from "./permission.ts";
import {
  COMMAND_PERMISSION_WARNING,
  type CommandPermissionRequest,
} from "./permission.ts";
import {
  executeCommandProcess,
  type CommandProcessAdapter,
  type CommandProcessResult,
  type CommandTimer,
  type CommandTreeTerminator,
} from "./command-process.ts";

export const MAX_COMMAND_BYTES = 16 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const MAX_COMMAND_TIMEOUT_MS = 180_000;

export interface RunCommandInput {
  command: string;
  cwd: string;
  timeoutMs: number;
}

export interface CommandDirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

export interface PreparedRunCommand {
  readonly input: RunCommandInput;
  readonly cwd: string;
  readonly absoluteCwd: string;
  readonly identity: CommandDirectoryIdentity;
  readonly permission: Omit<CommandPermissionRequest, "callId">;
}

export class CommandExecutionError extends Error {
  readonly code: "cwd_changed";

  constructor(code: CommandExecutionError["code"]) {
    super("Approved command could not be executed.");
    this.name = "CommandExecutionError";
    this.code = code;
  }
}

export interface ExecutePreparedRunCommandOptions {
  environment?: NodeJS.ProcessEnv;
  processAdapter?: CommandProcessAdapter;
  timer?: CommandTimer;
  treeTerminator?: CommandTreeTerminator;
}

export interface ExecuteRunCommandOptions extends ExecutePreparedRunCommandOptions {
  callId: string;
  store: SessionStore;
  permissionClient: PermissionClient;
  context: ToolContext;
}

function sameDirectoryIdentity(
  left: { dev: bigint; ino: bigint; isDirectory(): boolean },
  right: { dev: bigint; ino: bigint; isDirectory(): boolean },
): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev !== 0n
    && left.ino !== 0n
    && left.dev === right.dev
    && left.ino === right.ino;
}

export async function prepareRunCommand(
  input: RunCommandInput,
  context: ToolContext,
): Promise<PreparedRunCommand> {
  let handle: FileHandle | undefined;
  try {
    const initial = await context.workspace.resolveDirectory(input.cwd);
    await context.accessBarrier?.({ kind: "directory_resolved", path: initial.relativePath });
    handle = await open(initial.absolutePath, "r");
    const openedStats = await handle.stat({ bigint: true });
    await context.accessBarrier?.({ kind: "directory_opened", path: initial.relativePath });
    const revalidated = await context.workspace.resolveDirectory(input.cwd);
    const pathStats = await stat(revalidated.absolutePath, { bigint: true });
    if (!sameDirectoryIdentity(openedStats, pathStats)) {
      throw new WorkspaceGuardError("path_changed");
    }
    const safeInput = { ...input };
    return {
      input: safeInput,
      cwd: revalidated.relativePath,
      absoluteCwd: revalidated.absolutePath,
      identity: { dev: openedStats.dev, ino: openedStats.ino },
      permission: {
        kind: "command",
        title: "Run shell command",
        preview: {
          command: safeInput.command,
          cwd: revalidated.relativePath,
          timeoutMs: safeInput.timeoutMs,
          warning: COMMAND_PERMISSION_WARNING,
        },
      },
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function executePreparedRunCommand(
  prepared: PreparedRunCommand,
  context: ToolContext,
  options: ExecutePreparedRunCommandOptions = {},
): Promise<CommandProcessResult> {
  if (context.signal.aborted) {
    return executeCommandProcess({
      command: prepared.input.command,
      cwd: prepared.absoluteCwd,
      timeoutMs: prepared.input.timeoutMs,
      signal: context.signal,
      ...options,
    });
  }
  let handle: FileHandle | undefined;
  try {
    const initial = await context.workspace.resolveDirectory(prepared.input.cwd);
    handle = await open(initial.absolutePath, "r");
    const openedStats = await handle.stat({ bigint: true });
    const revalidated = await context.workspace.resolveDirectory(prepared.input.cwd);
    const pathStats = await stat(revalidated.absolutePath, { bigint: true });
    if (
      !sameDirectoryIdentity(openedStats, pathStats)
      || openedStats.dev !== prepared.identity.dev
      || openedStats.ino !== prepared.identity.ino
    ) {
      throw new CommandExecutionError("cwd_changed");
    }
    return await executeCommandProcess({
      command: prepared.input.command,
      cwd: revalidated.absolutePath,
      timeoutMs: prepared.input.timeoutMs,
      signal: context.signal,
      ...options,
    });
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      throw error;
    }
    throw new CommandExecutionError("cwd_changed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function commandMetadata(prepared: PreparedRunCommand, result: CommandProcessResult) {
  const safeSignal = result.signal !== null && Object.hasOwn(osConstants.signals, result.signal)
    ? result.signal
    : null;
  return {
    cwd: prepared.cwd,
    timeoutMs: prepared.input.timeoutMs,
    exitCode: result.exitCode,
    signal: safeSignal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    terminationFailed: result.terminationFailed,
    terminationFailureCode: result.terminationFailureCode,
    stdoutBytes: result.stdout.originalBytes,
    stdoutRetainedBytes: result.stdout.retainedBytes,
    stdoutOmittedBytes: result.stdout.omittedBytes,
    stdoutDisplayedBytes: result.stdout.displayedBytes,
    stdoutTruncated: result.stdout.truncated,
    stderrBytes: result.stderr.originalBytes,
    stderrRetainedBytes: result.stderr.retainedBytes,
    stderrOmittedBytes: result.stderr.omittedBytes,
    stderrDisplayedBytes: result.stderr.displayedBytes,
    stderrTruncated: result.stderr.truncated,
  };
}

function commandOutput(result: CommandProcessResult): string {
  return `STDOUT:\n${result.stdout.text.length === 0 ? "(empty)" : result.stdout.text}\nSTDERR:\n${result.stderr.text.length === 0 ? "(empty)" : result.stderr.text}`;
}

function commandProcessDraft(
  prepared: PreparedRunCommand,
  result: CommandProcessResult,
): ToolResultDraft {
  const metadata = commandMetadata(prepared, result);
  const output = commandOutput(result);
  if (result.timedOut || result.cancelled) {
    return {
      status: "interrupted",
      summary: result.timedOut ? "Command timed out." : "Command was cancelled.",
      content: `${result.timedOut ? "The approved command exceeded its timeout." : "The approved command was cancelled."}\n\n${output}`,
      metadata,
    };
  }
  if (result.spawnFailed) {
    return {
      status: "failure",
      summary: "Unable to start command.",
      content: `The approved command could not be started.\n\n${output}`,
      metadata,
    };
  }
  if (metadata.signal !== null) {
    return {
      status: "failure",
      summary: "Command was terminated by an external signal.",
      content: `The command ended because of signal ${metadata.signal}.\n\n${output}`,
      metadata,
    };
  }
  if (result.exitCode === 0) {
    return {
      status: "success",
      summary: "Command completed successfully.",
      content: output,
      metadata,
    };
  }
  return {
    status: "failure",
    summary: "Command exited with a nonzero status.",
    content: `${result.exitCode === null ? "The command ended without a usable exit status." : `The command exited with code ${result.exitCode}.`}\n\n${output}`,
    metadata,
  };
}

function commandApprovalInterrupted(code: ApprovalInterruptionCode): ToolResultDraft {
  const content: Record<ApprovalInterruptionCode, string> = {
    approval_timeout: "Approval request timed out; the command was not started.",
    approval_cancelled: "Approval request was cancelled; the command was not started.",
    approval_disconnected: "Approval client disconnected; the command was not started.",
    approval_protocol_failure: "Approval protocol failed; the command was not started.",
  };
  return {
    status: "interrupted",
    summary: "Command approval was interrupted.",
    content: content[code],
    metadata: { tool: "run_command", phase: "approval", error: code, sideEffects: "none" },
  };
}

function commandFailure(error: unknown, phase: "preparation" | "execution"): ToolResultDraft {
  if (error instanceof ApprovedToolBindingError) {
    return {
      status: "failure",
      summary: "Unable to run command.",
      content: error.code === "persisted_tool_mismatch"
        ? "Persisted tool call does not match run_command."
        : "Persisted tool input is malformed.",
      metadata: { tool: "run_command", phase, error: error.code },
    };
  }
  if (error instanceof ToolValidationError) {
    return {
      status: "failure",
      summary: "Unable to run command.",
      content: "Tool input is invalid.",
      metadata: { tool: "run_command", phase, error: error.code },
    };
  }
  if (error instanceof CommandExecutionError) {
    return {
      status: "failure",
      summary: "Unable to run command.",
      content: "The approved working directory changed before the command started.",
      metadata: { tool: "run_command", phase, error: error.code },
    };
  }
  if (error instanceof WorkspaceGuardError) {
    return {
      status: "failure",
      summary: "Unable to run command.",
      content: error.message,
      metadata: { tool: "run_command", phase, error: error.code },
    };
  }
  return {
    status: "failure",
    summary: "Unable to run command.",
    content: "The command could not be executed.",
    metadata: { tool: "run_command", phase, error: "execution_failed" },
  };
}

export function executeRunCommand(options: ExecuteRunCommandOptions) {
  const executionOptions: ExecutePreparedRunCommandOptions = {
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.processAdapter === undefined ? {} : { processAdapter: options.processAdapter }),
    ...(options.timer === undefined ? {} : { timer: options.timer }),
    ...(options.treeTerminator === undefined ? {} : { treeTerminator: options.treeTerminator }),
  };
  return runApprovedTool({
    callId: options.callId,
    store: options.store,
    permissionClient: options.permissionClient,
    context: options.context,
    tool: {
      name: runCommandTool.name,
      validate: runCommandTool.validate,
      prepare: prepareRunCommand,
      permission: (prepared) => prepared.permission,
      denied: () => ({
        status: "denied",
        summary: "Command was denied.",
        content: "The command was not authorized and was not started.",
        metadata: { tool: "run_command", approval: "denied", sideEffects: "none" },
      }),
      approvalInterrupted: commandApprovalInterrupted,
      failed: commandFailure,
      async execute(prepared, context) {
        const result = await executePreparedRunCommand(prepared, context, executionOptions);
        return commandProcessDraft(prepared, result);
      },
    },
  });
}

export function validateRunCommandInput(value: unknown): RunCommandInput {
  const input = assertExactPlainObject(
    value,
    ["command", "cwd", "timeout_ms"],
    ["command"],
  );
  const command = input.command;
  const cwd = Object.hasOwn(input, "cwd") ? input.cwd : ".";
  const timeoutMs = Object.hasOwn(input, "timeout_ms")
    ? input.timeout_ms
    : DEFAULT_COMMAND_TIMEOUT_MS;
  if (
    typeof command !== "string"
    || command.trim().length === 0
    || command.includes("\0")
    || Buffer.byteLength(command) > MAX_COMMAND_BYTES
    || typeof cwd !== "string"
    || cwd.length === 0
    || typeof timeoutMs !== "number"
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > MAX_COMMAND_TIMEOUT_MS
  ) {
    throw new ToolValidationError();
  }
  return { command, cwd, timeoutMs };
}

export const runCommandTool: ToolDefinition<RunCommandInput> = {
  name: "run_command",
  description: "Execute an approved shell command from a workspace directory with bounded output and runtime.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_BYTES },
      cwd: { type: "string", minLength: 1 },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_COMMAND_TIMEOUT_MS },
    },
  },
  approval: "command",
  validate: validateRunCommandInput,
  execute(_input, context) {
    const runtime = context.approvedToolRuntime;
    if (runtime === undefined) {
      throw new ToolExecutionError();
    }
    return executeRunCommand({
      callId: runtime.callId,
      store: runtime.store,
      permissionClient: runtime.permissionClient,
      context,
    });
  },
};
