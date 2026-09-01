import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  COMMAND_STREAM_BYTES,
  BoundedStreamCapture,
  type CommandProcessAdapter,
  type CommandTimer,
  type CommandTreeTerminator,
  executeCommandProcess,
  shellInvocation,
} from "../../src/tools/command-process.ts";
import {
  createChildChannel,
  disposeChildChannel,
  type ChildChannel,
  withTimeout,
} from "../support/child-process.ts";

function hostCommand(windows: string, posix: string): string {
  return process.platform === "win32" ? windows : posix;
}

function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

class ManualCommandTimer implements CommandTimer {
  callback: (() => void) | undefined;
  active = 0;
  cancelled = 0;
  delayMs: number | undefined;
  private resolveArmed = () => {};
  readonly armed = new Promise<void>((resolvePromise) => {
    this.resolveArmed = resolvePromise;
  });

  schedule(delayMs: number, callback: () => void): () => void {
    this.delayMs = delayMs;
    this.callback = callback;
    this.active += 1;
    this.resolveArmed();
    return () => {
      if (this.callback !== undefined) {
        this.callback = undefined;
        this.active -= 1;
        this.cancelled += 1;
      }
    };
  }

  fire(): void {
    const callback = this.callback;
    assert.ok(callback, "expected the command timeout to be armed after spawn");
    this.callback = undefined;
    this.active -= 1;
    callback();
  }
}

class LateCommandTimer implements CommandTimer {
  callback: (() => void) | undefined;
  cancelled = 0;
  private resolveArmed = () => {};
  readonly armed = new Promise<void>((resolvePromise) => {
    this.resolveArmed = resolvePromise;
  });

  schedule(_delayMs: number, callback: () => void): () => void {
    this.callback = callback;
    this.resolveArmed();
    return () => { this.cancelled += 1; };
  }

  fireLate(): void {
    assert.ok(this.callback);
    this.callback();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessGone(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`${label} ${pid} remained alive after tree termination`);
    }
    await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 20));
  }
}

async function forceTerminatePidTree(pid: number, label: string): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot?.trim();
    const taskkill = systemRoot === undefined || systemRoot.length === 0
      ? "taskkill.exe"
      : resolve(systemRoot, "System32", "taskkill.exe");
    const helper = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    await withTimeout(new Promise<void>((resolveClose) => helper.once("close", () => resolveClose())), 2_000, `${label} taskkill`);
    return;
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
  await waitForProcessGone(pid, label);
}

async function assertHeartbeatStopped(path: string, label: string): Promise<void> {
  const stable = await readFile(path, "utf8");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 20));
    assert.equal(await readFile(path, "utf8"), stable, `${label} heartbeat changed after tree termination`);
  }
}

test("uses stable platform shell vectors and preserves command quoting as one argument", () => {
  const command = `Write-Output "a b"; Write-Output '中文'; $x = \"'quoted'\"`;
  assert.deepEqual(shellInvocation(command, {
    platform: "win32",
    windowsPowerShellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  }), {
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
  });
  assert.deepEqual(shellInvocation(command, {
    platform: "linux",
    windowsPowerShellExecutable: "unused",
  }), {
    executable: "/bin/sh",
    args: ["-lc", command],
  });
});

test("production Windows taskkill tree capability is explicit when host privileges deny it", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows taskkill.exe capability probe only");
    return;
  }
  const timer = new ManualCommandTimer();
  const pending = executeCommandProcess({
    command: "while ($true) { Start-Sleep -Seconds 1 }",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    timer,
  });
  await withTimeout(timer.armed, 2_000, "Windows taskkill capability spawn");
  timer.fire();
  const result = await withTimeout(pending, 10_000, "Windows taskkill capability result");
  if (result.terminationFailed) {
    assert.equal(result.terminationFailureCode, "tree_termination_failed");
    assert.equal(result.timedOut, true);
    context.skip("Windows taskkill.exe /PID <pid> /T /F unavailable to the sandboxed test process: access denied");
    return;
  }
  assert.equal(result.terminationFailureCode, null);
  assert.equal(result.timedOut, true);
});

