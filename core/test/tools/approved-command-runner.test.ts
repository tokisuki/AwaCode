import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { openDatabase } from "../../src/persistence/database.ts";
import { SessionStore } from "../../src/persistence/session-store.ts";
import { RpcDisconnectedError } from "../../src/protocol/json-rpc.ts";
import type { ProjectIdentity } from "../../src/project/project-identity.ts";
import { WorkspaceGuard } from "../../src/security/workspace-guard.ts";
import {
  OUTCOME_UNKNOWN_RECOVERY_RESULT,
  recoverInterruptedState,
} from "../../src/session/recovery.ts";
import { transitionToolCall } from "../../src/session/tool-call-state.ts";
import {
  PermissionProtocolError,
  PermissionTimeoutError,
  type PermissionClient,
  type PermissionRequest,
} from "../../src/tools/permission.ts";
import type { CommandProcessAdapter } from "../../src/tools/command-process.ts";
import { executeRunCommand, runCommandTool } from "../../src/tools/run-command.ts";
import {
  disposeChildChannel,
  spawnChildChannel,
  waitForChildExit,
} from "../support/child-process.ts";

function identity(id: string, rootPath: string): ProjectIdentity {
  return {
    id,
    kind: "remote",
    value: "github.com/openai/awacode",
    remote: "github.com/openai/awacode",
    rootPath,
  };
}

function hostCommand(windows: string, posix: string): string {
  return process.platform === "win32" ? windows : posix;
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|OPENAI|ANTHROPIC|AZURE|AWS)/i.test(name)));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessGone(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`${label} ${pid} remained alive after cleanup`);
    }
    await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 20));
  }
}

async function fixture(label: string, input: unknown, persisted: { toolName?: string; inputText?: string } = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), `awacode-approved-command-${label}-data-`));
  const workspacePath = await mkdtemp(join(tmpdir(), `awacode-approved-command-${label}-workspace-`));
  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: dataRoot } });
  const ids = [`session-${label}`, `message-${label}`];
  const store = new SessionStore(connection.db, {
    now: () => new Date("2026-09-01T08:00:00.000Z"),
    randomUUID: () => ids.shift() as string,
  });
  store.upsertProject(identity(`project-${label}`, workspacePath));
  store.createSession(`project-${label}`, label);
  store.insertAssistantMessageWithToolCalls({
    sessionId: `session-${label}`,
    payload: { tool: "run_command" },
    toolCalls: [{
      callId: `call-${label}`,
      ordinal: 0,
      toolName: persisted.toolName ?? "run_command",
      inputText: persisted.inputText ?? JSON.stringify(input),
    }],
  });
  return {
    callId: `call-${label}`,
    connection,
    dataRoot,
    store,
    workspacePath,
    workspace: await WorkspaceGuard.create(workspacePath),
    async cleanup() {
      connection.close();
      await Promise.all([
        rm(dataRoot, { recursive: true, force: true }),
        rm(workspacePath, { recursive: true, force: true }),
      ]);
    },
  };
}

function hostProcessAdapter(onSpawn: () => void): CommandProcessAdapter {
  const systemRoot = process.env.SystemRoot?.trim();
  return {
    platform: process.platform,
    windowsPowerShellExecutable: systemRoot === undefined || systemRoot.length === 0
      ? "powershell.exe"
      : resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    spawn(executable, args, options) {
      onSpawn();
      return spawn(executable, [...args], options) as ReturnType<CommandProcessAdapter["spawn"]>;
    },
  };
}

