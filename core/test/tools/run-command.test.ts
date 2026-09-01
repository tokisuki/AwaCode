import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceGuard, WorkspaceGuardError } from "../../src/security/workspace-guard.ts";
import { ToolExecutionError, ToolValidationError } from "../../src/tools/contracts.ts";
import {
  CommandExecutionError,
  executePreparedRunCommand,
  MAX_COMMAND_BYTES,
  prepareRunCommand,
  runCommandTool,
  validateRunCommandInput,
} from "../../src/tools/run-command.ts";
import type { CommandProcessAdapter } from "../../src/tools/command-process.ts";

test("validates the exact run_command DTO with byte and timeout bounds", () => {
  const source = { command: "  Write-Output '中文'  " };
  const validated = validateRunCommandInput(source);
  assert.notEqual(validated, source);
  assert.deepEqual(validated, {
    command: "  Write-Output '中文'  ",
    cwd: ".",
    timeoutMs: 60_000,
  });
  assert.deepEqual(validateRunCommandInput({
    command: "echo ok",
    cwd: "nested",
    timeout_ms: 180_000,
  }), {
    command: "echo ok",
    cwd: "nested",
    timeoutMs: 180_000,
  });
  assert.equal(MAX_COMMAND_BYTES, 16 * 1024);
  assert.equal(Buffer.byteLength("中".repeat(5_461) + "a"), MAX_COMMAND_BYTES);
  assert.equal(validateRunCommandInput({ command: "中".repeat(5_461) + "a" }).command.length, 5_462);

  const inherited = Object.create({ command: "echo inherited" }) as Record<string, unknown>;
  const symbol = { command: "echo symbol" } as Record<PropertyKey, unknown>;
  symbol[Symbol("extra")] = true;
  const nonEnumerable = { command: "echo hidden" };
  Object.defineProperty(nonEnumerable, "cwd", { value: ".", enumerable: false });
  const accessor = { command: "echo accessor" };
  Object.defineProperty(accessor, "cwd", { get: () => ".", enumerable: true });
  for (const invalid of [
    null,
    [],
    inherited,
    symbol,
    nonEnumerable,
    accessor,
    {},
    { command: undefined },
    { command: 1 },
    { command: "" },
    { command: "   \t" },
    { command: "echo\0bad" },
    { command: "a".repeat(MAX_COMMAND_BYTES + 1) },
    { command: "echo ok", extra: true },
    { command: "echo ok", cwd: undefined },
    { command: "echo ok", cwd: "" },
    { command: "echo ok", cwd: 1 },
    { command: "echo ok", timeout_ms: undefined },
    { command: "echo ok", timeout_ms: 0 },
    { command: "echo ok", timeout_ms: 1.5 },
    { command: "echo ok", timeout_ms: 180_001 },
    { command: "echo ok", timeout_ms: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => validateRunCommandInput(invalid), ToolValidationError);
  }
});

test("prepares root and nested cwd identity with a complete Core-owned command preview", async (context) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "awacode-command-prepare-"));
  context.after(() => rm(workspacePath, { recursive: true, force: true }));
  await mkdir(join(workspacePath, "nested", "child"), { recursive: true });
  const workspace = await WorkspaceGuard.create(workspacePath);
  const command = `Write-Output '${"中".repeat(2_000)}'`;

  for (const [cwd, expectedCwd] of [[".", "."], ["nested\\child", "nested/child"]] as const) {
    const prepared = await prepareRunCommand(
      validateRunCommandInput({ command, cwd, timeout_ms: 12_345 }),
      { workspace, signal: new AbortController().signal, now: () => 0 },
    );
    assert.equal(prepared.cwd, expectedCwd);
    assert.ok(prepared.identity.dev !== 0n);
    assert.ok(prepared.identity.ino !== 0n);
    assert.equal(prepared.input.command, command);
    assert.deepEqual(prepared.permission, {
      kind: "command",
      title: "Run shell command",
      preview: {
        command,
        cwd: expectedCwd,
        timeoutMs: 12_345,
        warning: "This command runs with current-user permissions and may access paths outside the workspace.",
      },
    });
    assert.doesNotMatch(JSON.stringify(prepared.permission), new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("rejects unsafe, missing, and non-directory cwd values before approval", async (context) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "awacode-command-cwd-invalid-"));
  context.after(() => rm(workspacePath, { recursive: true, force: true }));
  await writeFile(join(workspacePath, "file.txt"), "not a directory", "utf8");
  const workspace = await WorkspaceGuard.create(workspacePath);
  const toolContext = { workspace, signal: new AbortController().signal, now: () => 0 };

  for (const [cwd, code] of [
    [join(workspacePath, "absolute"), "invalid_path"],
    ["../outside", "invalid_path"],
    ["missing", "not_found"],
    ["file.txt", "not_directory"],
  ] as const) {
    await assert.rejects(
      prepareRunCommand(validateRunCommandInput({ command: "echo ok", cwd }), toolContext),
      (error: unknown) => error instanceof WorkspaceGuardError && error.code === code,
      cwd,
    );
  }
});

