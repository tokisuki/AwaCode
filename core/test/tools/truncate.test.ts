import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { DEFAULT_TOOL_CONTENT_BYTES, truncateUtf8Output } from "../../src/tools/truncate.ts";

test("preserves UTF-8 output byte-for-byte at and below the 50 KiB default", () => {
  assert.equal(DEFAULT_TOOL_CONTENT_BYTES, 50 * 1024);
  for (const text of ["a".repeat(DEFAULT_TOOL_CONTENT_BYTES - 1), "b".repeat(DEFAULT_TOOL_CONTENT_BYTES)]) {
    assert.deepEqual(truncateUtf8Output(text), {
      text,
      truncated: false,
      originalBytes: Buffer.byteLength(text),
      outputBytes: Buffer.byteLength(text),
    });
  }
});

test("bounds above-limit output and accounts exactly for bytes omitted by the marker", () => {
  const original = "x".repeat(DEFAULT_TOOL_CONTENT_BYTES + 1);
  const result = truncateUtf8Output(original);
  const markerMatch = result.text.match(/\n\[truncated: (\d+) bytes omitted\]$/);

  assert.equal(result.truncated, true);
  assert.equal(result.originalBytes, DEFAULT_TOOL_CONTENT_BYTES + 1);
  assert.ok(result.outputBytes <= DEFAULT_TOOL_CONTENT_BYTES);
  assert.equal(result.outputBytes, Buffer.byteLength(result.text));
  assert.ok(markerMatch);
  const marker = markerMatch[0];
  const retained = result.text.slice(0, -marker.length);
  assert.equal(Number(markerMatch[1]), result.originalBytes - Buffer.byteLength(retained));
});

test("never splits Chinese UTF-8 code points or emits replacement characters", () => {
  const result = truncateUtf8Output("中".repeat(100), 60);
  const markerIndex = result.text.indexOf("\n[truncated:");
  const retained = result.text.slice(0, markerIndex);

  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.text, /�/);
  assert.match(retained, /^(?:中)*$/);
  assert.ok(result.outputBytes <= 60);
});

test("rejects non-positive, non-integer, and marker-too-small limits", () => {
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => truncateUtf8Output("text", limit), RangeError);
  }
  assert.deepEqual(truncateUtf8Output("a", 1), {
    text: "a",
    truncated: false,
    originalBytes: 1,
    outputBytes: 1,
  });
  assert.throws(() => truncateUtf8Output("a".repeat(100), 10), /truncation marker/i);
});
