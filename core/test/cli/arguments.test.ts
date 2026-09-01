import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArguments } from "../../src/cli/arguments.ts";

test("CLI arguments select exactly one supported command", () => {
  assert.deepEqual(parseCliArguments(["--workspace", "D:/demo", "--prompt", "Fix it"]), {
    kind: "new",
    workspace: "D:/demo",
    prompt: "Fix it",
  });
  assert.deepEqual(parseCliArguments(["--session", "session-1", "--prompt", "Continue"]), {
    kind: "continue",
    sessionId: "session-1",
    prompt: "Continue",
  });
  assert.deepEqual(parseCliArguments(["--resume", "session-1"]), {
    kind: "resume",
    sessionId: "session-1",
  });
});

test("CLI arguments reject missing, blank, duplicate, and mixed options", () => {
  for (const argv of [
    [],
    ["--workspace", "D:/demo"],
    ["--resume", "session-1", "--prompt", "unexpected"],
    ["--session", "session-1", "--workspace", "D:/demo", "--prompt", "mixed"],
    ["--resume", ""],
    ["--unknown", "value"],
  ]) {
    assert.throws(() => parseCliArguments(argv), /Usage:/);
  }
});
