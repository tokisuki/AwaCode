import assert from "node:assert/strict";
import test from "node:test";

import { redactDiagnostic } from "../../src/config/diagnostic-redactor.ts";

test("recursively redacts labelled credentials and exact active secrets while preserving diagnostics", () => {
  const activeSecret = "fixture-active-secret";
  const diagnostic = {
    message: `upstream rejected ${activeSecret} during setup`,
    authorization: "Bearer labelled-authorization-value",
    nested: {
      apiKey: "labelled-api-value",
      access_token: "labelled-token-value",
      password: "labelled-password-value",
      privateKey: "labelled-private-value",
      ordinary: "connection refused",
    },
    tokenCount: 42,
    passwordPolicy: "strict",
    syntaxSecret: "language keyword",
    privateMode: false,
  };

  assert.deepEqual(redactDiagnostic(diagnostic, [activeSecret]), {
    message: "upstream rejected [REDACTED] during setup",
    authorization: "[REDACTED]",
    nested: {
      apiKey: "[REDACTED]",
      access_token: "[REDACTED]",
      password: "[REDACTED]",
      privateKey: "[REDACTED]",
      ordinary: "connection refused",
    },
    tokenCount: 42,
    passwordPolicy: "strict",
    syntaxSecret: "language keyword",
    privateMode: false,
  });
});

test("handles arrays, cycles, and enumerable getters without evaluating accessors", () => {
  let getterCalls = 0;
  const diagnostic: Record<string, unknown> = { visible: "kept" };
  Object.defineProperty(diagnostic, "explosive", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("must not run");
    },
  });
  diagnostic.self = diagnostic;
  diagnostic.items = [{ token: "array-token-value" }, diagnostic];

  assert.deepEqual(redactDiagnostic(diagnostic), {
    visible: "kept",
    self: "[Circular]",
    items: [{ token: "[REDACTED]" }, "[Circular]"],
  });
  assert.equal(getterCalls, 0);
});

test("bounds large and deeply nested returned diagnostics", () => {
  const large: Record<string, unknown> = {};
  for (let index = 0; index < 500; index += 1) {
    large[`field${index}`] = "x".repeat(500);
  }
  let deep: Record<string, unknown> = large;
  for (let index = 0; index < 20; index += 1) {
    deep = { next: deep };
  }

  const redacted = redactDiagnostic({ long: "y".repeat(10000), deep });
  const serialized = JSON.stringify(redacted);

  assert.ok(serialized.length <= 20000, `diagnostic length was ${serialized.length}`);
  assert.equal(serialized.includes("y".repeat(4001)), false);
  assert.match(serialized, /\[Truncated\]/);
});
