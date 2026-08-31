import assert from "node:assert/strict";
import test from "node:test";

import { coreDescriptor } from "../src/index.ts";

test("exports the AwaCode Core hello descriptor", () => {
  assert.deepEqual(coreDescriptor, {
    name: "AwaCode Core",
    version: "0.1.0",
  });
});
