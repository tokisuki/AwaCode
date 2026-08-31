import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type OpenedWorkspaceDirectory,
  type OpenedWorkspaceFile,
  WorkspaceGuard,
} from "../../src/security/workspace-guard.ts";
import type { ToolContext, ToolResult } from "../../src/tools/contracts.ts";
import { listFilesTool } from "../../src/tools/list-files.ts";
import { readFileTool } from "../../src/tools/read-file.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-isolation-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function context(workspace: WorkspaceGuard, signal = new AbortController().signal): ToolContext {
  let now = 0;
  return { workspace, signal, now: () => now++ };
}

function capturingWrite(chunks: string[]): typeof process.stdout.write {
  return ((chunk: string | Uint8Array, ...args: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const callback = args.findLast((argument) => typeof argument === "function");
    if (typeof callback === "function") {
      callback();
    }
    return true;
  }) as typeof process.stdout.write;
}

async function captureProcessWrites<T>(operation: () => Promise<T>): Promise<{
  result: T;
  stderr: string[];
  stdout: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = capturingWrite(stdout);
  process.stderr.write = capturingWrite(stderr);
  try {
    return { result: await operation(), stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("list_files writes no stdout or stderr for success, failure, or interruption", async () => {
  const workspacePath = await temporaryDirectory("list-output");
  await writeFile(join(workspacePath, "file.txt"), "text", "utf8");
  const workspace = await WorkspaceGuard.create(workspacePath);
  const controller = new AbortController();
  controller.abort();

  const captured = await captureProcessWrites(async () => Promise.all([
    listFilesTool.execute(listFilesTool.validate({}), context(workspace)),
    listFilesTool.execute(listFilesTool.validate({ path: "missing" }), context(workspace)),
    listFilesTool.execute(listFilesTool.validate({}), context(workspace, controller.signal)),
  ]));

  assert.deepEqual(captured.result.map((result) => result.status), ["success", "failure", "interrupted"]);
  assert.deepEqual(captured.stdout, []);
  assert.deepEqual(captured.stderr, []);
});

test("read_file writes no stdout or stderr for success, failure, or interruption", async () => {
  const workspacePath = await temporaryDirectory("read-output");
  await writeFile(join(workspacePath, "file.txt"), "text", "utf8");
  const workspace = await WorkspaceGuard.create(workspacePath);
  const controller = new AbortController();
  controller.abort();

  const captured = await captureProcessWrites(async () => Promise.all([
    readFileTool.execute(readFileTool.validate({ path: "file.txt" }), context(workspace)),
    readFileTool.execute(readFileTool.validate({ path: "." }), context(workspace)),
    readFileTool.execute(readFileTool.validate({ path: "file.txt" }), context(workspace, controller.signal)),
  ]));

  assert.deepEqual(captured.result.map((result) => result.status), ["success", "failure", "interrupted"]);
  assert.deepEqual(captured.stdout, []);
  assert.deepEqual(captured.stderr, []);
});

test("read_file closes retained file handles after success and decoding failure", async () => {
  const workspacePath = await temporaryDirectory("file-handles");
  await writeFile(join(workspacePath, "text.txt"), "text", "utf8");
  await writeFile(join(workspacePath, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
  const workspace = await WorkspaceGuard.create(workspacePath);
  const openFile = workspace.openFile.bind(workspace);
  const openedFiles: OpenedWorkspaceFile[] = [];
  Object.defineProperty(workspace, "openFile", {
    configurable: true,
    value: async (...args: Parameters<WorkspaceGuard["openFile"]>) => {
      const opened = await openFile(...args);
      openedFiles.push(opened);
      return opened;
    },
  });

  const results: ToolResult[] = [];
  results.push(await readFileTool.execute(readFileTool.validate({ path: "text.txt" }), context(workspace)));
  results.push(await readFileTool.execute(readFileTool.validate({ path: "binary.bin" }), context(workspace)));

  assert.deepEqual(results.map((result) => result.status), ["success", "failure"]);
  assert.equal(openedFiles.length, 2);
  for (const opened of openedFiles) {
    await assert.rejects(opened.handle.stat(), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "EBADF");
      return true;
    });
  }
});

test("list_files closes retained directory and identity handles after traversal", async () => {
  const workspacePath = await temporaryDirectory("directory-handles");
  await mkdir(join(workspacePath, "nested"));
  await writeFile(join(workspacePath, "nested", "file.txt"), "text", "utf8");
  const workspace = await WorkspaceGuard.create(workspacePath);
  const openListingDirectory = workspace.openListingDirectory.bind(workspace);
  const openedDirectories: OpenedWorkspaceDirectory[] = [];
  Object.defineProperty(workspace, "openListingDirectory", {
    configurable: true,
    value: async (...args: Parameters<WorkspaceGuard["openListingDirectory"]>) => {
      const opened = await openListingDirectory(...args);
      openedDirectories.push(opened);
      return opened;
    },
  });

  const result = await listFilesTool.execute(listFilesTool.validate({}), context(workspace));

  assert.equal(result.status, "success");
  assert.equal(openedDirectories.length, 2);
  for (const opened of openedDirectories) {
    await assert.rejects(opened.identityHandle.stat(), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "EBADF");
      return true;
    });
    await assert.rejects(opened.directory.read(), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ERR_DIR_CLOSED");
      return true;
    });
  }
});
