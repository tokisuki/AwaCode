import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeNdjson,
  NdjsonDecoder,
  NdjsonProtocolError,
} from "../../src/protocol/ndjson.ts";

const encoder = new TextEncoder();

test("decodes one object split across byte chunks", () => {
  const decoder = new NdjsonDecoder();

  assert.deepEqual(decoder.push(encoder.encode('{"id":')), []);
  assert.deepEqual(decoder.push(encoder.encode('7}\n')), [{ id: 7 }]);
});

test("decodes several objects from one chunk in order", () => {
  const decoder = new NdjsonDecoder();

  assert.deepEqual(decoder.push(encoder.encode('{"id":1}\n{"id":2}\n')), [
    { id: 1 },
    { id: 2 },
  ]);
});

test("preserves a Chinese code point split across UTF-8 chunks", () => {
  const decoder = new NdjsonDecoder();
  const record = encoder.encode('{"message":"中"}\n');
  const splitAt = 13;

  assert.deepEqual(decoder.push(record.slice(0, splitAt)), []);
  assert.deepEqual(decoder.push(record.slice(splitAt)), [{ message: "中" }]);
});

test("does not treat escaped newline text inside JSON as a delimiter", () => {
  const decoder = new NdjsonDecoder();

  assert.deepEqual(decoder.push(encoder.encode('{"message":"first\\nsecond"}\n')), [
    { message: "first\nsecond" },
  ]);
});

test("accepts LF and CRLF while ignoring blank lines", () => {
  const decoder = new NdjsonDecoder();

  assert.deepEqual(decoder.push(encoder.encode('\n \t\r\n{"id":1}\n{"id":2}\r\n')), [
    { id: 1 },
    { id: 2 },
  ]);
});

test("reports malformed JSON and becomes terminal", () => {
  const decoder = new NdjsonDecoder();
  let error: unknown;

  assert.throws(
    () => decoder.push(encoder.encode('{oops}\n')),
    (caught: unknown) => {
      error = caught;
      return caught instanceof NdjsonProtocolError && caught.code === "parse_error";
    },
  );
  assert.throws(() => decoder.push(encoder.encode('{"id":1}\n')), (caught: unknown) => caught === error);
  assert.throws(() => decoder.end(), (caught: unknown) => caught === error);
});

test("accepts a 1 MiB line and rejects one byte more before its delimiter", () => {
  const exactLimit = new NdjsonDecoder();
  const oneMiBJson = `"${"a".repeat(1_048_574)}"`;
  const overLimit = new NdjsonDecoder();
  let error: unknown;

  assert.deepEqual(exactLimit.push(encoder.encode(`${oneMiBJson}\n`)), ["a".repeat(1_048_574)]);
  assert.throws(
    () => overLimit.push(encoder.encode("a".repeat(1_048_577))),
    (caught: unknown) => {
      error = caught;
      return caught instanceof NdjsonProtocolError && caught.code === "line_too_long";
    },
  );
  assert.throws(() => overLimit.end(), (caught: unknown) => caught === error);
});

test("rejects a non-whitespace final line but ignores whitespace at EOF", () => {
  const incomplete = new NdjsonDecoder();
  const whitespace = new NdjsonDecoder();

  incomplete.push(encoder.encode('{"id":1}'));
  assert.throws(
    () => incomplete.end(),
    (caught: unknown) => caught instanceof NdjsonProtocolError && caught.code === "incomplete_line",
  );
  whitespace.push(encoder.encode(' \t\r'));
  assert.deepEqual(whitespace.end(), []);
});

test("rejects an EOF line whose trailing CR makes it exceed the byte limit", () => {
  const decoder = new NdjsonDecoder(3);
  let error: unknown;

  assert.deepEqual(decoder.push(encoder.encode("abc\r")), []);
  assert.throws(
    () => decoder.end(),
    (caught: unknown) => {
      error = caught;
      return caught instanceof NdjsonProtocolError && caught.code === "line_too_long";
    },
  );
  assert.throws(() => decoder.push(encoder.encode("\n")), (caught: unknown) => caught === error);
  assert.throws(() => decoder.end(), (caught: unknown) => caught === error);
});

test("rejects oversized whitespace-only EOF lines", () => {
  const decoder = new NdjsonDecoder(3);

  assert.deepEqual(decoder.push(encoder.encode("   \r")), []);
  assert.throws(
    () => decoder.end(),
    (caught: unknown) => caught instanceof NdjsonProtocolError && caught.code === "line_too_long",
  );
});

test("encodes one compact newline-terminated record and rejects undefined", () => {
  assert.deepEqual(encodeNdjson({ id: 1, message: "中" }), encoder.encode('{"id":1,"message":"中"}\n'));
  assert.throws(() => encodeNdjson(undefined), TypeError);
});
