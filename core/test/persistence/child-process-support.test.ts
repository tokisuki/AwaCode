import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  createChildChannel,
  disposeChildChannel,
  withTimeout,
} from "../support/child-process.ts";

test("child cleanup disposes every pipe and listener even when kill-await times out", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const channel = createChildChannel(child);
  const actualExit = channel.exited;
  const forcedTimeoutChannel = {
    ...channel,
    exited: new Promise<[number | null, NodeJS.Signals | null]>(() => {}),
  };

  try {
    await assert.rejects(
      disposeChildChannel(forcedTimeoutChannel, "forced cleanup", 20),
      /forced cleanup timed out after 20 ms/,
    );
    assert.equal(child.killed, true);
    await withTimeout(actualExit, 1000, "actual child termination");
    assert.equal(child.stdin.destroyed, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(child.listenerCount("exit"), 0);
  } finally {
    await disposeChildChannel(channel, "forced-cleanup test fallback");
  }
});
