import assert from "node:assert/strict";
import test from "node:test";

import { JsonRpcPeer } from "../../src/protocol/rpc-peer.ts";
import { RpcDisconnectedError, RpcFault } from "../../src/protocol/json-rpc.ts";

test("assigns prefixed request IDs and correlates out-of-order responses", async () => {
  const sent: unknown[] = [];
  const peer = new JsonRpcPeer({
    idPrefix: "core-",
    send(message) {
      sent.push(message);
    },
  });

  const first = peer.request("first", { ordinal: 1 });
  const second = peer.request("second");

  assert.deepEqual(sent, [
    { jsonrpc: "2.0", id: "core-1", method: "first", params: { ordinal: 1 } },
    { jsonrpc: "2.0", id: "core-2", method: "second" },
  ]);

  await peer.receive({ jsonrpc: "2.0", id: "core-2", result: "second-result" });
  await peer.receive({ jsonrpc: "2.0", id: "core-1", result: "first-result" });

  assert.equal(await first, "first-result");
  assert.equal(await second, "second-result");
});

test("rejects a remote error with its code and data and ignores a later duplicate", async () => {
  const sent: unknown[] = [];
  const peer = new JsonRpcPeer({
    idPrefix: "ui-",
    send(message) {
      sent.push(message);
    },
  });
  const result = peer.request("workspace/set", { workspace: "missing" });

  await peer.receive({
    jsonrpc: "2.0",
    id: "ui-1",
    error: { code: -32003, message: "Workspace not found", data: { workspace: "missing" } },
  });

  await assert.rejects(
    result,
    (error: unknown) =>
      error instanceof RpcFault
      && error.code === -32003
      && error.message === "Workspace not found"
      && assert.deepEqual(error.data, { workspace: "missing" }) === undefined,
  );
  await peer.receive({ jsonrpc: "2.0", id: "ui-1", result: "too late" });
  assert.equal(sent.length, 1);
});

test("serves a reverse request while a local request is pending", async () => {
  const sent: unknown[] = [];
  const peer = new JsonRpcPeer({
    idPrefix: "core-",
    send(message) {
      sent.push(message);
    },
  });
  peer.register(
    "permission/request",
    (value) => value as { title: string },
    ({ title }) => ({ decision: "allow_once", title }),
  );

  const local = peer.request("agent/run", { prompt: "edit it" });
  await peer.receive({
    jsonrpc: "2.0",
    id: "ui-9",
    method: "permission/request",
    params: { title: "Write file" },
  });

  assert.deepEqual(sent[1], {
    jsonrpc: "2.0",
    id: "ui-9",
    result: { decision: "allow_once", title: "Write file" },
  });
  await peer.receive({ jsonrpc: "2.0", id: "core-1", result: { status: "done" } });
  assert.deepEqual(await local, { status: "done" });
});

test("rejects blank and duplicate method registrations synchronously", () => {
  const peer = new JsonRpcPeer({ idPrefix: "core-", send() {} });
  peer.register("echo", (value) => value, (value) => value);

  assert.throws(() => peer.register("  ", (value) => value, (value) => value), TypeError);
  assert.throws(() => peer.register("echo", (value) => value, (value) => value), TypeError);
});

test("returns method-not-found for an unknown request", async () => {
  const sent: unknown[] = [];
  const peer = new JsonRpcPeer({ idPrefix: "core-", send(message) { sent.push(message); } });

  await peer.receive({ jsonrpc: "2.0", id: "ui-1", method: "unknown" });

  assert.deepEqual(sent, [{
    jsonrpc: "2.0",
    id: "ui-1",
    error: { code: -32601, message: "Method not found" },
  }]);
});

test("maps ordinary parameter parser failures to invalid-params", async () => {
  const sent: unknown[] = [];
  const peer = new JsonRpcPeer({ idPrefix: "core-", send(message) { sent.push(message); } });
  peer.register("workspace/set", () => { throw new TypeError("workspace must be a string"); }, () => null);

  await peer.receive({ jsonrpc: "2.0", id: "ui-2", method: "workspace/set", params: 17 });

  assert.deepEqual(sent, [{
    jsonrpc: "2.0",
    id: "ui-2",
    error: { code: -32602, message: "Invalid params" },
  }]);
});

test("preserves an explicitly thrown RPC fault", async () => {
  const sent: unknown[] = [];
  const peer = new JsonRpcPeer({ idPrefix: "core-", send(message) { sent.push(message); } });
  peer.register("agent/run", (value) => value, () => {
    throw new RpcFault(-32001, "Agent is busy", { activeRunId: "run-7" });
  });

  await peer.receive({ jsonrpc: "2.0", id: "ui-3", method: "agent/run", params: {} });

  assert.deepEqual(sent, [{
    jsonrpc: "2.0",
    id: "ui-3",
    error: { code: -32001, message: "Agent is busy", data: { activeRunId: "run-7" } },
  }]);
});

test("sanitizes unexpected handler failures", async () => {
  const sent: unknown[] = [];
  const peer = new JsonRpcPeer({ idPrefix: "core-", send(message) { sent.push(message); } });
  peer.register("session/load", (value) => value, () => {
    throw new Error("failed at D:\\secret\\session-store.ts:42");
  });

  await peer.receive({ jsonrpc: "2.0", id: "ui-4", method: "session/load", params: {} });

  assert.deepEqual(sent, [{
    jsonrpc: "2.0",
    id: "ui-4",
    error: { code: -32603, message: "Internal error" },
  }]);
  assert.doesNotMatch(JSON.stringify(sent), /secret|session-store|stack/i);
});