test("rejects a cwd link that escapes the physical workspace before approval", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "awacode-command-cwd-link-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const workspacePath = join(parent, "workspace");
  const outsidePath = join(parent, "outside");
  await Promise.all([mkdir(workspacePath), mkdir(outsidePath)]);
  try {
    await symlink(outsidePath, join(workspacePath, "escaping-directory"), "junction");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (["EACCES", "EPERM", "UNKNOWN"].includes(code)) {
      context.skip(`directory links unavailable: ${code}`);
      return;
    }
    throw error;
  }
  const workspace = await WorkspaceGuard.create(workspacePath);

  await assert.rejects(
    prepareRunCommand(
      validateRunCommandInput({ command: "echo never", cwd: "escaping-directory" }),
      { workspace, signal: new AbortController().signal, now: () => 0 },
    ),
    (error: unknown) => error instanceof WorkspaceGuardError && error.code === "outside_workspace",
  );
});

test("rejects cwd deletion or identity replacement after approval without spawning", async (context) => {
  for (const change of ["delete", "replace"] as const) {
    const workspacePath = await mkdtemp(join(tmpdir(), `awacode-command-cwd-${change}-`));
    context.after(() => rm(workspacePath, { recursive: true, force: true }));
    const cwdPath = join(workspacePath, "cwd");
    await mkdir(cwdPath);
    const workspace = await WorkspaceGuard.create(workspacePath);
    const toolContext = { workspace, signal: new AbortController().signal, now: () => 0 };
    const prepared = await prepareRunCommand(
      validateRunCommandInput({ command: "echo not-run", cwd: "cwd" }),
      toolContext,
    );
    if (change === "delete") {
      await rm(cwdPath, { recursive: true });
    } else {
      await rename(cwdPath, join(workspacePath, "approved-cwd"));
      await mkdir(cwdPath);
    }
    let spawnCalls = 0;
    const processAdapter: CommandProcessAdapter = {
      platform: "win32",
      windowsPowerShellExecutable: "never-used.exe",
      spawn() {
        spawnCalls += 1;
        throw new Error("spawn must not occur for a changed cwd");
      },
    };

    await assert.rejects(
      executePreparedRunCommand(prepared, toolContext, { processAdapter }),
      (error: unknown) => error instanceof CommandExecutionError && error.code === "cwd_changed",
      change,
    );
    assert.equal(spawnCalls, 0, change);
  }
});

test("publishes the accurate command schema and requires the durable approved runtime", async (context) => {
  assert.equal(runCommandTool.name, "run_command");
  assert.equal(runCommandTool.approval, "command");
  assert.deepEqual(runCommandTool.inputSchema, {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_BYTES },
      cwd: { type: "string", minLength: 1 },
      timeout_ms: { type: "integer", minimum: 1, maximum: 180_000 },
    },
  });

  const workspacePath = await mkdtemp(join(tmpdir(), "awacode-command-contract-"));
  context.after(() => rm(workspacePath, { recursive: true, force: true }));
  const workspace = await WorkspaceGuard.create(workspacePath);
  const input = runCommandTool.validate({ command: "echo ok" });
  assert.throws(() => runCommandTool.execute(input, {
    workspace,
    signal: new AbortController().signal,
    now: () => 0,
  }), ToolExecutionError);
});
