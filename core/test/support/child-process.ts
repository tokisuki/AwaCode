import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { resolve } from "node:path";

export interface ChildLineReader {
  nextLine(timeoutMs?: number): Promise<string>;
  close(): void;
}

export type ChildExit = [code: number | null, signal: NodeJS.Signals | null];

export interface ChildChannel {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: ChildLineReader;
  readonly exited: Promise<ChildExit>;
  readonly closed: Promise<ChildExit>;
  readonly processGroup: boolean;
  isClosed(): boolean;
  disposeListeners(): void;
}

export interface ChildChannelOptions {
  processGroup?: boolean;
}

export interface ChildTerminationOptions {
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
}

export function childLineReader(child: ChildProcessWithoutNullStreams): ChildLineReader {
  const lines: string[] = [];
  const waiters: Array<{
    resolve(line: string): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout;
  }> = [];
  const diagnostics: Buffer[] = [];
  let partial = "";
  let terminalError: Error | undefined;
  let disposed = false;

  const rejectWaiters = (error: Error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  };
  const finishStdout = (detail: string) => {
    if (terminalError !== undefined) {
      return;
    }
    const incomplete = partial.length === 0 ? "" : `; incomplete stdout: ${JSON.stringify(partial)}`;
    terminalError = new Error(
      `child stdout ${detail} before its next line${incomplete}: ${Buffer.concat(diagnostics).toString("utf8")}`,
    );
    rejectWaiters(terminalError);
  };
  const onStderr = (chunk: Buffer) => diagnostics.push(Buffer.from(chunk));
  const onStderrError = (error: Error) => diagnostics.push(Buffer.from(error.message));
  const onStdout = (chunk: Buffer) => {
    partial += chunk.toString("utf8");
    let newline = partial.indexOf("\n");
    while (newline >= 0) {
      const line = partial.slice(0, newline).replace(/\r$/, "");
      partial = partial.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter === undefined) {
        lines.push(line);
      } else {
        clearTimeout(waiter.timeout);
        waiter.resolve(line);
      }
      newline = partial.indexOf("\n");
    }
  };
  const onStdoutEnd = () => finishStdout("ended");
  const onStdoutClose = () => finishStdout("closed");
  const onStdoutError = (error: Error) => finishStdout(`failed (${error.message})`);
  child.stderr.on("data", onStderr);
  child.stderr.on("error", onStderrError);
  child.stdout.on("data", onStdout);
  child.stdout.once("end", onStdoutEnd);
  child.stdout.once("close", onStdoutClose);
  child.stdout.once("error", onStdoutError);

  return {
    nextLine(timeoutMs = 5000) {
      const line = lines.shift();
      if (line !== undefined) {
        return Promise.resolve(line);
      }
      if (terminalError !== undefined) {
        return Promise.reject(terminalError);
      }
      return new Promise<string>((resolveLine, rejectLine) => {
        const waiter = {
          resolve: resolveLine,
          reject: rejectLine,
          timeout: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            rejectLine(new Error(`child did not emit its next line within ${timeoutMs} ms`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    close() {
      if (disposed) {
        return;
      }
      disposed = true;
      child.stderr.off("data", onStderr);
      child.stderr.off("error", onStderrError);
      child.stdout.off("data", onStdout);
      child.stdout.off("end", onStdoutEnd);
      child.stdout.off("close", onStdoutClose);
      child.stdout.off("error", onStdoutError);
      terminalError = new Error("child line reader closed");
      rejectWaiters(terminalError);
    },
  };
}

export function createChildChannel(
  child: ChildProcessWithoutNullStreams,
  options: ChildChannelOptions = {},
): ChildChannel {
  const lines = childLineReader(child);
  let resolveExit = (_result: ChildExit) => {};
  let resolveClose = (_result: ChildExit) => {};
  let closed = false;
  let disposed = false;
  const exited = new Promise<ChildExit>((resolveExited) => {
    resolveExit = resolveExited;
  });
  const closePromise = new Promise<ChildExit>((resolveClosed) => {
    resolveClose = resolveClosed;
  });
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    resolveExit([code, signal]);
  };
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    closed = true;
    resolveClose([code, signal]);
  };
  const onError = () => {
    // A failed spawn is followed by close; this listener prevents an unhandled error event.
  };
  child.once("exit", onExit);
  child.once("close", onClose);
  child.on("error", onError);

  return {
    child,
    lines,
    exited,
    closed: closePromise,
    processGroup: options.processGroup ?? false,
    isClosed: () => closed,
    disposeListeners() {
      if (disposed) {
        return;
      }
      disposed = true;
      lines.close();
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onError);
    },
  };
}

export function spawnChildChannel(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio = {},
): ChildChannel {
  const processGroup = process.platform !== "win32";
  const child = spawn(command, [...args], {
    ...options,
    detached: processGroup,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return createChildChannel(child, { processGroup });
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export function waitForChildExit(
  channel: ChildChannel,
  timeoutMs: number,
  label: string,
): Promise<ChildExit> {
  return withTimeout(channel.exited, timeoutMs, label);
}

function timeoutValue(value: number | undefined, fallback: number, name: string): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return timeout;
}

function windowsTaskkill(pid: number, force: boolean, timeoutMs: number): Promise<boolean> {
  const systemRoot = process.env.SystemRoot?.trim();
  const executable = systemRoot === undefined || systemRoot.length === 0
    ? "taskkill.exe"
    : resolve(systemRoot, "System32", "taskkill.exe");
  const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
  return new Promise((resolveTaskkill) => {
    execFile(executable, args, {
      windowsHide: true,
      timeout: Math.max(1, timeoutMs),
    }, (error) => resolveTaskkill(error === null));
  });
}

function signalPosix(channel: ChildChannel, signal: NodeJS.Signals): void {
  const pid = channel.child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    if (channel.processGroup) {
      process.kill(-pid, signal);
    } else {
      channel.child.kill(signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function requestTermination(
  channel: ChildChannel,
  force: boolean,
  timeoutMs: number,
): Promise<void> {
  const pid = channel.child.pid;
  if (pid === undefined) {
    return Promise.resolve();
  }
  if (process.platform === "win32") {
    return windowsTaskkill(pid, force, timeoutMs).then((treeTerminated) => {
      if (!treeTerminated && !channel.isClosed()) {
        channel.child.kill(force ? "SIGKILL" : "SIGTERM");
      }
    });
  }
  signalPosix(channel, force ? "SIGKILL" : "SIGTERM");
  return Promise.resolve();
}

async function requestAndConfirmTermination(
  channel: ChildChannel,
  force: boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  await requestTermination(channel, force, timeoutMs);
  await withTimeout(channel.closed, timeoutMs, label);
}

async function terminateChild(
  channel: ChildChannel,
  label: string,
  options: ChildTerminationOptions,
): Promise<void> {
  const gracefulTimeoutMs = timeoutValue(options.gracefulTimeoutMs, 5000, "gracefulTimeoutMs");
  const forceTimeoutMs = timeoutValue(options.forceTimeoutMs, 5000, "forceTimeoutMs");
  try {
    await requestAndConfirmTermination(
      channel,
      false,
      gracefulTimeoutMs,
      `${label} graceful termination`,
    );
  } catch (gracefulError) {
    try {
      await requestAndConfirmTermination(
        channel,
        true,
        forceTimeoutMs,
        `${label} forced termination`,
      );
    } catch (forceError) {
      throw new AggregateError(
        [gracefulError, forceError],
        `${label} did not close after graceful and forced termination`,
      );
    }
  }
}

export async function disposeChildChannel(
  channel: ChildChannel,
  label: string,
  options: ChildTerminationOptions = {},
): Promise<void> {
  let failure: unknown;
  try {
    if (!channel.isClosed()) {
      await terminateChild(channel, label, options);
    }
  } catch (error) {
    failure = error;
  } finally {
    const cleanupActions = [
      () => channel.disposeListeners(),
      () => channel.child.stdin.destroy(),
      () => channel.child.stdout.destroy(),
      () => channel.child.stderr.destroy(),
    ];
    for (const cleanup of cleanupActions) {
      try {
        cleanup();
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
}

export async function disposeChildChannels(
  channels: readonly ChildChannel[],
  label: string,
  options: ChildTerminationOptions = {},
): Promise<void> {
  const results = await Promise.allSettled(
    channels.map((channel) => disposeChildChannel(channel, label, options)),
  );
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `${label} failed for ${failures.length} children`);
  }
}
