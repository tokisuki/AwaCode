import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { encodeNdjson, NdjsonDecoder } from "../../src/protocol/ndjson.ts";
import { runStdioCore } from "../../src/runtime/stdio-core.ts";

test("stdio Core does not consume an already-buffered request until startup convergence is registered", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "awacode-stdio-startup-"));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output: Buffer[] = [];
  const diagnostics: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
  stderr.on("data", (chunk: Buffer) => diagnostics.push(Buffer.from(chunk)));
  stdin.end(encodeNdjson({ jsonrpc: "2.0", id: "hello-1", method: "core/hello", params: {} }));

  try {
    await runStdioCore({ stdin, stdout, stderr, env: { AWACODE_DATA_DIR: dataRoot } });
    const decoder = new NdjsonDecoder();
    const messages = [...decoder.push(Buffer.concat(output)), ...decoder.end()] as Array<{
      id: string;
      result?: { configured: boolean; interruptedCount: number };
      error?: unknown;
    }>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.id, "hello-1");
    assert.equal(messages[0]?.error, undefined);
    assert.deepEqual(messages[0]?.result, {
      coreVersion: "0.1.0",
      databaseVersion: 1,
      configured: false,
      model: null,
      interruptedCount: 0,
    });
    assert.equal(Buffer.concat(diagnostics).toString("utf8"), "");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
