import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryStore } from "../../src/memory/memory-store.ts";
import { WorkspaceGuard } from "../../src/security/workspace-guard.ts";
import { ToolExecutionError, ToolValidationError } from "../../src/tools/contracts.ts";
import { memoryWriteTool } from "../../src/tools/memory-write.ts";

const temporaryDirectories: string[] = [];

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("memory_write validates explicit global/project exact-write operations and needs no second approval", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "awacode-memory-tool-data-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "awacode-memory-tool-workspace-"));
  temporaryDirectories.push(dataRoot, workspacePath);
  const memory = new MemoryStore({ env: { AWACODE_DATA_DIR: dataRoot } });
  assert.equal(memoryWriteTool.name, "memory_write");
  assert.equal(memoryWriteTool.approval, "none");
  assert.deepEqual(memoryWriteTool.validate({ scope: "project", new_text: "Remember this." }), {
    scope: "project",
    newText: "Remember this.",
  });
  assert.deepEqual(memoryWriteTool.validate({ scope: "global", old_text: "old", new_text: "" }), {
    scope: "global",
    oldText: "old",
    newText: "",
  });
  for (const invalid of [{}, { scope: "session", new_text: "x" }, { scope: "global", new_text: 1 }, { scope: "global", new_text: "" }, { scope: "global", old_text: "", new_text: "x" }]) {
    assert.throws(() => memoryWriteTool.validate(invalid), ToolValidationError);
  }

  const result = await memoryWriteTool.execute(
    memoryWriteTool.validate({ scope: "project", new_text: "Remember this." }),
    {
      workspace: await WorkspaceGuard.create(workspacePath),
      signal: new AbortController().signal,
      now: () => 12,
      memoryRuntime: { store: memory, projectId: "project-one" },
    },
  );
  assert.equal(result.status, "success");
  assert.equal(result.metadata.scope, "project");
  assert.equal((await memory.read("project-one")).project, "Remember this.");
});

test("memory_write refuses execution when Core did not resolve a memory target", async () => {
  assert.rejects(memoryWriteTool.execute(
    memoryWriteTool.validate({ scope: "project", new_text: "x" }),
    {
      workspace: {} as never,
      signal: new AbortController().signal,
      now: () => 0,
    },
  ), ToolExecutionError);
});
