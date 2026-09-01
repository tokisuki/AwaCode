import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore } from "../../src/persistence/session-store.ts";
import { WorkspaceGuard } from "../../src/security/workspace-guard.ts";
import { ToolExecutionError, ToolValidationError } from "../../src/tools/contracts.ts";
import type { PermissionRequest } from "../../src/tools/permission.ts";
import { executeWriteFile, writeFileTool } from "../../src/tools/write-file.ts";

const temporaryDirectories: string[] = [];

async function fixture(label: string, input: unknown) {
  const dataRoot = await mkdtemp(join(tmpdir(), `awacode-write-data-${label}-`));
  const workspacePath = await mkdtemp(join(tmpdir(), `awacode-write-workspace-${label}-`));
  temporaryDirectories.push(dataRoot, workspacePath);
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: dataRoot } });
  const ids = [`session-${label}`, `message-${label}`];
  const store = new SessionStore(connection.db, {
    now: () => new Date("2026-09-01T08:00:00.000Z"),
    randomUUID: () => ids.shift()!,
  });
  store.upsertProject({ id: `project-${label}`, kind: "path", value: workspacePath, rootPath: workspacePath });
  store.createSession(`project-${label}`, label);
  store.insertAssistantMessageWithToolCalls({
    sessionId: `session-${label}`,
    payload: { tool: "write_file" },
    toolCalls: [{
      callId: `call-${label}`,
      ordinal: 0,
      toolName: "write_file",
      inputText: JSON.stringify(input),
    }],
  });
  return {
    callId: `call-${label}`,
    connection,
    store,
    workspacePath,
    workspace: await WorkspaceGuard.create(workspacePath),
  };
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("write_file exposes an exact create-only approved input contract", () => {
  assert.equal(writeFileTool.name, "write_file");
  assert.equal(writeFileTool.approval, "write");
  assert.deepEqual(writeFileTool.validate({ path: "new.txt", content: "hello" }), {
    path: "new.txt",
    content: "hello",
  });
  for (const invalid of [{}, { path: "", content: "x" }, { path: "x" }, { path: "x", content: 1 }, { path: "x", content: "x", extra: true }]) {
    assert.throws(() => writeFileTool.validate(invalid), ToolValidationError);
  }
  assert.throws(() => writeFileTool.execute({ path: "x", content: "x" }, {
    workspace: {} as never,
    signal: new AbortController().signal,
    now: () => 0,
  }), ToolExecutionError);
});

test("write_file publishes a complete new file only after one-shot approval", async () => {
  const input = { path: "created.txt", content: "hello 世界" };
  const setup = await fixture("success", input);
  const requests: PermissionRequest[] = [];
  const transitions: string[] = [];
  const compareAndSwap = setup.store.compareAndSwapToolCall.bind(setup.store);
  Object.defineProperty(setup.store, "compareAndSwapToolCall", {
    configurable: true,
    value: (value: Parameters<SessionStore["compareAndSwapToolCall"]>[0]) => {
      transitions.push(`${value.expectedStatus}->${value.status}`);
      return compareAndSwap(value);
    },
  });
  try {
    const result = await writeFileTool.execute(writeFileTool.validate(input), {
      workspace: setup.workspace,
      signal: new AbortController().signal,
      now: () => 20,
      approvedToolRuntime: {
        callId: setup.callId,
        store: setup.store,
        permissionClient: {
          async requestPermission(request) {
            requests.push(request);
            return "allow_once";
          },
        },
      },
    });

    assert.equal(result.status, "success");
    assert.equal(await readFile(join(setup.workspacePath, "created.txt"), "utf8"), "hello 世界");
    assert.deepEqual(transitions, [
      "pending->awaiting_approval",
      "awaiting_approval->running",
      "running->success",
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "write");
    assert.equal(requests[0]?.title, "Create created.txt (12 bytes)");
    if (requests[0]?.kind === "write") {
      assert.equal(requests[0].preview.path, "created.txt");
      assert.equal(requests[0].preview.before, "");
      assert.equal(requests[0].preview.after, "hello 世界");
      assert.match(requests[0].preview.sha256, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(setup.store.loadToolCall(setup.callId).result, result);
  } finally {
    setup.connection.close();
  }
});

test("write_file rejects an existing target before approval", async () => {
  const input = { path: "existing.txt", content: "new" };
  const setup = await fixture("existing", input);
  await writeFile(join(setup.workspacePath, "existing.txt"), "original", "utf8");
  let approvals = 0;
  try {
    const result = await writeFileTool.execute(writeFileTool.validate(input), {
      workspace: setup.workspace,
      signal: new AbortController().signal,
      now: () => 0,
      approvedToolRuntime: {
        callId: setup.callId,
        store: setup.store,
        permissionClient: { async requestPermission() { approvals += 1; return "allow_once"; } },
      },
    });
    assert.equal(result.status, "failure");
    assert.equal(result.metadata.error, "target_exists");
    assert.equal(approvals, 0);
    assert.equal(await readFile(join(setup.workspacePath, "existing.txt"), "utf8"), "original");
  } finally {
    setup.connection.close();
  }
});

test("write_file atomically loses a publication race without overwriting the winner", async () => {
  const input = { path: "race.txt", content: "approved" };
  const setup = await fixture("race", input);
  try {
    const result = await writeFileTool.execute(writeFileTool.validate(input), {
      workspace: setup.workspace,
      signal: new AbortController().signal,
      now: () => 0,
      approvedToolRuntime: {
        callId: setup.callId,
        store: setup.store,
        permissionClient: {
          async requestPermission() {
            await writeFile(join(setup.workspacePath, "race.txt"), "race winner", "utf8");
            return "allow_once";
          },
        },
      },
    });
    assert.equal(result.status, "failure");
    assert.equal(result.metadata.error, "target_exists");
    assert.equal(await readFile(join(setup.workspacePath, "race.txt"), "utf8"), "race winner");
  } finally {
    setup.connection.close();
  }
});

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path));
}

