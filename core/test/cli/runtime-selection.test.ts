import assert from "node:assert/strict";
import test from "node:test";

import { selectNodeExecutable } from "../../src/cli/runtime-selection.ts";

test("AWACODE_NODE_PATH selects the explicit Node runtime", () => {
  assert.equal(selectNodeExecutable({
    env: { AWACODE_NODE_PATH: "D:/runtime/node.exe" },
    execPath: "C:/old/node.exe",
    nodeVersion: "18.20.0",
  }), "D:/runtime/node.exe");
});

test("the current executable is accepted only when its major version is at least 24", () => {
  assert.equal(selectNodeExecutable({
    env: {},
    execPath: "D:/node24/node.exe",
    nodeVersion: "24.19.0",
  }), "D:/node24/node.exe");
  assert.throws(() => selectNodeExecutable({
    env: {},
    execPath: "C:/node18/node.exe",
    nodeVersion: "18.20.0",
  }), /Node\.js 24/);
});
