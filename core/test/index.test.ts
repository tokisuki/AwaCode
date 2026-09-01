import assert from "node:assert/strict";
import test from "node:test";

import { coreDescriptor, startupDiagnostic } from "../src/index.ts";
import { DataRootInUseError } from "../src/persistence/data-root-lock.ts";

test("exports the AwaCode Core hello descriptor", () => {
  assert.deepEqual(coreDescriptor, {
    name: "AwaCode Core",
    version: "0.1.0",
  });
});

test("startup diagnostics identify an occupied data root without exposing a path or stack", () => {
  assert.equal(
    startupDiagnostic(new DataRootInUseError()),
    "AwaCode Core is already running for this data directory. Close the other Core and retry.",
  );
  assert.equal(startupDiagnostic(new Error("D:/private/awacode.db")), "AwaCode Core startup failed.");
});
