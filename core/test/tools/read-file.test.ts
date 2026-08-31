import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceGuard } from "../../src/security/workspace-guard.ts";
import { ToolValidationError, type ToolContext } from "../../src/tools/contracts.ts";
import { readFileTool } from "../../src/tools/read-file.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-read-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function toolContext(workspacePath: string, signal = new AbortController().signal): Promise<ToolContext> {
  const times = [200, 209];
  return {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal,
    now: () => times.shift() ?? 209,
  };
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("validates exact read_file inputs and applies documented paging defaults", () => {
  assert.equal(readFileTool.name, "read_file");
  assert.equal(readFileTool.approval, "none");
  assert.deepEqual(readFileTool.validate({ path: "src/main.ts" }), {
    path: "src/main.ts",
    offsetLine: 1,
    limitLines: 200,
  });
  assert.deepEqual(readFileTool.validate({ path: "a", offset_line: 2, limit_lines: 2_000 }), {
    path: "a",
    offsetLine: 2,
    limitLines: 2_000,
  });

  const inherited = Object.create({ path: "file" }) as Record<string, unknown>;
  for (const invalid of [
    null,
    [],
    inherited,
    {},
    { path: "" },
    { path: "   " },
    { path: 1 },
    { path: "file", extra: true },
    { path: "file", offset_line: undefined },
    { path: "file", offset_line: 0 },
    { path: "file", offset_line: 1.5 },
    { path: "file", limit_lines: 0 },
    { path: "file", limit_lines: undefined },
    { path: "file", limit_lines: 2_001 },
    { path: "file", limit_lines: 1.5 },
  ]) {
    assert.throws(() => readFileTool.validate(invalid), ToolValidationError);
  }
});

test("numbers logical lines, treats CRLF once, preserves Chinese, and reports paging metadata", async () => {
  const workspace = await temporaryDirectory("lines");
  const source = "alpha\r\n中文\r\nthird";
  await writeFile(join(workspace, "lines.txt"), source, "utf8");

  const all = await readFileTool.execute(readFileTool.validate({ path: "lines.txt" }), await toolContext(workspace));
  assert.deepEqual(all, {
    status: "success",
    summary: "Read 3 lines from the workspace file.",
    content: "1: alpha\n2: 中文\n3: third",
    durationMs: 9,
    metadata: {
      path: "lines.txt",
      offsetLine: 1,
      limitLines: 200,
      linesReturned: 3,
      totalLines: 3,
      hasMore: false,
      contentTruncated: false,
      originalBytes: Buffer.byteLength(source),
    },
  });

  const page = await readFileTool.execute(
    readFileTool.validate({ path: "lines.txt", offset_line: 2, limit_lines: 1 }),
    await toolContext(workspace),
  );
  assert.equal(page.content, "2: 中文");
  assert.equal(page.metadata.linesReturned, 1);
  assert.equal(page.metadata.totalLines, 3);
  assert.equal(page.metadata.hasMore, true);
});

test("handles final lines without newline, newline-ended files, empty files, and offsets beyond EOF", async () => {
  const workspace = await temporaryDirectory("boundaries");
  await writeFile(join(workspace, "final.txt"), "one\ntwo", "utf8");
  await writeFile(join(workspace, "ended.txt"), "one\n", "utf8");
  await writeFile(join(workspace, "empty.txt"), "", "utf8");
  await writeFile(join(workspace, "carriage.txt"), "a\rb", "utf8");
  await writeFile(join(workspace, "bom.txt"), "\uFEFFfirst", "utf8");

  const final = await readFileTool.execute(readFileTool.validate({ path: "final.txt" }), await toolContext(workspace));
  assert.equal(final.content, "1: one\n2: two");
  assert.equal(final.metadata.totalLines, 2);

  const ended = await readFileTool.execute(readFileTool.validate({ path: "ended.txt" }), await toolContext(workspace));
  assert.equal(ended.content, "1: one");
  assert.equal(ended.metadata.totalLines, 1);

  const empty = await readFileTool.execute(readFileTool.validate({ path: "empty.txt" }), await toolContext(workspace));
  assert.equal(empty.content, "");
  assert.equal(empty.metadata.linesReturned, 0);
  assert.equal(empty.metadata.totalLines, 0);

  const beyond = await readFileTool.execute(
    readFileTool.validate({ path: "final.txt", offset_line: 20 }),
    await toolContext(workspace),
  );
  assert.equal(beyond.content, "");
  assert.equal(beyond.metadata.linesReturned, 0);
  assert.equal(beyond.metadata.hasMore, false);

  const carriage = await readFileTool.execute(readFileTool.validate({ path: "carriage.txt" }), await toolContext(workspace));
  assert.equal(carriage.content, "1: a\rb");
  assert.equal(carriage.metadata.totalLines, 1);

  const bom = await readFileTool.execute(readFileTool.validate({ path: "bom.txt" }), await toolContext(workspace));
  assert.equal(bom.content, "1: \uFEFFfirst");
});

