import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import { formatCliError } from "../../src/cli/error-format.ts";
import { RpcFault } from "../../src/protocol/json-rpc.ts";

const CLI_ENTRY = resolve("dist/cli/index.js");

test("CLI reports the actionable error message instead of replacing it with a generic failure", () => {
  const result = spawnSync(process.execPath, [CLI_ENTRY, "--invalid"], {
    encoding: "utf8",
    env: { ...process.env, AWACODE_NODE_PATH: process.execPath },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Usage: awacode --workspace/);
  assert.doesNotMatch(result.stderr, /AwaCode CLI failed\./);
});

test("CLI formatting preserves structured RPC diagnostics", () => {
  const error = new RpcFault(-32_008, "Model request failed", {
    reason: "request_failed",
    detail: "reasoning_content must be passed back",
    suggestion: "Check provider compatibility.",
  });

  assert.equal(formatCliError(error), [
    "Model request failed",
    "Reason: request_failed",
    "Detail: reasoning_content must be passed back",
    "Suggestion: Check provider compatibility.",
  ].join("\n"));
});