test("does not spawn when the caller signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before spawn"));
  let spawnCalls = 0;
  const adapter: CommandProcessAdapter = {
    platform: "win32",
    windowsPowerShellExecutable: "never-used.exe",
    spawn() {
      spawnCalls += 1;
      throw new Error("spawn must not be called");
    },
  };

  const result = await executeCommandProcess({
    command: "echo should-not-run",
    cwd: process.cwd(),
    timeoutMs: 5_000,
    signal: controller.signal,
    processAdapter: adapter,
  });

  assert.equal(spawnCalls, 0);
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.text, "");
  assert.equal(result.stderr.text, "");
});

test("returns a stable sanitized spawn failure without echoing launcher diagnostics", async () => {
  const adapter: CommandProcessAdapter = {
    platform: "win32",
    windowsPowerShellExecutable: "C:\\outside\\missing-powershell.exe",
    spawn() {
      throw new Error("C:\\outside\\missing-powershell.exe OPENAI_API_KEY=never-spawn-secret");
    },
  };
  const result = await executeCommandProcess({
    command: "echo not-started",
    cwd: process.cwd(),
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    processAdapter: adapter,
  });

  assert.equal(result.spawnFailed, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.text, "");
  assert.equal(result.stderr.text, "");
  assert.doesNotMatch(JSON.stringify(result), /outside|never-spawn-secret|OPENAI_API_KEY/i);
});

test("a timer setup failure terminates the spawned process and settles as a sanitized setup failure", async () => {
  let channel: ChildChannel | undefined;
  let signalListeners = 0;
  const controller = new AbortController();
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  Object.defineProperties(controller.signal, {
    addEventListener: { configurable: true, value(...args: Parameters<AbortSignal["addEventListener"]>) {
      signalListeners += 1;
      return originalAdd(...args);
    } },
    removeEventListener: { configurable: true, value(...args: Parameters<AbortSignal["removeEventListener"]>) {
      signalListeners -= 1;
      return originalRemove(...args);
    } },
  });
  const systemRoot = process.env.SystemRoot?.trim();
  const adapter: CommandProcessAdapter = {
    platform: process.platform,
    windowsPowerShellExecutable: systemRoot === undefined || systemRoot.length === 0
      ? "powershell.exe"
      : resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    spawn(executable, args, options) {
      const child = spawn(executable, [...args], options) as ReturnType<CommandProcessAdapter["spawn"]>;
      channel = createChildChannel(child, { processGroup: process.platform !== "win32" });
      return child;
    },
  };
  const timer: CommandTimer = {
    schedule() {
      throw new Error("C:\\outside\\timer OPENAI_API_KEY=never-timer-secret");
    },
  };
  const terminator: CommandTreeTerminator = {
    async terminate(child, _platform, closed) {
      child.kill("SIGKILL");
      await withTimeout(closed, 2_000, "timer setup failure close");
      return { failed: false, code: null };
    },
  };
  const command = hostCommand(
    "Start-Sleep -Seconds 120",
    `exec ${shellQuoted(process.execPath)} -e 'setInterval(() => {}, 1_000)'`,
  );
  try {
    const result = await withTimeout(executeCommandProcess({
      command,
      cwd: process.cwd(),
      timeoutMs: 5_000,
      signal: controller.signal,
      processAdapter: adapter,
      timer,
      treeTerminator: terminator,
    }), 5_000, "timer setup failure result");
    assert.equal(result.spawnFailed, true);
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, false);
    assert.equal(result.terminationFailed, false);
    assert.equal(signalListeners, 0);
    assert.doesNotMatch(JSON.stringify(result), /outside|never-timer-secret|OPENAI_API_KEY/i);
  } finally {
    if (channel !== undefined) {
      await disposeChildChannel(channel, "timer setup failure fallback", {
        gracefulTimeoutMs: 500,
        forceTimeoutMs: 2_000,
      }).catch(() => undefined);
    }
  }
});

