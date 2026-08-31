import assert from "node:assert/strict";
import test from "node:test";

import { JsonRpcPeer } from "../../src/protocol/rpc-peer.ts";
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  JsonRpcPermissionClient,
  PERMISSION_TEXT_PREVIEW_BYTES,
  PermissionProtocolError,
  PermissionTimeoutError,
  type PermissionTimer,
  type PermissionRequest,
} from "../../src/tools/permission.ts";

function pairedPeers() {
  let core!: JsonRpcPeer;
  let ui!: JsonRpcPeer;
  core = new JsonRpcPeer({
    idPrefix: "core-",
    send: (message) => ui.receive(message),
  });
  ui = new JsonRpcPeer({
    idPrefix: "ui-",
    send: (message) => core.receive(message),
  });
  return { core, ui };
}

const request: PermissionRequest = {
  callId: "call-edit-1",
  kind: "write",
  title: "Edit src/main.ts",
  preview: {
    path: "src/main.ts",
    replacementCount: 1,
    before: "const oldValue = 1;",
    after: "const newValue = 1;",
    sha256: "a".repeat(64),
  },
};

class ManualTimer implements PermissionTimer {
  private callback: (() => void) | undefined;
  active = 0;
  cancelled = 0;
  delayMs: number | undefined;

  schedule(delayMs: number, callback: () => void): () => void {
    this.delayMs = delayMs;
    this.callback = callback;
    this.active += 1;
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
    assert.ok(callback, "expected an active permission timer");
    this.callback = undefined;
    this.active -= 1;
    callback();
  }
}

async function settleByImmediate<T>(promise: Promise<T>): Promise<T | "still_pending"> {
  return Promise.race([
    promise,
    new Promise<"still_pending">((resolve) => setImmediate(() => resolve("still_pending"))),
  ]);
}

test("uses JsonRpcPeer correlation for the exact permission/request round trip", async () => {
  const { core, ui } = pairedPeers();
  let observed: unknown;
  ui.register("permission/request", (value) => value, (params) => {
    observed = params;
    return "allow_once";
  });
  const scheduled: number[] = [];
  const client = new JsonRpcPermissionClient(core, {
    schedule(delayMs, _callback) {
      scheduled.push(delayMs);
      return () => scheduled.push(-delayMs);
    },
  });

  assert.equal(await client.requestPermission(request), "allow_once");
  assert.deepEqual(observed, request);
  assert.deepEqual(scheduled, [DEFAULT_PERMISSION_TIMEOUT_MS, -DEFAULT_PERMISSION_TIMEOUT_MS]);
  assert.equal(DEFAULT_PERMISSION_TIMEOUT_MS, 10 * 60 * 1_000);
});

test("rejects malformed permission responses instead of treating them as decisions", async () => {
  for (const malformed of [null, true, "allow", "ALLOW_ONCE", { decision: "deny" }]) {
    const { core, ui } = pairedPeers();
    ui.register("permission/request", (value) => value, () => malformed);
    const client = new JsonRpcPermissionClient(core, {
      schedule(_delayMs, _callback) {
        return () => {};
      },
    });

    await assert.rejects(client.requestPermission(request), PermissionProtocolError);
  }
});

test("times out deterministically, removes resources, and ignores a late allow response", async () => {
  const { core, ui } = pairedPeers();
  let handlerEntered!: () => void;
  const entered = new Promise<void>((resolve) => { handlerEntered = resolve; });
  let releaseHandler!: () => void;
  const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
  let handlerFinished!: () => void;
  const finished = new Promise<void>((resolve) => { handlerFinished = resolve; });
  ui.register("permission/request", (value) => value, async () => {
    handlerEntered();
    await handlerGate;
    handlerFinished();
    return "allow_once";
  });
  const timer = new ManualTimer();
  const client = new JsonRpcPermissionClient(core, timer);

  const pending = client.requestPermission(request);
  await entered;
  assert.equal(timer.delayMs, DEFAULT_PERMISSION_TIMEOUT_MS);
  timer.fire();
  const outcome = await settleByImmediate(pending.then(
    () => "resolved" as const,
    (error: unknown) => error,
  ));
  assert.ok(outcome instanceof PermissionTimeoutError);
  assert.equal(timer.active, 0);
  releaseHandler();
  await finished;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timer.active, 0);
});

