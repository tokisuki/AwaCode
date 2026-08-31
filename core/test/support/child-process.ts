import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

export interface ChildLineReader {
  nextLine(timeoutMs?: number): Promise<string>;
  close(): void;
}

export interface ChildChannel {
  child: ChildProcessWithoutNullStreams;
  lines: ChildLineReader;
  exited: Promise<[number | null, NodeJS.Signals | null]>;
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
  let closed = false;

  const onStderr = (chunk: Buffer) => diagnostics.push(Buffer.from(chunk));
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
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    terminalError = new Error(
      `initializer exited before its next line (code=${String(code)}, signal=${String(signal)}): ${Buffer.concat(diagnostics).toString("utf8")}`,
    );
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(terminalError);
    }
  };
  child.stderr.on("data", onStderr);
  child.stdout.on("data", onStdout);
  child.once("exit", onExit);

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
            rejectLine(new Error(`initializer did not emit its next line within ${timeoutMs} ms`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      child.stderr.off("data", onStderr);
      child.stdout.off("data", onStdout);
      child.off("exit", onExit);
      terminalError = new Error("child line reader closed");
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(terminalError);
      }
    },
  };
}

export function createChildChannel(child: ChildProcessWithoutNullStreams): ChildChannel {
  return {
    child,
    lines: childLineReader(child),
    exited: once(child, "exit").then(([code, signal]) => [
      code as number | null,
      signal as NodeJS.Signals | null,
    ]),
  };
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

export async function disposeChildChannel(
  channel: ChildChannel,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  let failure: unknown;
  try {
    if (channel.child.exitCode === null) {
      channel.child.kill();
      await withTimeout(channel.exited, timeoutMs, label);
    }
  } catch (error) {
    failure = error;
  } finally {
    const cleanupActions = [
      () => channel.lines.close(),
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
  timeoutMs = 5000,
): Promise<void> {
  const results = await Promise.allSettled(
    channels.map((channel) => disposeChildChannel(channel, label, timeoutMs)),
  );
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `${label} failed for ${failures.length} children`);
  }
}