test("reports an external signal and ignores a timeout callback that loses to natural close", async () => {
  for (const outcome of ["external-signal", "natural-close"] as const) {
    const controller = new AbortController();
    let signalListeners = 0;
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    Object.defineProperties(controller.signal, {
      addEventListener: { configurable: true, value(...args: Parameters<AbortSignal["addEventListener"]>) {
        signalListeners += 1;
        return originalAdd(...args);
      } },
      removeEventListener: { configurable: true, value(...args: Parameters<AbortSignal["removeEventListener"]>) {
        signalListeners -= 1;
        return originalRemove(...args);
      } },
    });
    const timer = new LateCommandTimer();
    let channel: ChildChannel | undefined;
    const systemRoot = process.env.SystemRoot?.trim();
    const adapter: CommandProcessAdapter = {
      platform: process.platform,
      windowsPowerShellExecutable: systemRoot === undefined || systemRoot.length === 0
        ? "powershell.exe"
        : resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      spawn(executable, args, options) {
        const child = spawn(executable, [...args], options) as ReturnType<CommandProcessAdapter["spawn"]>;
        channel = createChildChannel(child, { processGroup: process.platform !== "win32" });
        return child;
      },
    };
    const command = outcome === "external-signal"
      ? hostCommand(
        "Start-Sleep -Seconds 120",
        `exec ${shellQuoted(process.execPath)} -e 'setInterval(() => {}, 1_000)'`,
      )
      : hostCommand("[Console]::Out.Write('done')", "printf '%s' 'done'");
    try {
      const pending = executeCommandProcess({
        command,
        cwd: process.cwd(),
        timeoutMs: 5_000,
        signal: controller.signal,
        processAdapter: adapter,
        timer,
      });
      await withTimeout(timer.armed, 2_000, `${outcome} timer arm`);
      if (outcome === "external-signal") {
        assert.ok(channel);
        assert.equal(channel.child.kill("SIGTERM"), true);
      }
      const result = await withTimeout(pending, 5_000, `${outcome} process result`);
      if (outcome === "external-signal") {
        assert.equal(result.exitCode, null);
        assert.equal(result.signal, "SIGTERM");
      } else {
        assert.equal(result.exitCode, 0);
        assert.equal(result.signal, null);
        assert.equal(result.stdout.text, "done");
      }
      assert.equal(result.timedOut, false);
      assert.equal(result.cancelled, false);
      assert.equal(timer.cancelled, 1);
      assert.equal(signalListeners, 0);
      timer.fireLate();
      controller.abort(new Error("late abort"));
      assert.equal(result.timedOut, false);
      assert.equal(result.cancelled, false);
    } finally {
      if (channel !== undefined) {
        await disposeChildChannel(channel, `${outcome} cleanup`, {
          gracefulTimeoutMs: 500,
          forceTimeoutMs: 2_000,
        }).catch(() => undefined);
      }
    }
  }
});