test("caps a long logical line at 50 KiB without splitting Chinese UTF-8", async () => {
  const workspace = await temporaryDirectory("long-line");
  const source = "中".repeat(30_000);
  await writeFile(join(workspace, "long.txt"), source, "utf8");

  const result = await readFileTool.execute(
    readFileTool.validate({ path: "long.txt", limit_lines: 1 }),
    await toolContext(workspace),
  );
  assert.equal(result.status, "success");
  assert.equal(result.metadata.linesReturned, 1);
  assert.equal(result.metadata.totalLines, 1);
  assert.equal(result.metadata.contentTruncated, true);
  assert.equal(result.metadata.originalBytes, Buffer.byteLength(source));
  assert.ok(Buffer.byteLength(result.content) <= 50 * 1024);
  assert.match(result.content, /^1: (?:中)+\n\[truncated: \d+ bytes omitted\]$/);
  assert.doesNotMatch(result.content, /�/);
});

test("rejects NUL and malformed UTF-8 as binary or unsupported input", async () => {
  const workspace = await temporaryDirectory("binary");
  await writeFile(join(workspace, "nul.bin"), Buffer.from([0x61, 0x00, 0x62]));
  await writeFile(join(workspace, "invalid.bin"), Buffer.from([0x61, 0xc3, 0x28]));

  for (const path of ["nul.bin", "invalid.bin"]) {
    const result = await readFileTool.execute(readFileTool.validate({ path }), await toolContext(workspace));
    assert.deepEqual(result, {
      status: "failure",
      summary: "Unable to read workspace file.",
      content: "File is binary or is not valid UTF-8.",
      durationMs: 9,
      metadata: { path, offsetLine: 1, limitLines: 200, error: "unsupported_encoding" },
    });
  }
});

test("converts abort, directory, and escaping paths into stable non-throwing results", async () => {
  const workspace = await temporaryDirectory("results");
  await writeFile(join(workspace, "started.txt"), "content", "utf8");
  const controller = new AbortController();
  const interruptedPromise = readFileTool.execute(
    readFileTool.validate({ path: "started.txt" }),
    await toolContext(workspace, controller.signal),
  );
  controller.abort();
  const interrupted = await interruptedPromise;
  assert.deepEqual(interrupted, {
    status: "interrupted",
    summary: "File read interrupted.",
    content: "The file read was interrupted.",
    durationMs: 9,
    metadata: { path: "started.txt", offsetLine: 1, limitLines: 200 },
  });

  for (const [path, errorCode, message] of [
    [".", "not_file", "Path is not a regular file."],
    ["../outside-private-name", "invalid_path", "Path must be a safe relative workspace path."],
  ] as const) {
    const result = await readFileTool.execute(readFileTool.validate({ path }), await toolContext(workspace));
    assert.deepEqual(result, {
      status: "failure",
      summary: "Unable to read workspace file.",
      content: message,
      durationMs: 9,
      metadata: { path, offsetLine: 1, limitLines: 200, error: errorCode },
    });
    assert.doesNotMatch(JSON.stringify(result), /awacode-read|stack/i);
  }
});

