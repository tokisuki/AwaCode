import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createChildChannel,
  disposeChildChannel,
  disposeChildChannels,
  waitForChildExit,
  withTimeout,
} from "../support/child-process.ts";

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

test("fast children drain their final stdout line after exit is observed", async () => {
  const fixtures = Array.from({ length: 16 }, (_value, index) => {
    const child = spawn(process.execPath, [
      "-e",
      `require("node:fs").writeSync(1, "FINAL ${index}\\n")`,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const delayed: Array<{ event: string | symbol; args: unknown[] }> = [];
    const originalEmit = child.stdout.emit.bind(child.stdout);
    let delaying = true;
    child.stdout.emit = ((event: string | symbol, ...args: unknown[]) => {
      if (delaying && ["data", "end", "close"].includes(String(event))) {
        delayed.push({ event, args });
        return true;
      }
      return originalEmit(event, ...args);
    }) as typeof child.stdout.emit;
    const channel = createChildChannel(child);
    return {
      channel,
      releaseDrain() {
        delaying = false;
        child.stdout.emit = originalEmit as typeof child.stdout.emit;
        for (const { event, args } of delayed) {
          originalEmit(event, ...args);
        }
      },
    };
  });
  const channels = fixtures.map(({ channel }) => channel);
  try {
    await Promise.all(channels.map((channel) => withTimeout(channel.exited, 2000, "fast child exit")));
    const linesPromise = Promise.all(channels.map((channel) => channel.lines.nextLine(2000)));
    for (const fixture of fixtures) {
      fixture.releaseDrain();
    }
    const lines = await linesPromise;
    assert.deepEqual(lines, Array.from({ length: 16 }, (_value, index) => `FINAL ${index}`));
  } finally {
    await disposeChildChannels(channels, "fast-child cleanup");
  }
});

test("waiting for a child exit is bounded after its final line while a handle remains live", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.stdout.write('FINAL\\n'); setInterval(() => {}, 1000)",
  ], {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const channel = createChildChannel(child, { processGroup: process.platform !== "win32" });
  try {
    assert.equal(await channel.lines.nextLine(), "FINAL");
    await assert.rejects(
      waitForChildExit(channel, 50, "live-handle child"),
      /live-handle child timed out after 50 ms/,
    );
  } finally {
    await disposeChildChannel(channel, "live-handle child cleanup");
  }
});

test("an exhausted graceful budget escalates and confirms real process termination", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.stdout.write('READY\\n'); setInterval(() => {}, 1000)",
  ], {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pid = child.pid;
  assert.notEqual(pid, undefined);
  const rawClose = once(child, "close");
  const stdoutListenerBaseline = {
    end: child.stdout.listenerCount("end"),
    close: child.stdout.listenerCount("close"),
    error: child.stdout.listenerCount("error"),
  };
  const channel = createChildChannel(child, { processGroup: process.platform !== "win32" });
  try {
    assert.equal(await channel.lines.nextLine(), "READY");
    await disposeChildChannel(channel, "zero-budget child", {
      gracefulTimeoutMs: 0,
      forceTimeoutMs: 2000,
    });
    assert.equal(isProcessAlive(pid as number), false);
    assert.equal(child.stdin.destroyed, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(child.listenerCount("exit"), 0);
    assert.equal(child.listenerCount("close"), 0);
    assert.equal(child.listenerCount("error"), 0);
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.ok(child.stdout.listenerCount("end") <= stdoutListenerBaseline.end);
    assert.ok(child.stdout.listenerCount("close") <= stdoutListenerBaseline.close);
    assert.ok(child.stdout.listenerCount("error") <= stdoutListenerBaseline.error);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("error"), 0);
  } finally {
    if (isProcessAlive(pid as number)) {
      if (process.platform === "win32") {
        child.kill("SIGKILL");
      } else {
        process.kill(-(pid as number), "SIGKILL");
      }
    }
    await withTimeout(rawClose.then(() => undefined), 2000, "zero-budget fallback close");
    channel.lines.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

test("a SIGTERM-resistant process group is force-killed and fully disposed", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows does not allow a Node child to ignore TerminateProcess");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "awacode-resistant-child-"));
  const markerPath = join(root, "sigterm-marker.txt");
  const fixture = join(import.meta.dirname, "..", "..", "test-fixtures", "resistant-child.ts");
  const child = spawn(process.execPath, [fixture, markerPath], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pid = child.pid;
  assert.notEqual(pid, undefined);
  const rawClose = once(child, "close");
  const channel = createChildChannel(child, { processGroup: true });
  try {
    assert.equal(await channel.lines.nextLine(), "READY");
    await disposeChildChannel(channel, "SIGTERM-resistant child", {
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 2000,
    });
    assert.equal(await readFile(markerPath, "utf8"), "SIGTERM observed");
    assert.equal(isProcessAlive(pid as number), false);
    assert.equal(child.stdin.destroyed, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  } finally {
    if (isProcessAlive(pid as number)) {
      process.kill(-(pid as number), "SIGKILL");
    }
    await withTimeout(rawClose.then(() => undefined), 2000, "resistant-child fallback close");
    channel.lines.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
