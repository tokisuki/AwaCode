import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { NdjsonDecoder } from "../../src/protocol/ndjson.ts";
import { RpcDisconnectedError } from "../../src/protocol/json-rpc.ts";
import { StdioRpc } from "../../src/protocol/stdio-rpc.ts";

class ControlledWriter extends Writable {
  readonly chunks: Buffer[] = [];
  private readonly releases: Array<() => void> = [];
  private releaseFutureWrites = false;

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    this.emit("record");
    if (this.releaseFutureWrites) {
      setImmediate(callback);
    } else {
      this.releases.push(callback);
    }
  }

  release(): void {
    const callback = this.releases.shift();
    assert.ok(callback, "expected one blocked stdout write");
    callback();
  }

  releaseAndContinue(): void {
    this.releaseFutureWrites = true;
    this.release();
  }
}

test("serializes NDJSON writes and waits for drain without writing diagnostics to stdout", async () => {
  const stdin = new PassThrough();
  const stdout = new ControlledWriter();
  const stderr = new PassThrough();
  const diagnostics: Buffer[] = [];
  stderr.on("data", (chunk: Buffer) => diagnostics.push(Buffer.from(chunk)));
  const rpc = new StdioRpc({ stdin, stdout, stderr, idPrefix: "core-" });

  const firstRecord = once(stdout, "record");
  const first = rpc.peer.notify("stream/text", { delta: "one" });
  const second = rpc.peer.notify("stream/text", { delta: "two" });
  await firstRecord;
  assert.equal(stdout.chunks.length, 1);

  const secondRecord = once(stdout, "record");
  stdout.release();
  await first;
  await secondRecord;
  assert.equal(stdout.chunks.length, 2);
  stdout.release();
  await second;

  stdin.end();
  await rpc.done;
  const decoder = new NdjsonDecoder();
  assert.deepEqual(decoder.push(Buffer.concat(stdout.chunks)), [
    { jsonrpc: "2.0", method: "stream/text", params: { delta: "one" } },
    { jsonrpc: "2.0", method: "stream/text", params: { delta: "two" } },
  ]);
  assert.deepEqual(diagnostics, []);
});

test("decodes stdin through one peer and emits ordered protocol-only responses", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output: Buffer[] = [];
  const diagnostics: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
  stderr.on("data", (chunk: Buffer) => diagnostics.push(Buffer.from(chunk)));
  const rpc = new StdioRpc({ stdin, stdout, stderr, idPrefix: "core-" });
  rpc.peer.register("echo", (value) => value, (value) => value);

  stdin.end(Buffer.from('17\n{"jsonrpc":"2.0","id":"ui-1","method":"echo","params":{"text":"中"}}\n'));
  await rpc.done;

  const decoder = new NdjsonDecoder();
  assert.deepEqual(decoder.push(Buffer.concat(output)), [
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
    { jsonrpc: "2.0", id: "ui-1", result: { text: "中" } },
  ]);
  assert.deepEqual(diagnostics, []);
});

test("encodes an undefined handler return as a null JSON-RPC result", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
  const rpc = new StdioRpc({ stdin, stdout, stderr, idPrefix: "core-" });
  rpc.peer.register("returns-undefined", (value) => value, () => undefined);

  stdin.end(Buffer.from('{"jsonrpc":"2.0","id":"ui-undefined","method":"returns-undefined"}\n'));
  await rpc.done;

  const decoder = new NdjsonDecoder();
  assert.deepEqual(decoder.push(Buffer.concat(output)), [{
    jsonrpc: "2.0",
    id: "ui-undefined",
    result: null,
  }]);
});

test("reports malformed JSON once on stdout, diagnoses it on stderr, and closes", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output: Buffer[] = [];
  const diagnostics: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
  stderr.on("data", (chunk: Buffer) => diagnostics.push(Buffer.from(chunk)));
  const rpc = new StdioRpc({ stdin, stdout, stderr, idPrefix: "core-" });

  stdin.end(Buffer.from('{oops}\n{"jsonrpc":"2.0","id":"ui-2","method":"ignored"}\n'));
  await rpc.done;

  const decoder = new NdjsonDecoder();
  assert.deepEqual(decoder.push(Buffer.concat(output)), [{
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  }]);
  assert.match(Buffer.concat(diagnostics).toString("utf8"), /parse_error/);
  await assert.rejects(rpc.peer.notify("later"), RpcDisconnectedError);
});

test("quarantines a slow handler response after fatal parse completion", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
  let enterHandler!: () => void;
  const handlerEntered = new Promise<void>((resolve) => { enterHandler = resolve; });
  let releaseHandler!: () => void;
  const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
  const rpc = new StdioRpc({ stdin, stdout, stderr, idPrefix: "core-" });
  rpc.peer.register("slow", (value) => value, async () => {
    enterHandler();
    await handlerGate;
    return { late: true };
  });

  stdin.write(Buffer.from('{"jsonrpc":"2.0","id":"ui-7","method":"slow"}\n'));
  await handlerEntered;
  stdin.write(Buffer.from('{oops}\n'));
  await rpc.done;
  releaseHandler();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const decoder = new NdjsonDecoder();
  assert.deepEqual(decoder.push(Buffer.concat(output)), [{
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  }]);
});

test("suppresses a pre-fatal queued response when it reaches the write gate", async () => {
  const stdin = new PassThrough();
  const stdout = new ControlledWriter();
  const stderr = new PassThrough();
  const rpc = new StdioRpc({ stdin, stdout, stderr, idPrefix: "core-" });
  const firstRecord = once(stdout, "record");
  const blocker = rpc.peer.notify("already-written");
  await firstRecord;
  let handleRequest!: () => void;
  const requestHandled = new Promise<void>((resolve) => { handleRequest = resolve; });
  rpc.peer.register("queued", (value) => value, () => {
    handleRequest();
    return { mustNotWrite: true };
  });

  stdin.write(Buffer.from('{"jsonrpc":"2.0","id":"ui-queued","method":"queued"}\n'));
  await requestHandled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const diagnosed = once(stderr, "data");
  stdin.write(Buffer.from('{oops}\n'));
  await diagnosed;
  stdout.releaseAndContinue();
  await blocker;
  await rpc.done;

  const decoder = new NdjsonDecoder();
  assert.deepEqual(decoder.push(Buffer.concat(stdout.chunks)), [
    { jsonrpc: "2.0", method: "already-written" },
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
  ]);
});

test("treats incomplete and overlong EOF input as diagnostics without fabricated responses", async () => {
  for (const input of [Buffer.from('{"jsonrpc":"2.0"}'), Buffer.alloc(1_048_577, 0x20)]) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const output: Buffer[] = [];
    const diagnostics: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
    stderr.on("data", (chunk: Buffer) => diagnostics.push(Buffer.from(chunk)));
    const rpc = new StdioRpc({ stdin, stdout, stderr, idPrefix: "core-" });

    stdin.end(input);
    await rpc.done;

    assert.equal(Buffer.concat(output).length, 0);
    assert.match(Buffer.concat(diagnostics).toString("utf8"), /incomplete_line|line_too_long/);
  }
});