test("binds approval and one real spawn to persisted command input and stores one exact result", async () => {
  const command = hostCommand(
    "[Console]::Out.Write('persisted-output')",
    "printf '%s' 'persisted-output'",
  );
  const persistedInput = { command, cwd: "nested", timeout_ms: 5_000 };
  const callerInput = { command: "exit 99", cwd: ".", timeout_ms: 1 };
  const setup = await fixture("allow", persistedInput);
  await mkdir(join(setup.workspacePath, "nested"));
  const requests: PermissionRequest[] = [];
  const permissionClient: PermissionClient = {
    async requestPermission(request) {
      requests.push(request);
      return "allow_once";
    },
  };
  const transitions: string[] = [];
  const compareAndSwap = setup.store.compareAndSwapToolCall.bind(setup.store);
  Object.defineProperty(setup.store, "compareAndSwapToolCall", {
    configurable: true,
    value: (value: Parameters<SessionStore["compareAndSwapToolCall"]>[0]) => {
      transitions.push(`${value.expectedStatus}->${value.status}`);
      return compareAndSwap(value);
    },
  });
  const times = [100, 109];
  const stdoutWrites: unknown[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    stdoutWrites.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await runCommandTool.execute(runCommandTool.validate(callerInput), {
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
      summary: "Command completed successfully.",
      content: "STDOUT:\npersisted-output\nSTDERR:\n(empty)",
      durationMs: 9,
      metadata: {
        cwd: "nested",
        timeoutMs: 5_000,
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        terminationFailed: false,
        terminationFailureCode: null,
        stdoutBytes: 16,
        stdoutRetainedBytes: 16,
        stdoutOmittedBytes: 0,
        stdoutDisplayedBytes: 16,
        stdoutTruncated: false,
        stderrBytes: 0,
        stderrRetainedBytes: 0,
        stderrOmittedBytes: 0,
        stderrDisplayedBytes: 0,
        stderrTruncated: false,
      },
    });
    assert.deepEqual(transitions, [
      "pending->awaiting_approval",
      "awaiting_approval->running",
      "running->success",
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "command");
    if (requests[0]?.kind === "command") {
      assert.equal(requests[0].preview.command, command);
      assert.equal(requests[0].preview.cwd, "nested");
      assert.equal(requests[0].preview.timeoutMs, 5_000);
    }
    assert.deepEqual(setup.store.loadToolCall(setup.callId).result, result);
  } finally {
    process.stdout.write = originalStdoutWrite;
    await setup.cleanup();
  }
  assert.deepEqual(stdoutWrites, []);
});

test("stripped environment values never enter approval, output, diagnostics, or SQLite", async () => {
  const command = hostCommand(
    "[Console]::Out.Write($env:SAFE_VALUE + '|' + $env:AWACODE_API_KEY + '|' + $env:OPENAI_API_KEY + '|' + $env:NPM_TOKEN + '|' + $env:AWS_SECRET_ACCESS_KEY + '|' + $env:accessToken + '|' + $env:clientSecret + '|' + $env:PGPASSWORD + '|' + $env:DATABASE_PASSWORD + '|' + $env:apiKey + '|' + $env:AWS_ACCESS_KEY_ID + '|' + $env:privateKey)",
    "printf '%s' \"$SAFE_VALUE|$AWACODE_API_KEY|$OPENAI_API_KEY|$NPM_TOKEN|$AWS_SECRET_ACCESS_KEY|$accessToken|$clientSecret|$PGPASSWORD|$DATABASE_PASSWORD|$apiKey|$AWS_ACCESS_KEY_ID|$privateKey\"",
  );
  const setup = await fixture("secret-persistence", { command });
  const secrets = [
    "never-awacode-value",
    "never-openai-value",
    "never-npm-value",
    "never-aws-value",
    "never-access-value",
    "never-client-value",
    "never-pg-password-value",
    "never-database-password-value",
    "never-camel-api-key-value",
    "never-aws-access-key-value",
    "never-private-key-value",
  ];
  const requests: PermissionRequest[] = [];
  try {
    const result = await executeRunCommand({
      callId: setup.callId,
      store: setup.store,
      permissionClient: {
        async requestPermission(request) {
          requests.push(request);
          return "allow_once";
        },
      },
      context: {
        workspace: setup.workspace,
        signal: new AbortController().signal,
        now: () => 150,
      },
      environment: {
        ...process.env,
        SAFE_VALUE: "visible",
        AWACODE_API_KEY: secrets[0],
        OPENAI_API_KEY: secrets[1],
        NPM_TOKEN: secrets[2],
        AWS_SECRET_ACCESS_KEY: secrets[3],
        accessToken: secrets[4],
        clientSecret: secrets[5],
        PGPASSWORD: secrets[6],
        DATABASE_PASSWORD: secrets[7],
        apiKey: secrets[8],
        AWS_ACCESS_KEY_ID: secrets[9],
        privateKey: secrets[10],
      },
    });
    assert.equal(result.status, "success");
    assert.equal(result.content, `STDOUT:\nvisible${"|".repeat(11)}\nSTDERR:\n(empty)`);
    const persistedRows = setup.connection.db.prepare(`
      SELECT input_text, result_json, error_text
      FROM tool_calls
      WHERE call_id = ?
    `).all(setup.callId);
    const exposed = JSON.stringify({ requests, result, persistedRows });
    for (const secret of secrets) {
      assert.doesNotMatch(exposed, new RegExp(secret));
    }
  } finally {
    await setup.cleanup();
  }
});

test("persists diagnostic nonzero, sanitized spawn failure, and external-signal results", async () => {
  for (const outcome of ["nonzero", "spawn-failure", "external-signal"] as const) {
    const command = outcome === "nonzero"
      ? hostCommand(
        "[Console]::Out.Write('before-exit'); [Console]::Error.Write('failure-detail'); exit 7",
        "printf '%s' 'before-exit'; printf '%s' 'failure-detail' >&2; exit 7",
      )
      : outcome === "external-signal"
        ? hostCommand(
          "Start-Sleep -Seconds 120",
          `exec '${process.execPath.replaceAll("'", "'\\''")}' -e 'setInterval(() => {}, 1_000)'`,
        )
        : "echo never";
    const setup = await fixture(`result-${outcome}`, { command });
    let spawnCalls = 0;
    const processAdapter = outcome === "spawn-failure"
      ? {
        platform: "win32" as const,
        windowsPowerShellExecutable: "C:\\outside\\missing.exe",
        spawn(): never {
          spawnCalls += 1;
          throw new Error("C:\\outside\\missing.exe TOKEN=never-spawn-secret");
        },
      }
      : hostProcessAdapter(() => { spawnCalls += 1; });
    if (outcome === "external-signal") {
      const originalSpawn = processAdapter.spawn.bind(processAdapter);
      processAdapter.spawn = ((executable, args, options) => {
        const child = originalSpawn(executable, args, options);
        child.once("spawn", () => setImmediate(() => child.kill("SIGTERM")));
        return child;
      }) as typeof processAdapter.spawn;
    }
    try {
      const result = await executeRunCommand({
        callId: setup.callId,
        store: setup.store,
        permissionClient: { async requestPermission() { return "allow_once"; } },
        context: {
          workspace: setup.workspace,
          signal: new AbortController().signal,
          now: () => 175,
        },
        processAdapter,
      });
      assert.equal(result.status, "failure", outcome);
      assert.equal(spawnCalls, 1, outcome);
      if (outcome === "nonzero") {
        assert.equal(result.metadata.exitCode, 7);
        assert.match(result.content, /before-exit/);
        assert.match(result.content, /failure-detail/);
      } else if (outcome === "spawn-failure") {
        assert.equal(result.summary, "Unable to start command.");
        assert.equal(result.metadata.exitCode, null);
        assert.doesNotMatch(JSON.stringify(result), /outside|never-spawn-secret|TOKEN/i);
      } else {
        assert.equal(result.summary, "Command was terminated by an external signal.");
        assert.equal(result.metadata.signal, "SIGTERM");
        assert.equal(result.metadata.exitCode, null);
      }
      assert.deepEqual(setup.store.loadToolCall(setup.callId).result, result);
    } finally {
      await setup.cleanup();
    }
  }
});

test("deny and every approval interruption persist no-spawn command terminals", async () => {
  for (const [label, decision, expectedStatus, expectedError] of [
    ["deny", "deny", "denied", undefined],
    ["timeout", new PermissionTimeoutError(), "interrupted", "approval_timeout"],
    ["disconnect", new RpcDisconnectedError(), "interrupted", "approval_disconnected"],
    ["protocol", new PermissionProtocolError(), "interrupted", "approval_protocol_failure"],
    ["cancel", new Error("cancel approval"), "interrupted", "approval_cancelled"],
  ] as const) {
    const setup = await fixture(`approval-${label}`, { command: "echo never-run" });
    const controller = new AbortController();
    let spawnCalls = 0;
    const processAdapter: CommandProcessAdapter = {
      platform: "win32",
      windowsPowerShellExecutable: "never-used.exe",
      spawn() {
        spawnCalls += 1;
        throw new Error("approval loser must not spawn");
      },
    };
    try {
      const result = await executeRunCommand({
        callId: setup.callId,
        store: setup.store,
        permissionClient: {
          async requestPermission() {
            if (decision === "deny") {
              return "deny";
            }
            if (label === "cancel") {
              controller.abort(decision);
            }
            throw decision;
          },
        },
        context: {
          workspace: setup.workspace,
          signal: controller.signal,
          now: () => 200,
        },
        processAdapter,
      });

      assert.equal(result.status, expectedStatus, label);
      assert.equal(result.metadata.sideEffects, "none", label);
      if (expectedError !== undefined) {
        assert.equal(result.metadata.error, expectedError, label);
      }
      assert.equal(spawnCalls, 0, label);
      assert.equal(setup.store.loadToolCall(setup.callId).status, expectedStatus, label);
      assert.deepEqual(setup.store.loadToolCall(setup.callId).result, result, label);
    } finally {
      await setup.cleanup();
    }
  }
});

test("persisted command binding failures finish from pending without approval or spawn", async () => {
  for (const [label, persisted, expectedError] of [
    ["tool-mismatch", { toolName: "edit_file", inputText: JSON.stringify({ command: "echo never" }) }, "persisted_tool_mismatch"],
    ["malformed-input", { inputText: "{not-json" }, "persisted_input_malformed"],
    ["invalid-input", { inputText: JSON.stringify({ command: " " }) }, "invalid_tool_input"],
  ] as const) {
    const setup = await fixture(`binding-${label}`, { command: "echo caller" }, persisted);
    let approvals = 0;
    let spawnCalls = 0;
    try {
      const result = await executeRunCommand({
        callId: setup.callId,
        store: setup.store,
        permissionClient: {
          async requestPermission() {
            approvals += 1;
            return "allow_once";
          },
        },
        context: {
          workspace: setup.workspace,
          signal: new AbortController().signal,
          now: () => 300,
        },
        processAdapter: {
          platform: "win32",
          windowsPowerShellExecutable: "never-used.exe",
          spawn() {
            spawnCalls += 1;
            throw new Error("binding failure must not spawn");
          },
        },
      });
      assert.equal(result.status, "failure", label);
      assert.equal(result.metadata.error, expectedError, label);
      assert.equal(approvals, 0, label);
      assert.equal(spawnCalls, 0, label);
      assert.deepEqual(setup.store.loadToolCall(setup.callId).result, result, label);
    } finally {
      await setup.cleanup();
    }
  }
});

test("a duplicate approved-command runner observes the winner result and spawns exactly once", async () => {
  const command = hostCommand("[Console]::Out.Write('race-output')", "printf '%s' 'race-output'");
  const setup = await fixture("duplicate", { command });
  let entered!: () => void;
  const approvalEntered = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  let release!: () => void;
  const approvalGate = new Promise<void>((resolveGate) => { release = resolveGate; });
  let approvals = 0;
  let spawnCalls = 0;
  const permissionClient: PermissionClient = {
    async requestPermission() {
      approvals += 1;
      entered();
      await approvalGate;
      return "allow_once";
    },
  };
  const execute = () => executeRunCommand({
    callId: setup.callId,
    store: setup.store,
    permissionClient,
    context: {
      workspace: setup.workspace,
      signal: new AbortController().signal,
      now: () => 400,
    },
    processAdapter: hostProcessAdapter(() => { spawnCalls += 1; }),
  });
  try {
    const winner = execute();
    await approvalEntered;
    const loser = execute();
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    assert.equal(approvals, 1);
    assert.equal(spawnCalls, 0);
    release();
    const [winnerResult, loserResult] = await Promise.all([winner, loser]);
    assert.deepEqual(loserResult, winnerResult);
    assert.equal(winnerResult.status, "success");
    assert.equal(approvals, 1);
    assert.equal(spawnCalls, 1);
    assert.deepEqual(setup.store.loadToolCall(setup.callId).result, winnerResult);
  } finally {
    release();
    await setup.cleanup();
  }
});

test("cancel and startup recovery CAS winners prevent a late allow from spawning", async () => {
  for (const race of ["cancel", "recovery"] as const) {
    const setup = await fixture(`${race}-race`, { command: "echo never-runs" });
    let entered!: () => void;
    const approvalEntered = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
    let release!: () => void;
    const approvalGate = new Promise<void>((resolveGate) => { release = resolveGate; });
    let spawnCalls = 0;
    try {
      const running = executeRunCommand({
        callId: setup.callId,
        store: setup.store,
        permissionClient: {
          async requestPermission() {
            entered();
            await approvalGate;
            return "allow_once";
          },
        },
        context: {
          workspace: setup.workspace,
          signal: new AbortController().signal,
          now: () => 500,
        },
        processAdapter: {
          platform: "win32",
          windowsPowerShellExecutable: "never-used.exe",
          spawn() {
            spawnCalls += 1;
            throw new Error("CAS loser must not spawn");
          },
        },
      });
      await approvalEntered;
      if (race === "cancel") {
        assert.equal(transitionToolCall(setup.store, {
          callId: setup.callId,
          expectedStatus: "awaiting_approval",
          status: "interrupted",
          result: {
            status: "interrupted",
            summary: "Cancelled by competing path.",
            content: "The command did not start.",
            durationMs: 0,
            metadata: { source: "cancel", sideEffects: "none" },
          },
        }).kind, "applied");
      } else {
        assert.equal(setup.store.convergeInterruptedState().notStartedCallsInterrupted, 1);
      }
      const durable = setup.store.loadToolCall(setup.callId).result;
      release();
      assert.deepEqual(await running, durable, race);
      assert.equal(spawnCalls, 0, race);
      assert.equal(setup.store.loadToolCall(setup.callId).status, "interrupted", race);
    } finally {
      release();
      await setup.cleanup();
    }
  }
});

test("a killed approved command is recovered after database reopen and never replayed", async () => {
  const command = hostCommand(
    "Start-Sleep -Seconds 120",
    `exec '${process.execPath.replaceAll("'", "'\\''")}' -e 'setInterval(() => {}, 1_000)'`,
  );
  const setup = await fixture("killed-child", { command, timeout_ms: 180_000 });
  setup.connection.close();
  const childFixture = join(import.meta.dirname, "..", "..", "test-fixtures", "approved-command-running-child.ts");
  const child = spawnChildChannel(process.execPath, [
    childFixture,
    setup.dataRoot,
    setup.workspacePath,
    setup.callId,
  ], { env: cleanEnvironment() });
  let commandPid: number | undefined;
  try {
    const handshake = await child.lines.nextLine(5_000);
    assert.match(handshake, /^RUNNING:\d+$/);
    commandPid = Number(handshake.slice("RUNNING:".length));
    assert.equal(child.child.kill("SIGKILL"), true);
    const [code, signal] = await waitForChildExit(child, 5_000, "approved command child termination");
    assert.ok(code !== 0 || signal !== null);

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
      assert.deepEqual(recovered.result, OUTCOME_UNKNOWN_RECOVERY_RESULT);
      assert.equal(recoverInterruptedState(store).interruptedCount, 0);
      let replaySpawns = 0;
      assert.deepEqual(await executeRunCommand({
        callId: setup.callId,
        store,
        permissionClient: {
          async requestPermission() {
            throw new Error("recovered call must not request approval");
          },
        },
        context: {
          workspace: setup.workspace,
          signal: new AbortController().signal,
          now: () => 600,
        },
        processAdapter: {
          platform: "win32",
          windowsPowerShellExecutable: "never-used.exe",
          spawn() {
            replaySpawns += 1;
            throw new Error("recovered call must not replay");
          },
        },
      }), recovered.result);
      assert.equal(replaySpawns, 0);
      assert.equal(store.loadSession(`session-killed-child`).toolCalls.length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    if (commandPid !== undefined) {
      if (isProcessAlive(commandPid)) {
        try {
          process.kill(commandPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      }
      await waitForProcessGone(commandPid, "approved command process");
    }
    await disposeChildChannel(child, "approved command child fallback").catch(() => undefined);
    await Promise.all([
      rm(setup.dataRoot, { recursive: true, force: true }),
      rm(setup.workspacePath, { recursive: true, force: true }),
    ]);
  }
});