test("timeout and cancellation each settle once, clean resources, and terminate a real grandchild tree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "awacode-command-tree-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(import.meta.dirname, "..", "..", "test-fixtures", "command-tree-child.ts");
  const grandchildFixture = join(import.meta.dirname, "..", "..", "test-fixtures", "command-tree-grandchild.ts");

  for (const cause of ["timeout", "cancel"] as const) {
    const sentinelPath = join(root, `${cause}-heartbeat.txt`);
    const controller = new AbortController();
    let signalListeners = 0;
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    Object.defineProperties(controller.signal, {
      addEventListener: { configurable: true, value(...args: Parameters<AbortSignal["addEventListener"]>) {
        signalListeners += 1;
        return originalAdd(...args);
      } },
      removeEventListener: { configurable: true, value(...args: Parameters<AbortSignal["removeEventListener"]>) {
        signalListeners -= 1;
        return originalRemove(...args);
      } },
    });
    const timer = new ManualCommandTimer();
    let channel: ChildChannel | undefined;
    const systemRoot = process.env.SystemRoot?.trim();
    const adapter: CommandProcessAdapter = {
      platform: process.platform,
      windowsPowerShellExecutable: systemRoot === undefined || systemRoot.length === 0
        ? "powershell.exe"
        : resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      spawn(executable, args, options) {
        const child = spawn(executable, [...args], options) as ReturnType<CommandProcessAdapter["spawn"]>;
        channel = createChildChannel(child, { processGroup: process.platform !== "win32" });
        return child;
      },
    };
    const command = process.platform === "win32"
      ? `$grandchild = Start-Process -FilePath ${shellQuoted(process.execPath)} -ArgumentList @(${shellQuoted(grandchildFixture)}, ${shellQuoted(sentinelPath)}) -PassThru -WindowStyle Hidden; $deadline = [DateTime]::UtcNow.AddSeconds(5); while (!(Test-Path -LiteralPath ${shellQuoted(sentinelPath)})) { if ([DateTime]::UtcNow -ge $deadline) { throw 'grandchild readiness timeout' }; Start-Sleep -Milliseconds 10 }; [Console]::Out.WriteLine(\"TREE_READY $PID $($grandchild.Id)\"); Wait-Process -Id $grandchild.Id`
      : `${shellQuoted(process.execPath)} ${shellQuoted(fixture)} ${shellQuoted(sentinelPath)}`;
    let childPid: number | undefined;
    let grandchildPid: number | undefined;
    const windowsTestTerminator: CommandTreeTerminator = {
      async terminate(child, _platform, closed) {
        if (grandchildPid === undefined) {
          return { failed: true, code: "tree_termination_failed" };
        }
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            return { failed: true, code: "tree_termination_failed" };
          }
        }
        child.kill("SIGKILL");
        await withTimeout(closed, 2_000, `${cause} injected Windows tree close`);
        return { failed: false, code: null };
      },
    };
    try {
      const pending = executeCommandProcess({
        command,
        cwd: process.cwd(),
        timeoutMs: 99_999,
        signal: controller.signal,
        processAdapter: adapter,
        timer,
        ...(process.platform === "win32" ? { treeTerminator: windowsTestTerminator } : {}),
      });
      assert.ok(channel);
      const ready = await channel.lines.nextLine(5_000);
      const match = /^TREE_READY (\d+) (\d+)$/.exec(ready);
      assert.ok(match, ready);
      childPid = Number(match[1]);
      grandchildPid = Number(match[2]);
      assert.equal(childPid, channel.child.pid, "readiness PID must be the spawned shell tree root");
      assert.equal((await stat(sentinelPath)).isFile(), true);
      assert.equal(timer.delayMs, 99_999);
      assert.equal(timer.active, 1);
      assert.equal(signalListeners, 1);

      if (cause === "timeout") {
        timer.fire();
      } else {
        controller.abort(new Error("cancel command tree"));
        controller.abort(new Error("repeated abort must be ignored"));
      }
      const result = await withTimeout(pending, 5_000, `${cause} command result`);

      assert.equal(result.timedOut, cause === "timeout");
      assert.equal(result.cancelled, cause === "cancel");
      assert.equal(result.exitCode, null);
      assert.equal(result.signal, null);
      assert.equal(
        result.terminationFailureCode,
        result.terminationFailed ? "tree_termination_failed" : null,
      );
      assert.equal(timer.active, 0);
      assert.equal(timer.cancelled, cause === "cancel" ? 1 : 0);
      assert.equal(signalListeners, 0);
      if (process.platform !== "win32") {
        await waitForProcessGone(childPid, `${cause} child`);
        await waitForProcessGone(grandchildPid, `${cause} grandchild`);
      }
      await assertHeartbeatStopped(sentinelPath, `${cause} grandchild`);
    } finally {
      if (channel !== undefined) {
        await disposeChildChannel(channel, `${cause} command tree fallback`, {
          gracefulTimeoutMs: 500,
          forceTimeoutMs: 2_000,
        }).catch(() => undefined);
      }
      const cleanupFailures: unknown[] = [];
      for (const [pid, label] of [[grandchildPid, `${cause} grandchild fallback`], [childPid, `${cause} child fallback`]] as const) {
        if (pid !== undefined) {
          await forceTerminatePidTree(pid, label).catch((error) => cleanupFailures.push(error));
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(cleanupFailures, `${cause} command tree fallback cleanup failed`);
      }
    }
  }
});

test("drains simultaneous noisy streams and reports independent 64 KiB accounting", async () => {
  const fixture = join(import.meta.dirname, "..", "..", "test-fixtures", "noisy-command-child.ts");
  const command = process.platform === "win32"
    ? `& ${shellQuoted(process.execPath)} ${shellQuoted(fixture)}`
    : `${shellQuoted(process.execPath)} ${shellQuoted(fixture)}`;
  const result = await executeCommandProcess({
    command,
    cwd: process.cwd(),
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });

  assert.equal(result.exitCode, 0);
  for (const [stream, byte] of [[result.stdout, "O"], [result.stderr, "E"]] as const) {
    assert.equal(stream.originalBytes, 128 * 1024);
    assert.equal(stream.truncated, true);
    assert.equal(stream.retainedBytes + stream.omittedBytes, stream.originalBytes);
    assert.ok(stream.displayedBytes <= COMMAND_STREAM_BYTES);
    assert.match(stream.text, new RegExp(`^${byte}+[\\s\\S]*\\[truncated: \\d+ bytes omitted\\]$`));
  }
});