test("an abort rejects the pending request and removes its timer and signal listener", async () => {
  const { core, ui } = pairedPeers();
  let handlerEntered!: () => void;
  const entered = new Promise<void>((resolve) => { handlerEntered = resolve; });
  let releaseHandler!: () => void;
  const gate = new Promise<void>((resolve) => { releaseHandler = resolve; });
  ui.register("permission/request", (value) => value, async () => {
    handlerEntered();
    await gate;
    return "deny";
  });
  const timer = new ManualTimer();
  const client = new JsonRpcPermissionClient(core, timer);
  const controller = new AbortController();
  let listeners = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  Object.defineProperties(controller.signal, {
    addEventListener: { configurable: true, value(...args: Parameters<AbortSignal["addEventListener"]>) {
      listeners += 1;
      return originalAdd(...args);
    } },
    removeEventListener: { configurable: true, value(...args: Parameters<AbortSignal["removeEventListener"]>) {
      listeners -= 1;
      return originalRemove(...args);
    } },
  });
  const reason = new Error("cancelled by test");

  const pending = client.requestPermission(request, { signal: controller.signal });
  await entered;
  assert.equal(listeners, 1);
  controller.abort(reason);
  const outcome = await settleByImmediate(pending.then(
    () => "resolved" as const,
    (error: unknown) => error,
  ));
  assert.equal(outcome, reason);
  assert.equal(timer.active, 0);
  assert.equal(listeners, 0);
  releaseHandler();
});

test("peer disconnection rejects approval and cleans up the timer", async () => {
  const { core, ui } = pairedPeers();
  let entered!: () => void;
  const handlerEntered = new Promise<void>((resolve) => { entered = resolve; });
  ui.register("permission/request", (value) => value, async () => {
    entered();
    return new Promise(() => {});
  });
  const timer = new ManualTimer();
  const client = new JsonRpcPermissionClient(core, timer);
  const pending = client.requestPermission(request);
  await handlerEntered;

  core.close(new Error("UI disconnected"));
  await assert.rejects(pending, /disconnected/i);
  assert.equal(timer.active, 0);
});

test("rejects unsafe or non-exact approval DTOs before sending protocol content", async () => {
  const sent: unknown[] = [];
  const peer = new JsonRpcPeer({ idPrefix: "core-", send(message) { sent.push(message); } });
  const client = new JsonRpcPermissionClient(peer, {
    schedule(_delayMs, _callback) { return () => {}; },
  });
  const inherited = Object.create(request) as PermissionRequest;
  const invalid: unknown[] = [
    inherited,
    { ...request, callId: " " },
    { ...request, kind: "none" },
    { ...request, title: "line one\nline two" },
    { ...request, extra: true },
    { ...request, preview: { ...request.preview, path: "C:/private/file.txt" } },
    { ...request, preview: { ...request.preview, replacementCount: 0 } },
    { ...request, preview: { ...request.preview, before: "x".repeat(PERMISSION_TEXT_PREVIEW_BYTES + 1) } },
    { ...request, preview: { ...request.preview, sha256: "NOT-A-DIGEST" } },
    { ...request, preview: { ...request.preview, outsidePath: "secret" } },
  ];

  for (const value of invalid) {
    await assert.rejects(
      client.requestPermission(value as PermissionRequest),
      PermissionProtocolError,
    );
  }
  assert.deepEqual(sent, []);
});

test("removes an external abort listener when timer setup fails before the request is sent", async () => {
  const sent: unknown[] = [];
  const peer = new JsonRpcPeer({ idPrefix: "core-", send(message) { sent.push(message); } });
  const controller = new AbortController();
  let listeners = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  Object.defineProperties(controller.signal, {
    addEventListener: { configurable: true, value(...args: Parameters<AbortSignal["addEventListener"]>) {
      listeners += 1;
      return originalAdd(...args);
    } },
    removeEventListener: { configurable: true, value(...args: Parameters<AbortSignal["removeEventListener"]>) {
      listeners -= 1;
      return originalRemove(...args);
    } },
  });
  const failure = new Error("timer unavailable");
  const client = new JsonRpcPermissionClient(peer, {
    schedule() { throw failure; },
  });

  await assert.rejects(client.requestPermission(request, { signal: controller.signal }), (error) => error === failure);
  assert.equal(listeners, 0);
  assert.deepEqual(sent, []);
});
