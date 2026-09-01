import {
  execFile,
  spawn,
  type ChildProcessByStdio,
} from "node:child_process";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

import { filterChildEnvironment } from "./child-environment.ts";

export interface ShellPlatformAdapter {
  platform: NodeJS.Platform;
  windowsPowerShellExecutable: string;
}

export interface ShellInvocation {
  executable: string;
  args: string[];
}

export interface ExecuteCommandProcessOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  processAdapter?: CommandProcessAdapter;
  timer?: CommandTimer;
  treeTerminator?: CommandTreeTerminator;
}

export interface CommandProcessResult {
  stdout: CapturedCommandStream;
  stderr: CapturedCommandStream;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnFailed: boolean;
  terminationFailed: boolean;
  terminationFailureCode: string | null;
}

type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

export interface CommandProcessAdapter extends ShellPlatformAdapter {
  spawn(
    executable: string,
    args: readonly string[],
    options: Parameters<typeof spawn>[2],
  ): CommandChild;
}

export interface CommandTimer {
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface CommandTreeTermination {
  failed: boolean;
  code: string | null;
}

export interface CommandTreeTerminator {
  terminate(
    child: CommandChild,
    platform: NodeJS.Platform,
    closed: Promise<[number | null, NodeJS.Signals | null]>,
  ): Promise<CommandTreeTermination>;
}

const systemCommandTimer: CommandTimer = {
  schedule(delayMs, callback) {
    const timeout = setTimeout(callback, delayMs);
    return () => clearTimeout(timeout);
  },
};

function systemProcessAdapter(): CommandProcessAdapter {
  const systemRoot = process.env.SystemRoot?.trim();
  return {
    platform: process.platform,
    windowsPowerShellExecutable: systemRoot === undefined || systemRoot.length === 0
      ? "powershell.exe"
      : resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    spawn(executable, args, options) {
      return spawn(executable, [...args], options) as CommandChild;
    },
  };
}

async function boundedWait<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function signalProcessGroup(child: CommandChild, signal: NodeJS.Signals): boolean {
  const pid = child.pid;
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function runWindowsTaskkill(pid: number): Promise<boolean> {
  const systemRoot = process.env.SystemRoot?.trim();
  const executable = systemRoot === undefined || systemRoot.length === 0
    ? "taskkill.exe"
    : resolve(systemRoot, "System32", "taskkill.exe");
  return new Promise((resolveTaskkill) => {
    execFile(executable, ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      timeout: 5_000,
    }, (error) => resolveTaskkill(error === null));
  });
}

const systemTreeTerminator: CommandTreeTerminator = {
  async terminate(child, platform, closed) {
    const pid = child.pid;
    if (pid === undefined) {
      return { failed: true, code: "tree_termination_failed" };
    }
    if (platform === "win32") {
      let taskkillSucceeded = false;
      for (let attempt = 0; attempt < 3 && !taskkillSucceeded; attempt += 1) {
        taskkillSucceeded = await runWindowsTaskkill(pid);
      }
      if (!taskkillSucceeded) {
        child.kill("SIGKILL");
      }
      const closeOutcome = await boundedWait(closed, 5_000);
      const failed = !taskkillSucceeded || closeOutcome === undefined;
      return { failed, code: failed ? "tree_termination_failed" : null };
    }

    let signalFailed = !signalProcessGroup(child, "SIGTERM");
    let closeOutcome = await boundedWait(closed, 250);
    if (closeOutcome === undefined) {
      signalFailed = !signalProcessGroup(child, "SIGKILL") || signalFailed;
      closeOutcome = await boundedWait(closed, 5_000);
    }
    const failed = signalFailed || closeOutcome === undefined;
    return { failed, code: failed ? "tree_termination_failed" : null };
  },
};

export const COMMAND_STREAM_BYTES = 64 * 1024;

export interface CapturedCommandStream {
  text: string;
  truncated: boolean;
  originalBytes: number;
  retainedBytes: number;
  omittedBytes: number;
  displayedBytes: number;
}

interface DecodedSegment {
  rawBytes: number;
  text: string;
  displayedBytes: number;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function utf8SequenceLength(bytes: Buffer, offset: number): number {
  const first = bytes[offset] as number;
  const second = bytes[offset + 1];
  if (first >= 0xc2 && first <= 0xdf && isContinuation(second)) {
    return 2;
  }
  const third = bytes[offset + 2];
  if (
    ((first === 0xe0 && second !== undefined && second >= 0xa0 && second <= 0xbf)
      || ((first >= 0xe1 && first <= 0xec) || (first >= 0xee && first <= 0xef)) && isContinuation(second)
      || (first === 0xed && second !== undefined && second >= 0x80 && second <= 0x9f))
    && isContinuation(third)
  ) {
    return 3;
  }
  const fourth = bytes[offset + 3];
  if (
    ((first === 0xf0 && second !== undefined && second >= 0x90 && second <= 0xbf)
      || (first >= 0xf1 && first <= 0xf3 && isContinuation(second))
      || (first === 0xf4 && second !== undefined && second >= 0x80 && second <= 0x8f))
    && isContinuation(third)
    && isContinuation(fourth)
  ) {
    return 4;
  }
  return first <= 0x7f ? 1 : 0;
}

function incompleteBoundaryStart(bytes: Buffer): number {
  const searchStart = Math.max(0, bytes.length - 3);
  for (let index = searchStart; index < bytes.length; index += 1) {
    const first = bytes[index] as number;
    const expected = first >= 0xc2 && first <= 0xdf
      ? 2
      : first >= 0xe0 && first <= 0xef
        ? 3
        : first >= 0xf0 && first <= 0xf4
          ? 4
          : 0;
    if (expected > 0 && bytes.length - index < expected) {
      const suffix = bytes.subarray(index + 1);
      if ([...suffix].every((byte) => isContinuation(byte))) {
        return index;
      }
    }
  }
  return bytes.length;
}

function decodedSegments(bytes: Buffer): DecodedSegment[] {
  const segments: DecodedSegment[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const sequenceLength = utf8SequenceLength(bytes, offset);
    if (sequenceLength === 0) {
      segments.push({ rawBytes: 1, text: "\ufffd", displayedBytes: 3 });
      offset += 1;
    } else {
      const text = bytes.subarray(offset, offset + sequenceLength).toString("utf8");
      segments.push({ rawBytes: sequenceLength, text, displayedBytes: sequenceLength });
      offset += sequenceLength;
    }
  }
  return segments;
}

function omittedMarker(omittedBytes: number): string {
  return `\n[truncated: ${omittedBytes} bytes omitted]`;
}

export class BoundedStreamCapture {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  private originalBytes = 0;