test("runs known notifications but never responds to any notification failure", async () => {
  const sent: unknown[] = [];
  const handled: unknown[] = [];
  const peer = new JsonRpcPeer({ idPrefix: "core-", send(message) { sent.push(message); } });
  peer.register("event/known", (value) => value, (value) => { handled.push(value); });
  peer.register("event/bad-params", () => { throw new Error("bad params"); }, () => null);
  peer.register("event/bad-handler", (value) => value, () => { throw new Error("bad handler"); });

  await peer.receive({ jsonrpc: "2.0", method: "event/known", params: { seq: 1 } });
  await peer.receive({ jsonrpc: "2.0", method: "event/unknown" });
  await peer.receive({ jsonrpc: "2.0", method: "event/bad-params", params: 9 });
  await peer.receive({ jsonrpc: "2.0", method: "event/bad-handler", params: {} });

  assert.deepEqual(handled, [{ seq: 1 }]);
  assert.deepEqual(sent, []);
});

test("aborts a pending request and ignores its late response", async () => {
  const sent: unknown[] = [];
  const controller = new AbortController();
  const reason = new Error("user cancelled");
  const peer = new JsonRpcPeer({ idPrefix: "core-", send(message) { sent.push(message); } });
  const result = peer.request("agent/run", {}, { signal: controller.signal });

  controller.abort(reason);
  await assert.rejects(result, (error: unknown) => error === reason);
  await peer.receive({ jsonrpc: "2.0", id: "core-1", result: "late" });

  assert.equal(sent.length, 1);
});

test("rejects and forgets requests when synchronous or asynchronous sends fail", async () => {
  const syncFailure = new Error("sync send failed");
  const asyncFailure = new Error("async send failed");
  const syncPeer = new JsonRpcPeer({ idPrefix: "core-", send() { throw syncFailure; } });
  const asyncPeer = new JsonRpcPeer({ idPrefix: "ui-", send: async () => { throw asyncFailure; } });

  await assert.rejects(syncPeer.request("one"), (error: unknown) => error === syncFailure);
  await assert.rejects(asyncPeer.request("two"), (error: unknown) => error === asyncFailure);
  await syncPeer.receive({ jsonrpc: "2.0", id: "core-1", result: "late" });
  await asyncPeer.receive({ jsonrpc: "2.0", id: "ui-1", result: "late" });
});

test("notifies without pending state and reports notification send failure", async () => {
  const sent: unknown[] = [];
  const peer = new JsonRpcPeer({ idPrefix: "core-", send(message) { sent.push(message); } });
  await peer.notify("stream/text", { delta: "hi" });
  assert.deepEqual(sent, [{ jsonrpc: "2.0", method: "stream/text", params: { delta: "hi" } }]);

  const failure = new Error("pipe closed");
  const failed = new JsonRpcPeer({ idPrefix: "core-", send: async () => { throw failure; } });
  await assert.rejects(failed.notify("stream/text"), (error: unknown) => error === failure);
});

test("closes idempotently and rejects pending and future operations as disconnected", async () => {
  const peer = new JsonRpcPeer({ idPrefix: "core-", send() {} });
  const pending = peer.request("agent/run");
  const reason = new Error("stdin ended");

  peer.close(reason);
  peer.close(new Error("must not replace first reason"));

  let disconnected: unknown;
  await assert.rejects(pending, (error: unknown) => {
    disconnected = error;
    return error instanceof RpcDisconnectedError && error.reason === reason;
  });
  await assert.rejects(peer.request("later"), (error: unknown) => error === disconnected);
  await assert.rejects(peer.notify("later"), (error: unknown) => error === disconnected);
  await assert.rejects(peer.receive({ jsonrpc: "2.0", method: "later" }), (error: unknown) => error === disconnected);
});

test("returns invalid-request for malformed request values with recoverable IDs", async () => {
  const sent: unknown[] = [];
  const peer = new JsonRpcPeer({ idPrefix: "core-", send(message) { sent.push(message); } });

  await peer.receive(null);
  await peer.receive([]);
  await peer.receive({ jsonrpc: "1.0", id: "bad-version", method: "echo" });
  await peer.receive({ jsonrpc: "2.0", id: 7, method: "echo" });
  await peer.receive({ jsonrpc: "2.0", id: "bad-method", method: 7 });
  await peer.receive({ jsonrpc: "2.0", id: "mixed", method: "echo", result: "not a request" });
  await peer.receive({ jsonrpc: "2.0", method: "event", error: { code: -32603, message: "mixed" } });

  assert.deepEqual(sent, [
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
    { jsonrpc: "2.0", id: "bad-version", error: { code: -32600, message: "Invalid Request" } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
    { jsonrpc: "2.0", id: "bad-method", error: { code: -32600, message: "Invalid Request" } },
    { jsonrpc: "2.0", id: "mixed", error: { code: -32600, message: "Invalid Request" } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
  ]);
});

test("rejects correlated malformed responses containing both or neither result and error", async () => {
  const sent: unknown[] = [];
  const peer = new JsonRpcPeer({ idPrefix: "core-", send(message) { sent.push(message); } });
  const both = peer.request("both");
  const neither = peer.request("neither");

  await peer.receive({
    jsonrpc: "2.0",
    id: "core-1",
    result: "value",
    error: { code: -32603, message: "also error" },
  });
  await peer.receive({ jsonrpc: "2.0", id: "core-2" });

  await assert.rejects(both, (error: unknown) => error instanceof RpcFault && error.code === -32600);
  await assert.rejects(neither, (error: unknown) => error instanceof RpcFault && error.code === -32600);
  assert.equal(sent.length, 2);
});
