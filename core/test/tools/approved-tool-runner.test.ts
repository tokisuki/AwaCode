import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore } from "../../src/persistence/session-store.ts";
import { RpcDisconnectedError } from "../../src/protocol/json-rpc.ts";
import type { ProjectIdentity } from "../../src/project/project-identity.ts";
import { WorkspaceGuard } from "../../src/security/workspace-guard.ts";
import { recoverInterruptedState } from "../../src/session/recovery.ts";
import { transitionToolCall } from "../../src/session/tool-call-state.ts";
import { editFileTool, executeEditFile } from "../../src/tools/edit-file.ts";
import {
  PermissionProtocolError,
  PermissionTimeoutError,
  type PermissionClient,
  type PermissionRequest,
} from "../../src/tools/permission.ts";
import {
  disposeChildChannel,
  spawnChildChannel,
} from "../support/child-process.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-approved-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function identity(id: string, rootPath: string): ProjectIdentity {
  return {
    id,
    kind: "remote",
    value: "github.com/openai/awacode",
    remote: "github.com/openai/awacode",
    rootPath,
  };
}

async function fixture(
  label: string,
  input: unknown,
  persisted: { toolName?: string; inputText?: string } = {},
) {
  const root = await temporaryDirectory(`${label}-data`);
  const workspacePath = await temporaryDirectory(`${label}-workspace`);
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  const ids = [`session-${label}`, `message-${label}`];
  const store = new SessionStore(connection.db, {
    now: () => new Date("2026-09-01T08:00:00.000Z"),
    randomUUID: () => ids.shift() as string,
  });
  store.upsertProject(identity(`project-${label}`, workspacePath));
  store.createSession(`project-${label}`, label);
  store.insertAssistantMessageWithToolCalls({
    sessionId: `session-${label}`,
    payload: { tool: "edit_file" },
    toolCalls: [{
      callId: `call-${label}`,
      ordinal: 0,
      toolName: persisted.toolName ?? "edit_file",
      inputText: persisted.inputText ?? JSON.stringify(input),
    }],
  });
  return {
    callId: `call-${label}`,
    connection,
    dataRoot: root,
    store,
    workspacePath,
    workspace: await WorkspaceGuard.create(workspacePath),
  };
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|OPENAI|ANTHROPIC|AZURE|AWS)/i.test(name)));
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("persists pending to awaiting_approval to running to success around one approved edit", async () => {
  const input = { path: "sample.txt", old_text: "old", new_text: "new" };
  const setup = await fixture("allow", input);
  const targetPath = join(setup.workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  const transitions: string[] = [];
  const compareAndSwap = setup.store.compareAndSwapToolCall.bind(setup.store);
  Object.defineProperty(setup.store, "compareAndSwapToolCall", {
    configurable: true,
    value: (value: Parameters<SessionStore["compareAndSwapToolCall"]>[0]) => {
      transitions.push(`${value.expectedStatus}->${value.status}`);
      return compareAndSwap(value);
    },
  });
  const requests: PermissionRequest[] = [];
  const permissionClient: PermissionClient = {
    async requestPermission(request) {
      requests.push(request);
      return "allow_once";
    },
  };
  const times = [100, 109];
  const stdoutWrites: unknown[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    stdoutWrites.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await editFileTool.execute(editFileTool.validate(input), {
      workspace: setup.workspace,
      signal: new AbortController().signal,
      now: () => times.shift() ?? 109,
      approvedToolRuntime: {
        callId: setup.callId,
        store: setup.store,
        permissionClient,
      },
    });

    assert.deepEqual(result, {
      status: "success",
      summary: "Edited 1 occurrence in the workspace file.",
      content: "Updated sample.txt with 1 exact replacement.",
      durationMs: 9,
      metadata: { path: "sample.txt", replacementCount: 1, replaceAll: false },
    });
    assert.deepEqual(transitions, [
      "pending->awaiting_approval",
      "awaiting_approval->running",
      "running->success",
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.callId, setup.callId);
    assert.equal(requests[0]?.kind, "write");
    if (requests[0]?.kind === "write") {
      assert.equal(requests[0].preview.path, "sample.txt");
    }
    assert.equal(await readFile(targetPath, "utf8"), "before new after");
    const stored = setup.store.loadToolCall(setup.callId);
    assert.equal(stored.status, "success");
    assert.deepEqual(stored.result, result);
    assert.notEqual(stored.finishedAt, null);
  } finally {
    process.stdout.write = originalStdoutWrite;
    setup.connection.close();
  }
  assert.deepEqual(stdoutWrites, []);
});

test("rejects a persisted tool-name mismatch before approval or file access", async () => {
  const callerInput = { path: "sample.txt", old_text: "old", new_text: "new" };
  const setup = await fixture("persisted-tool-mismatch", callerInput, {
    toolName: "read_file",
    inputText: JSON.stringify({ path: "audit.txt" }),
  });
  const targetPath = join(setup.workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  let requests = 0;
  const times = [150, 154];
  try {
    const result = await executeEditFile({
      callId: setup.callId,
      store: setup.store,
      permissionClient: {
        async requestPermission() {
          requests += 1;
          return "allow_once";
        },
      },
      context: {
        workspace: setup.workspace,
        signal: new AbortController().signal,
        now: () => times.shift() ?? 154,
      },
    });

    assert.deepEqual(result, {
      status: "failure",
      summary: "Unable to edit workspace file.",
      content: "Persisted tool call does not match edit_file.",
      durationMs: 4,
      metadata: { tool: "edit_file", phase: "preparation", error: "persisted_tool_mismatch" },
    });
    assert.equal(requests, 0);
    assert.equal(await readFile(targetPath, "utf8"), "before old after");
    assert.deepEqual(setup.store.loadToolCall(setup.callId).result, result);
  } finally {
    setup.connection.close();
  }
});

test("approves and executes the persisted input rather than independent caller input", async () => {
  const persistedInput = { path: "sample.txt", old_text: "old", new_text: "persisted" };
  const callerInput = { path: "sample.txt", old_text: "old", new_text: "caller" };
  const setup = await fixture("persisted-input", persistedInput);
  const targetPath = join(setup.workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  const requests: PermissionRequest[] = [];
  try {
    const result = await editFileTool.execute(editFileTool.validate(callerInput), {
      workspace: setup.workspace,
      signal: new AbortController().signal,
      now: () => 175,
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
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "write");
    if (requests[0]?.kind === "write") {
      assert.equal(requests[0].preview.after, "persisted");
    }
    assert.equal(await readFile(targetPath, "utf8"), "before persisted after");
    assert.deepEqual(setup.store.loadToolCall(setup.callId).result, result);
  } finally {
    setup.connection.close();
  }
});

test("persists malformed stored JSON as a stable failure without approval or file access", async () => {
  const callerInput = { path: "sample.txt", old_text: "old", new_text: "caller" };
  const setup = await fixture("malformed-persisted-input", callerInput, {
    inputText: "{not-json",
  });
  const targetPath = join(setup.workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  let requests = 0;
  const times = [180, 186];
  try {
    const result = await executeEditFile({
      callId: setup.callId,
      store: setup.store,
      permissionClient: {
        async requestPermission() {
          requests += 1;
          return "allow_once";
        },
      },
      context: {
        workspace: setup.workspace,
        signal: new AbortController().signal,
        now: () => times.shift() ?? 186,
      },
    });

    assert.deepEqual(result, {
      status: "failure",
      summary: "Unable to edit workspace file.",
      content: "Persisted tool input is malformed.",
      durationMs: 6,
      metadata: { tool: "edit_file", phase: "preparation", error: "persisted_input_malformed" },
    });
    assert.equal(requests, 0);
    assert.equal(await readFile(targetPath, "utf8"), "before old after");
    assert.deepEqual(setup.store.loadToolCall(setup.callId).result, result);
  } finally {
    setup.connection.close();
  }
});

test("persists an explicit deny as the only denied result and never edits", async () => {
  const input = { path: "sample.txt", old_text: "old", new_text: "new" };
  const setup = await fixture("deny", input);
  const targetPath = join(setup.workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  let requests = 0;
  const times = [200, 207];
  try {
    const result = await executeEditFile({
      callId: setup.callId,
      store: setup.store,
      permissionClient: {
        async requestPermission() {
          requests += 1;
          return "deny";
        },
      },
      context: {
        workspace: setup.workspace,
        signal: new AbortController().signal,
        now: () => times.shift() ?? 207,
      },
    });

    assert.deepEqual(result, {
      status: "denied",
      summary: "File edit was denied.",
      content: "The file edit was not authorized and no local side effect occurred.",
      durationMs: 7,
      metadata: { tool: "edit_file", approval: "denied", sideEffects: "none" },
    });
    assert.equal(requests, 1);
    assert.equal(await readFile(targetPath, "utf8"), "before old after");
    const stored = setup.store.loadToolCall(setup.callId);
    assert.equal(stored.status, "denied");
    assert.deepEqual(stored.result, result);
  } finally {
    setup.connection.close();
  }
});

test("persists validation and preparation failures from pending without requesting approval", async () => {
  for (const [label, input, source, expectedError] of [
    ["invalid", { path: "sample.txt", old_text: "old", new_text: "new", extra: true }, "before old after", "invalid_tool_input"],
    ["missing", { path: "sample.txt", old_text: "missing", new_text: "new" }, "before old after", "match_not_found"],
    ["binary", { path: "sample.txt", old_text: "a", new_text: "b" }, Buffer.from([0x61, 0x00, 0x62]), "unsupported_encoding"],
  ] as const) {
    const setup = await fixture(`failure-${label}`, input);
    const targetPath = join(setup.workspacePath, "sample.txt");
    await writeFile(targetPath, source);
    let requests = 0;
    const times = [300, 305];
    try {
      const result = await executeEditFile({
        callId: setup.callId,
        store: setup.store,
        permissionClient: {
          async requestPermission() {
            requests += 1;
            return "allow_once";
          },
        },
        context: {
          workspace: setup.workspace,
          signal: new AbortController().signal,
          now: () => times.shift() ?? 305,
        },
      });

      assert.equal(result.status, "failure");
      assert.equal(result.durationMs, 5);
      assert.equal(result.metadata.error, expectedError);
      assert.equal(requests, 0);
      assert.deepEqual(await readFile(targetPath), Buffer.from(source));
      const stored = setup.store.loadToolCall(setup.callId);
      assert.equal(stored.status, "failure");
      assert.deepEqual(stored.result, result);
    } finally {
      setup.connection.close();
    }
  }
});

test("persists cancellation at both preparation barriers as interrupted without approval or write", async () => {
  for (const barrier of ["file_resolved", "file_opened"] as const) {
    const input = { path: "sample.txt", old_text: "old", new_text: "new" };
    const setup = await fixture(`preparation-abort-${barrier}`, input);
    const targetPath = join(setup.workspacePath, "sample.txt");
    await writeFile(targetPath, "before old after", "utf8");
    const controller = new AbortController();
    let requests = 0;
    try {
      const result = await executeEditFile({
        callId: setup.callId,
        store: setup.store,
        permissionClient: {
          async requestPermission() {
            requests += 1;
            return "allow_once";
          },
        },
        context: {
          workspace: setup.workspace,
          signal: controller.signal,
          now: () => 350,
          async accessBarrier(event) {
            if (event.kind === barrier) {
              controller.abort(new Error(`cancel at ${barrier}`));
            }
          },
        },
      });

      assert.equal(result.status, "interrupted", barrier);
      assert.equal(result.metadata.error, "cancelled", barrier);
      assert.equal(result.metadata.phase, "preparation", barrier);
      assert.equal(requests, 0, barrier);
      assert.equal(await readFile(targetPath, "utf8"), "before old after", barrier);
      const stored = setup.store.loadToolCall(setup.callId);
      assert.equal(stored.status, "interrupted", barrier);
      assert.deepEqual(stored.result, result, barrier);
    } finally {
      setup.connection.close();
    }
  }
});

test("converges timeout, abort, disconnect, and protocol approval failures to interrupted", async () => {
  for (const [label, errorFactory, expectedError] of [
    ["timeout", () => new PermissionTimeoutError(), "approval_timeout"],
    ["disconnect", () => new RpcDisconnectedError(), "approval_disconnected"],
    ["protocol", () => new PermissionProtocolError(), "approval_protocol_failure"],
    ["abort", () => new Error("cancelled"), "approval_cancelled"],
  ] as const) {
    const input = { path: "sample.txt", old_text: "old", new_text: "new" };
    const setup = await fixture(`approval-${label}`, input);
    const targetPath = join(setup.workspacePath, "sample.txt");
    await writeFile(targetPath, "before old after", "utf8");
    const controller = new AbortController();
    const times = [400, 406];
    try {
      const result = await executeEditFile({
        callId: setup.callId,
        store: setup.store,
        permissionClient: {
          async requestPermission() {
            const error = errorFactory();
            if (label === "abort") {
              controller.abort(error);
            }
            throw error;
          },
        },
        context: {
          workspace: setup.workspace,
          signal: controller.signal,
          now: () => times.shift() ?? 406,
        },
      });

      assert.equal(result.status, "interrupted");
      assert.equal(result.durationMs, 6);
      assert.equal(result.metadata.error, expectedError);
      assert.equal(await readFile(targetPath, "utf8"), "before old after");
      const stored = setup.store.loadToolCall(setup.callId);
      assert.equal(stored.status, "interrupted");
      assert.deepEqual(stored.result, result);
    } finally {
      setup.connection.close();
    }
  }
});

test("a losing duplicate runner observes the winner result without a second approval or edit", async () => {
  const input = { path: "sample.txt", old_text: "old", new_text: "new" };
  const setup = await fixture("duplicate-runner", input);
  const targetPath = join(setup.workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  let approvalEntered!: () => void;
  const entered = new Promise<void>((resolve) => { approvalEntered = resolve; });
  let releaseApproval!: () => void;
  const gate = new Promise<void>((resolve) => { releaseApproval = resolve; });
  let requests = 0;
  const permissionClient: PermissionClient = {
    async requestPermission() {
      requests += 1;
      approvalEntered();
      await gate;
      return "allow_once";
    },
  };
  const execute = () => executeEditFile({
    callId: setup.callId,
    store: setup.store,
    permissionClient,
    context: {
      workspace: setup.workspace,
      signal: new AbortController().signal,
      now: () => 500,
    },
  });
  try {
    const winner = execute();
    await entered;
    const loser = execute();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
    releaseApproval();

    const [winnerResult, loserResult] = await Promise.all([winner, loser]);
    assert.deepEqual(loserResult, winnerResult);
    assert.equal(requests, 1);
    assert.equal(await readFile(targetPath, "utf8"), "before new after");
    const stored = setup.store.loadToolCall(setup.callId);
    assert.equal(stored.status, "success");
    assert.deepEqual(stored.result, winnerResult);
  } finally {
    setup.connection.close();
  }
});

test("a duplicate preparation-failure CAS loser observes the winner's durable result", async () => {
  const input = { path: "sample.txt", old_text: "old", new_text: "new" };
  const setup = await fixture("duplicate-preparation-failure", input);
  const targetPath = join(setup.workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  let approvalEntered!: () => void;
  const entered = new Promise<void>((resolve) => { approvalEntered = resolve; });
  let releaseApproval!: () => void;
  const gate = new Promise<void>((resolve) => { releaseApproval = resolve; });
  let requests = 0;
  const execute = () => executeEditFile({
    callId: setup.callId,
    store: setup.store,
    permissionClient: {
      async requestPermission() {
        requests += 1;
        approvalEntered();
        await gate;
        return "allow_once";
      },
    },
    context: {
      workspace: setup.workspace,
      signal: new AbortController().signal,
      now: () => 550,
    },
  });
  try {
    const winner = execute();
    await entered;
    await writeFile(targetPath, "external change", "utf8");
    const loser = execute();
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseApproval();
    const [winnerResult, loserResult] = await Promise.all([winner, loser]);

    assert.equal(requests, 1);
    assert.equal(winnerResult.status, "failure");
    assert.equal(winnerResult.metadata.error, "file_changed");
    assert.deepEqual(loserResult, winnerResult);
    assert.deepEqual(setup.store.loadToolCall(setup.callId).result, winnerResult);
    assert.equal(await readFile(targetPath, "utf8"), "external change");
  } finally {
    releaseApproval();
    setup.connection.close();
  }
});

test("cancel versus allow returns the competing interrupted result and never writes", async () => {
  const input = { path: "sample.txt", old_text: "old", new_text: "new" };
  const setup = await fixture("cancel-race", input);
  const targetPath = join(setup.workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  let entered!: () => void;
  const approvalEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cancelled = {
    status: "interrupted",
    summary: "Cancelled by competing path.",
    content: "No side effect occurred.",
    durationMs: 3,
    metadata: { source: "cancel", sideEffects: "none" },
  };
  try {
    const running = executeEditFile({
      callId: setup.callId,
      store: setup.store,
      permissionClient: {
        async requestPermission() {
          entered();
          await gate;
          return "allow_once";
        },
      },
      context: {
        workspace: setup.workspace,
        signal: new AbortController().signal,
        now: () => 600,
      },
    });
    await approvalEntered;
    assert.equal(transitionToolCall(setup.store, {
      callId: setup.callId,
      expectedStatus: "awaiting_approval",
      status: "interrupted",
      result: cancelled,
    }).kind, "applied");
    release();

    assert.deepEqual(await running, cancelled);
    assert.equal(await readFile(targetPath, "utf8"), "before old after");
    assert.deepEqual(setup.store.loadToolCall(setup.callId).result, cancelled);
  } finally {
    setup.connection.close();
  }
});

test("recovery versus allow returns the not-started recovery result and never replays the edit", async () => {
  const input = { path: "sample.txt", old_text: "old", new_text: "new" };
  const setup = await fixture("recovery-race", input);
  const targetPath = join(setup.workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  let entered!: () => void;
  const approvalEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const running = executeEditFile({
      callId: setup.callId,
      store: setup.store,
      permissionClient: {
        async requestPermission() {
          entered();
          await gate;
          return "allow_once";
        },
      },
      context: {
        workspace: setup.workspace,
        signal: new AbortController().signal,
        now: () => 700,
      },
    });
    await approvalEntered;
    assert.equal(setup.store.convergeInterruptedState().notStartedCallsInterrupted, 1);
    const recovered = setup.store.loadToolCall(setup.callId).result;
    release();

    assert.deepEqual(await running, recovered);
    assert.equal(await readFile(targetPath, "utf8"), "before old after");
    assert.equal(setup.store.loadToolCall(setup.callId).status, "interrupted");
  } finally {
    setup.connection.close();
  }
});

test("persists post-approval file changes as failure and running aborts as interrupted", async () => {
  for (const outcome of ["changed", "aborted"] as const) {
    const input = { path: "sample.txt", old_text: "old", new_text: "new" };
    const setup = await fixture(`running-${outcome}`, input);
    const targetPath = join(setup.workspacePath, "sample.txt");
    await writeFile(targetPath, "before old after", "utf8");
    const controller = new AbortController();
    try {
      const result = await executeEditFile({
        callId: setup.callId,
        store: setup.store,
        permissionClient: {
          async requestPermission() {
            if (outcome === "changed") {
              await writeFile(targetPath, "external old change", "utf8");
            }
            return "allow_once";
          },
        },
        context: {
          workspace: setup.workspace,
          signal: controller.signal,
          now: () => 800,
        },
        ...(outcome === "aborted" ? {
          applyOptions: {
            beforeOperation(operation: "create" | "write" | "sync" | "replace") {
              if (operation === "write") {
                controller.abort(new Error("cancelled while running"));
              }
            },
          },
        } : {}),
      });

      assert.equal(result.status, outcome === "changed" ? "failure" : "interrupted");
      assert.equal(result.metadata.error, outcome === "changed" ? "file_changed" : "cancelled");
      assert.equal(setup.store.loadToolCall(setup.callId).status, result.status);
      assert.deepEqual(setup.store.loadToolCall(setup.callId).result, result);
      assert.equal(await readFile(targetPath, "utf8"), outcome === "changed" ? "external old change" : "before old after");
    } finally {
      setup.connection.close();
    }
  }
});

test("a killed approved edit is recovered as interrupted after database reopen and is never replayed", async () => {
  const input = { path: "sample.txt", old_text: "old", new_text: "new" };
  const setup = await fixture("killed-child", input);
  const targetPath = join(setup.workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  setup.connection.close();
  const childFixture = join(import.meta.dirname, "..", "..", "test-fixtures", "approved-edit-running-child.ts");
  const child = spawnChildChannel(process.execPath, [
    childFixture,
    setup.dataRoot,
    setup.workspacePath,
    setup.callId,
  ], { env: cleanEnvironment() });
  try {
    assert.equal(await child.lines.nextLine(5_000), "RUNNING");
    await disposeChildChannel(child, "approved edit child", {
      gracefulTimeoutMs: 2_000,
      forceTimeoutMs: 2_000,
    });

    const reopened = await openDatabase({ env: { AWACODE_DATA_DIR: setup.dataRoot } });
    try {
      const store = new SessionStore(reopened.db);
      assert.equal(store.loadToolCall(setup.callId).status, "running");
      assert.deepEqual(recoverInterruptedState(store), {
        interruptedCount: 1,
        sessionsInterrupted: 0,
        messagesInterrupted: 0,
        notStartedCallsInterrupted: 0,
        outcomeUnknownCallsInterrupted: 1,
      });
      const recovered = store.loadToolCall(setup.callId);
      assert.equal(recovered.status, "interrupted");
      assert.deepEqual(recovered.result, {
        status: "interrupted",
        summary: "Tool execution was interrupted while running.",
        content: "The durable outcome is unknown; local side effects may have occurred. Inspect the workspace before retrying.",
        durationMs: 0,
        metadata: {
          recovery: "outcome_unknown",
          sideEffects: "may_have_occurred",
          retry: "inspect_workspace_first",
        },
      });
      assert.equal(await readFile(targetPath, "utf8"), "before old after");
      assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(setup.workspacePath)), ["sample.txt"]);
      assert.equal(recoverInterruptedState(store).interruptedCount, 0);
      assert.equal(await readFile(targetPath, "utf8"), "before old after");
    } finally {
      reopened.close();
    }
  } finally {
    await disposeChildChannel(child, "approved edit child fallback").catch(() => undefined);
  }
});