test("never reads outside bytes when an ancestor becomes a junction after resolution", async (context) => {
  const parent = await temporaryDirectory("ancestor-swap");
  const workspacePath = join(parent, "workspace");
  const insideDirectory = join(workspacePath, "safe");
  const outsideDirectory = join(parent, "outside");
  await mkdir(insideDirectory, { recursive: true });
  await mkdir(outsideDirectory);
  await writeFile(join(insideDirectory, "data.txt"), "INSIDE", "utf8");
  await writeFile(join(outsideDirectory, "data.txt"), "OUTSIDE-SECRET", "utf8");

  const workspace = await WorkspaceGuard.create(workspacePath);
  const resolveFile = workspace.resolveFile.bind(workspace);
  let swapped = false;
  Object.defineProperty(workspace, "resolveFile", {
    configurable: true,
    value: async (path: string) => {
      const resolved = await resolveFile(path);
      if (!swapped) {
        await rename(insideDirectory, join(workspacePath, "safe-original"));
        try {
          await symlink(outsideDirectory, insideDirectory, "junction");
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : "unknown";
          if (["EACCES", "EPERM", "UNKNOWN"].includes(code)) {
            context.skip(`directory links unavailable: ${code}`);
            return resolved;
          }
          throw error;
        }
        swapped = true;
      }
      return resolved;
    },
  });
  const times = [300, 311];
  let barrierObserved = false;
  const toolContextWithBarrier: ToolContext = {
    workspace,
    signal: new AbortController().signal,
    now: () => times.shift() ?? 311,
    accessBarrier: async (event) => {
      barrierObserved = true;
      assert.deepEqual(event, { kind: "file_resolved", path: "safe/data.txt" });
    },
  };

  const result = await readFileTool.execute(
    readFileTool.validate({ path: "safe/data.txt" }),
    toolContextWithBarrier,
  );

  assert.equal(swapped, true);
  assert.equal(barrierObserved, true);
  assert.equal(result.status, "failure");
  assert.doesNotMatch(JSON.stringify(result), /OUTSIDE-SECRET|awacode-read-ancestor-swap/i);
});

test("rejects an opened outside file when the lexical path is restored before post-open validation", async (context) => {
  const parent = await temporaryDirectory("identity-swap");
  const workspacePath = join(parent, "workspace");
  const insideDirectory = join(workspacePath, "safe");
  const savedInsideDirectory = join(workspacePath, "safe-original");
  const outsideDirectory = join(parent, "outside");
  await mkdir(insideDirectory, { recursive: true });
  await mkdir(outsideDirectory);
  await writeFile(join(insideDirectory, "data.txt"), "INSIDE", "utf8");
  await writeFile(join(outsideDirectory, "data.txt"), "OUTSIDE-SECRET", "utf8");

  const observedEvents: string[] = [];
  const times = [500, 517];
  const toolContextWithBarrier: ToolContext = {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: new AbortController().signal,
    now: () => times.shift() ?? 517,
    accessBarrier: async (event) => {
      observedEvents.push(event.kind);
      if (event.kind === "file_resolved") {
        await rename(insideDirectory, savedInsideDirectory);
        try {
          await symlink(outsideDirectory, insideDirectory, "junction");
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : "unknown";
          if (["EACCES", "EPERM", "UNKNOWN"].includes(code)) {
            context.skip(`directory links unavailable: ${code}`);
            return;
          }
          throw error;
        }
      } else if (event.kind === "file_opened") {
        await unlink(insideDirectory);
        await rename(savedInsideDirectory, insideDirectory);
      }
    },
  };

  const result = await readFileTool.execute(
    readFileTool.validate({ path: "safe/data.txt" }),
    toolContextWithBarrier,
  );

  assert.equal(result.status, "failure");
  assert.equal(result.metadata.error, "path_changed");
  assert.deepEqual(observedEvents, ["file_resolved", "file_opened"]);
  assert.doesNotMatch(JSON.stringify(result), /OUTSIDE-SECRET|awacode-read-identity-swap/i);
});