test("write_file rejects a parent replacement before temporary creation", async () => {
  const input = { path: "parent/created.txt", content: "approved" };
  const setup = await fixture("parent-before-temp", input);
  const outside = await mkdtemp(join(tmpdir(), "awacode-write-outside-before-temp-"));
  temporaryDirectories.push(outside);
  await mkdir(join(setup.workspacePath, "parent"));
  try {
    const movedParent = join(outside, "moved-parent");
    const result = await executeWriteFile({
      callId: setup.callId,
      store: setup.store,
      permissionClient: { async requestPermission() { return "allow_once"; } },
      context: { workspace: setup.workspace, signal: new AbortController().signal, now: () => 0 },
      async barrier(event) {
        if (event === "before_temp_create") {
          await rename(join(setup.workspacePath, "parent"), movedParent);
          await mkdir(join(setup.workspacePath, "parent"));
          await writeFile(join(setup.workspacePath, "parent", "created.txt"), "racer", "utf8");
        }
      },
    });
    assert.equal(result.status, "failure");
    assert.equal(result.metadata.error, "parent_changed");
    assert.equal(await readFile(join(setup.workspacePath, "parent", "created.txt"), "utf8"), "racer");
    await assertMissing(join(movedParent, "created.txt"));
  } finally {
    setup.connection.close();
  }
});

test("write_file rejects a parent replacement immediately before publication", async () => {
  const input = { path: "parent/created.txt", content: "approved" };
  const setup = await fixture("parent-before-publish", input);
  const outside = await mkdtemp(join(tmpdir(), "awacode-write-outside-before-publish-"));
  temporaryDirectories.push(outside);
  await mkdir(join(setup.workspacePath, "parent"));
  try {
    const movedParent = join(outside, "moved-parent");
    const result = await executeWriteFile({
      callId: setup.callId,
      store: setup.store,
      permissionClient: { async requestPermission() { return "allow_once"; } },
      context: { workspace: setup.workspace, signal: new AbortController().signal, now: () => 0 },
      createTemporaryName: () => "parent-swap",
      async barrier(event) {
        if (event === "before_publish") {
          await rename(join(setup.workspacePath, "parent"), movedParent);
          await mkdir(join(setup.workspacePath, "parent"));
          await writeFile(join(setup.workspacePath, "parent", "created.txt"), "racer", "utf8");
        }
      },
    });
    assert.equal(result.status, "failure");
    assert.equal(result.metadata.error, "parent_changed");
    assert.equal(await readFile(join(setup.workspacePath, "parent", "created.txt"), "utf8"), "racer");
    await assertMissing(join(movedParent, "created.txt"));
  } finally {
    setup.connection.close();
  }
});

test("write_file exercises EEXIST at link publication and preserves the racing target", async () => {
  const input = { path: "link-race.txt", content: "approved" };
  const setup = await fixture("link-race", input);
  try {
    const result = await executeWriteFile({
      callId: setup.callId,
      store: setup.store,
      permissionClient: { async requestPermission() { return "allow_once"; } },
      context: { workspace: setup.workspace, signal: new AbortController().signal, now: () => 0 },
      async barrier(event) {
        if (event === "before_link") {
          await writeFile(join(setup.workspacePath, "link-race.txt"), "race winner", "utf8");
        }
      },
    });
    assert.equal(result.status, "failure");
    assert.equal(result.metadata.error, "target_exists");
    assert.equal(await readFile(join(setup.workspacePath, "link-race.txt"), "utf8"), "race winner");
  } finally {
    setup.connection.close();
  }
});

test("write_file post-publication validation never removes a replacement racer", async () => {
  const input = { path: "post-publish-race.txt", content: "approved" };
  const setup = await fixture("post-publish-race", input);
  try {
    const target = join(setup.workspacePath, "post-publish-race.txt");
    const result = await executeWriteFile({
      callId: setup.callId,
      store: setup.store,
      permissionClient: { async requestPermission() { return "allow_once"; } },
      context: { workspace: setup.workspace, signal: new AbortController().signal, now: () => 0 },
      async barrier(event) {
        if (event === "after_publish") {
          await unlink(target);
          await writeFile(target, "replacement racer", "utf8");
        }
      },
    });
    assert.equal(result.status, "failure");
    assert.equal(result.metadata.error, "published_file_changed");
    assert.equal(await readFile(target, "utf8"), "replacement racer");
  } finally {
    setup.connection.close();
  }
});
