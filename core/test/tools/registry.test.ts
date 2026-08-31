import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExactPlainObject,
  ToolExecutionError,
  type ToolDefinition,
  ToolValidationError,
} from "../../src/tools/contracts.ts";
import { ToolRegistry, ToolRegistryError } from "../../src/tools/registry.ts";

function definition(name: string, execute = async () => ({
  status: "success" as const,
  summary: "ok",
  content: "",
  durationMs: 0,
  metadata: {},
})): ToolDefinition<Record<string, never>> {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
    approval: "none",
    validate(value: unknown) {
      assertExactPlainObject(value, [], []);
      return {};
    },
    execute,
  };
}

test("registers valid stable names and lists definitions lexicographically without executing", () => {
  let executions = 0;
  const registry = new ToolRegistry();
  const zebra = definition("zebra", async () => {
    executions += 1;
    return { status: "success", summary: "ok", content: "", durationMs: 0, metadata: {} };
  });
  const alpha = definition("alpha_2");

  registry.register(zebra);
  registry.register(alpha);

  assert.equal(registry.get("zebra"), zebra);
  assert.deepEqual(registry.list(), [alpha, zebra]);
  assert.equal(executions, 0);
});

test("rejects invalid and duplicate tool names rather than overwriting", () => {
  for (const name of ["", " read", "1read", "Read", "read-file", "read.file"]) {
    const registry = new ToolRegistry();
    assert.throws(() => registry.register(definition(name)), (error: unknown) => {
      assert.ok(error instanceof ToolRegistryError);
      assert.equal(error.code, "invalid_name");
      return true;
    });
  }

  const registry = new ToolRegistry();
  const original = definition("read_file");
  registry.register(original);
  assert.throws(() => registry.register(definition("read_file")), (error: unknown) => {
    assert.ok(error instanceof ToolRegistryError);
    assert.equal(error.code, "duplicate_name");
    return true;
  });
  assert.equal(registry.get("read_file"), original);
});

test("reports unknown tool lookup with one stable error", () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.get("missing"), (error: unknown) => {
    assert.ok(error instanceof ToolRegistryError);
    assert.equal(error.code, "not_found");
    assert.equal(error.message, "Tool is not registered.");
    assert.doesNotMatch(error.message, /missing/);
    return true;
  });
});

test("exact-object validation rejects null, arrays, inherited, missing, extra, and wrong shapes", () => {
  const valid = { path: "src", limit: 2 };
  const result = assertExactPlainObject(valid, ["path", "limit"], ["path"]);
  assert.notEqual(result, valid);
  assert.deepEqual(result, valid);
  assert.deepEqual(valid, { path: "src", limit: 2 });

  const inherited = Object.create({ path: "src" }) as Record<string, unknown>;
  inherited.limit = 2;
  for (const invalid of [null, [], inherited, {}, { path: "src", extra: true }]) {
    assert.throws(
      () => assertExactPlainObject(invalid, ["path", "limit"], ["path"]),
      ToolValidationError,
    );
  }
});

test("tool validation and execution errors expose stable sanitized codes", () => {
  const validation = new ToolValidationError();
  const execution = new ToolExecutionError();
  assert.deepEqual(
    { name: validation.name, code: validation.code, message: validation.message },
    { name: "ToolValidationError", code: "invalid_tool_input", message: "Tool input is invalid." },
  );
  assert.deepEqual(
    { name: execution.name, code: execution.code, message: execution.message },
    { name: "ToolExecutionError", code: "tool_execution_failed", message: "Tool execution failed." },
  );
});