test("executes a real command with separate streams, filtered environment, and diagnostic nonzero exit", async () => {
  const environment = {
    ...process.env,
    SAFE_VALUE: "visible",
    AWACODE_API_KEY: "never-awacode-secret",
    OPENAI_API_KEY: "never-openai-secret",
    accessToken: "never-access-secret",
    clientSecret: "never-client-secret",
  };
  const success = await executeCommandProcess({
    command: hostCommand(
      "[Console]::Out.Write($env:SAFE_VALUE + '|' + $env:AWACODE_API_KEY + '|' + $env:accessToken); [Console]::Error.Write('stderr-value')",
      "printf '%s' \"$SAFE_VALUE|$AWACODE_API_KEY|$accessToken\"; printf '%s' 'stderr-value' >&2",
    ),
    cwd: process.cwd(),
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    environment,
  });
  assert.equal(success.exitCode, 0);
  assert.equal(success.signal, null);
  assert.equal(success.stdout.text, "visible||");
  assert.equal(success.stderr.text, "stderr-value");
  assert.equal(success.timedOut, false);
  assert.equal(success.cancelled, false);
  assert.equal(success.spawnFailed, false);
  assert.doesNotMatch(JSON.stringify(success), /never-(?:awacode|openai|access|client)-secret/);

  const nonzero = await executeCommandProcess({
    command: hostCommand(
      "[Console]::Out.Write('before-exit'); [Console]::Error.Write('failure-detail'); exit 7",
      "printf '%s' 'before-exit'; printf '%s' 'failure-detail' >&2; exit 7",
    ),
    cwd: process.cwd(),
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  assert.equal(nonzero.exitCode, 7);
  assert.equal(nonzero.stdout.text, "before-exit");
  assert.equal(nonzero.stderr.text, "failure-detail");
  assert.equal(nonzero.spawnFailed, false);
});

test("captures split UTF-8 and bounds exact and over-limit streams with byte accounting", () => {
  const chineseBytes = Buffer.from("甲中文乙", "utf8");
  const split = new BoundedStreamCapture();
  split.write(chineseBytes.subarray(0, 4));
  split.write(chineseBytes.subarray(4, 7));
  split.write(chineseBytes.subarray(7));
  assert.deepEqual(split.finish(), {
    text: "甲中文乙",
    truncated: false,
    originalBytes: chineseBytes.length,
    retainedBytes: chineseBytes.length,
    omittedBytes: 0,
    displayedBytes: chineseBytes.length,
  });

  const exact = new BoundedStreamCapture();
  exact.write(Buffer.alloc(COMMAND_STREAM_BYTES, 0x61));
  const exactResult = exact.finish();
  assert.equal(exactResult.text, "a".repeat(COMMAND_STREAM_BYTES));
  assert.equal(exactResult.truncated, false);
  assert.equal(exactResult.displayedBytes, COMMAND_STREAM_BYTES);

  const over = new BoundedStreamCapture();
  over.write(Buffer.alloc(COMMAND_STREAM_BYTES - 1, 0x62));
  over.write(Buffer.from("中文-tail", "utf8"));
  const overResult = over.finish();
  assert.equal(overResult.truncated, true);
  assert.equal(overResult.originalBytes, COMMAND_STREAM_BYTES - 1 + Buffer.byteLength("中文-tail"));
  assert.equal(overResult.retainedBytes + overResult.omittedBytes, overResult.originalBytes);
  assert.ok(overResult.displayedBytes <= COMMAND_STREAM_BYTES);
  assert.equal(Buffer.byteLength(overResult.text), overResult.displayedBytes);
  assert.match(overResult.text, /\n\[truncated: \d+ bytes omitted\]$/);
  assert.doesNotMatch(overResult.text, /�/);
});