  write(chunk: Uint8Array): void {
    const bytes = Buffer.from(chunk);
    this.originalBytes += bytes.length;
    const remaining = COMMAND_STREAM_BYTES - this.capturedBytes;
    if (remaining > 0) {
      const retained = Buffer.from(bytes.subarray(0, remaining));
      this.chunks.push(retained);
      this.capturedBytes += retained.length;
    }
  }

  finish(): CapturedCommandStream {
    let captured = Buffer.concat(this.chunks, this.capturedBytes);
    if (this.originalBytes > captured.length) {
      captured = captured.subarray(0, incompleteBoundaryStart(captured));
    }
    const segments = decodedSegments(captured);
    let rawBytes = 0;
    let displayedBytes = 0;
    let bestCount = 0;
    let bestRawBytes = 0;
    let bestDisplayedBytes = 0;
    for (const [index, segment] of segments.entries()) {
      rawBytes += segment.rawBytes;
      displayedBytes += segment.displayedBytes;
      const omittedBytes = this.originalBytes - rawBytes;
      const markerBytes = omittedBytes === 0 ? 0 : Buffer.byteLength(omittedMarker(omittedBytes));
      if (displayedBytes + markerBytes <= COMMAND_STREAM_BYTES) {
        bestCount = index + 1;
        bestRawBytes = rawBytes;
        bestDisplayedBytes = displayedBytes;
      }
    }
    const omittedBytes = this.originalBytes - bestRawBytes;
    const marker = omittedBytes === 0 ? "" : omittedMarker(omittedBytes);
    const text = segments.slice(0, bestCount).map((segment) => segment.text).join("") + marker;
    return {
      text,
      truncated: omittedBytes > 0,
      originalBytes: this.originalBytes,
      retainedBytes: bestRawBytes,
      omittedBytes,
      displayedBytes: bestDisplayedBytes + Buffer.byteLength(marker),
    };
  }
}

export function shellInvocation(
  command: string,
  platform: ShellPlatformAdapter,
): ShellInvocation {
  return platform.platform === "win32"
    ? {
      executable: platform.windowsPowerShellExecutable,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    }
    : { executable: "/bin/sh", args: ["-lc", command] };
}

export async function executeCommandProcess(
  options: ExecuteCommandProcessOptions,
): Promise<CommandProcessResult> {
  if (options.signal.aborted) {
    const stdout = new BoundedStreamCapture().finish();
    const stderr = new BoundedStreamCapture().finish();
    return {
      stdout,
      stderr,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: true,
      spawnFailed: false,
      terminationFailed: false,
      terminationFailureCode: null,
    };
  }
  const adapter = options.processAdapter ?? systemProcessAdapter();
  const invocation = shellInvocation(options.command, adapter);
  let child: CommandChild;
  try {
    child = adapter.spawn(invocation.executable, invocation.args, {
      cwd: options.cwd,
      env: filterChildEnvironment(options.environment ?? process.env),
      detached: adapter.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return {
      stdout: new BoundedStreamCapture().finish(),
      stderr: new BoundedStreamCapture().finish(),
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      spawnFailed: true,
      terminationFailed: false,
      terminationFailureCode: null,
    };
  }
  const stdout = new BoundedStreamCapture();
  const stderr = new BoundedStreamCapture();
  let spawnFailed = false;
  let closed = false;
  let interruption: "timeout" | "cancel" | "setup" | undefined;
  let cancelTimer = () => {};
  let termination: Promise<CommandTreeTermination> | undefined;
  let resolveTerminationSettlement = () => {};
  const terminationSettlement = new Promise<void>((resolveSettlement) => {
    resolveTerminationSettlement = resolveSettlement;
  });
  child.stdout.on("data", (chunk: Buffer) => stdout.write(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.write(chunk));
  child.on("error", () => { spawnFailed = true; });
  const closedPromise = new Promise<[number | null, NodeJS.Signals | null]>((resolveClose) => {
    child.once("close", (code, closeSignal) => {
      closed = true;
      resolveClose([code, closeSignal]);
    });
  });
  const requestInterruption = (cause: "timeout" | "cancel" | "setup") => {
    if (closed || interruption !== undefined) {
      return;
    }
    interruption = cause;
    cancelTimer();
    termination = (options.treeTerminator ?? systemTreeTerminator)
      .terminate(child, adapter.platform, closedPromise)
      .catch(() => ({ failed: true, code: "tree_termination_failed" }))
      .finally(resolveTerminationSettlement);
  };
  const onAbort = () => requestInterruption("cancel");
  options.signal.addEventListener("abort", onAbort, { once: true });
  const onSpawn = () => {
    if (interruption !== undefined || closed || child.pid === undefined) {
      return;
    }
    try {
      cancelTimer = (options.timer ?? systemCommandTimer).schedule(
        options.timeoutMs,
        () => requestInterruption("timeout"),
      );
    } catch {
      spawnFailed = true;
      requestInterruption("setup");
    }
  };
  child.once("spawn", onSpawn);
  if (options.signal.aborted) {
    onAbort();
  }
  const settled = await Promise.race([
    closedPromise.then((value) => ({ kind: "close" as const, value })),
    terminationSettlement.then(() => ({ kind: "termination" as const })),
  ]);
  const closeValue = settled.kind === "close" ? settled.value : undefined;
  const terminationResult = termination === undefined ? undefined : await termination;
  cancelTimer();
  options.signal.removeEventListener("abort", onAbort);
  child.off("spawn", onSpawn);
  const [naturalExitCode, naturalSignal] = closeValue ?? [null, null];
  const interrupted = interruption !== undefined;
  return {
    stdout: stdout.finish(),
    stderr: stderr.finish(),
    exitCode: interrupted ? null : naturalExitCode,
    signal: interrupted ? null : naturalSignal,
    timedOut: interruption === "timeout",
    cancelled: interruption === "cancel",
    spawnFailed,
    terminationFailed: terminationResult?.failed ?? false,
    terminationFailureCode: terminationResult?.code ?? null,
  };
}
