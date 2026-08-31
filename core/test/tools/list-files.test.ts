import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceGuard } from "../../src/security/workspace-guard.ts";
import { ToolValidationError, type ToolContext } from "../../src/tools/contracts.ts";
import { listFilesTool } from "../../src/tools/list-files.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-list-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function fixture(): Promise<string> {
  const workspace = await temporaryDirectory("fixture");
  for (const directory of ["src/nested", ".git", "node_modules", "dist", "build", "src/build"]) {
    await mkdir(join(workspace, directory), { recursive: true });
  }
  for (const [path, content] of [
    ["z.txt", "z"],
    ["a.txt", "a"],
    ["src/b.ts", "b"],
    ["src/nested/c.ts", "c"],
    [".git/config", "ignored"],
    ["node_modules/package.js", "ignored"],
    ["dist/output.js", "ignored"],
    ["build/output.js", "ignored"],
    ["src/build/output.js", "ignored"],
  ] as const) {
    await writeFile(join(workspace, path), content, "utf8");
  }
  return workspace;
}

async function toolContext(workspacePath: string, signal = new AbortController().signal): Promise<ToolContext> {
  const times = [100, 107];
  return {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal,
    now: () => times.shift() ?? 107,
  };
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("validates exact list_files inputs and applies documented defaults and bounds", () => {
  assert.equal(listFilesTool.name, "list_files");
  assert.equal(listFilesTool.approval, "none");
  assert.deepEqual(listFilesTool.validate({}), { path: ".", maxDepth: 4 });
  assert.deepEqual(listFilesTool.validate({ path: "src", max_depth: 0 }), { path: "src", maxDepth: 0 });
  assert.deepEqual(listFilesTool.validate({ max_depth: 20 }), { path: ".", maxDepth: 20 });

  const inherited = Object.create({ path: "src" }) as Record<string, unknown>;
  for (const invalid of [
    null,
    [],
    inherited,
    { extra: true },
    { path: "" },
    { path: undefined },
    { path: 1 },
    { max_depth: undefined },
    { max_depth: -1 },
    { max_depth: 21 },
    { max_depth: 1.5 },
  ]) {
    assert.throws(() => listFilesTool.validate(invalid), ToolValidationError);
  }
});

test("lists sorted workspace-relative entries while ignoring generated directories at every depth", async () => {
  const workspace = await fixture();
  const result = await listFilesTool.execute(listFilesTool.validate({}), await toolContext(workspace));

  assert.deepEqual(result, {
    status: "success",
    summary: "Listed 6 workspace entries.",
    content: ["a.txt", "src/", "src/b.ts", "src/nested/", "src/nested/c.ts", "z.txt"].join("\n"),
    durationMs: 7,
    metadata: {
      path: ".",
      maxDepth: 4,
      entryCount: 6,
      ignoredCount: 5,
      unsafeSymlinkCount: 0,
      entryLimitTruncated: false,
      contentTruncated: false,
    },
  });
});

test("interprets depth relative to the requested directory and never descends at depth zero", async () => {
  const workspace = await fixture();
  const rootResult = await listFilesTool.execute(
    listFilesTool.validate({ max_depth: 0 }),
    await toolContext(workspace),
  );
  assert.equal(rootResult.content, ["a.txt", "src/", "z.txt"].join("\n"));
  assert.equal(rootResult.metadata.ignoredCount, 4);

  const nestedResult = await listFilesTool.execute(
    listFilesTool.validate({ path: "src", max_depth: 0 }),
    await toolContext(workspace),
  );
  assert.equal(nestedResult.content, ["src/b.ts", "src/nested/"].join("\n"));
  assert.equal(nestedResult.metadata.ignoredCount, 1);

  const customDepth = await listFilesTool.execute(
    listFilesTool.validate({ max_depth: 1 }),
    await toolContext(workspace),
  );
  assert.equal(customDepth.content, ["a.txt", "src/", "src/b.ts", "src/nested/", "z.txt"].join("\n"));
});

test("orders traversal by final emitted keys including the directory slash", async () => {
  const workspace = await temporaryDirectory("emitted-order");
  await mkdir(join(workspace, "a"));
  await writeFile(join(workspace, "a", "z.txt"), "z", "utf8");
  await writeFile(join(workspace, "a-0.txt"), "dash", "utf8");

  const result = await listFilesTool.execute(listFilesTool.validate({}), await toolContext(workspace));

  assert.equal(result.content, ["a-0.txt", "a/", "a/z.txt"].join("\n"));
});

test("stops deterministically at 2,000 entries and reports the independent entry cap", async () => {
  const workspace = await temporaryDirectory("entry-cap");
  await mkdir(join(workspace, "a"));
  await writeFile(join(workspace, "a", "z.txt"), "", "utf8");
  await writeFile(join(workspace, "a-0.txt"), "", "utf8");
  await Promise.all(Array.from({ length: 1_998 }, (_, index) =>
    writeFile(join(workspace, `z-${String(index).padStart(4, "0")}.txt`), "", "utf8")));

  const result = await listFilesTool.execute(listFilesTool.validate({}), await toolContext(workspace));
  const entries = result.content.split("\n");
  assert.equal(result.status, "success");
  assert.equal(result.metadata.entryCount, 2_000);
  assert.equal(result.metadata.entryLimitTruncated, true);
  assert.equal(result.metadata.contentTruncated, false);
  assert.equal(entries.length, 2_000);
  assert.deepEqual(entries.slice(0, 3), ["a-0.txt", "a/", "a/z.txt"]);
  assert.equal(entries.at(-1), "z-1996.txt");
});

test("applies the 50 KiB content cap independently of the entry cap", async () => {
  const workspace = await temporaryDirectory("content-cap");
  await Promise.all(Array.from({ length: 1_000 }, (_, index) =>
    writeFile(join(workspace, `long-${String(index).padStart(4, "0")}-${"x".repeat(50)}.txt`), "", "utf8")));

  const result = await listFilesTool.execute(listFilesTool.validate({}), await toolContext(workspace));
  assert.equal(result.status, "success");
  assert.equal(result.metadata.entryCount, 1_000);
  assert.equal(result.metadata.entryLimitTruncated, false);
  assert.equal(result.metadata.contentTruncated, true);
  assert.ok(Buffer.byteLength(result.content) <= 50 * 1024);
  assert.match(result.content, /\n\[truncated: \d+ bytes omitted\]$/);
});

test("includes safe directory links without traversing them and omits escaping links", async (context) => {
  const parent = await temporaryDirectory("links");
  const workspace = join(parent, "workspace");
  const outside = join(parent, "outside");
  await mkdir(join(workspace, "real"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(workspace, "real", "inside.txt"), "inside", "utf8");
  await writeFile(join(outside, "outside.txt"), "outside", "utf8");
  try {
    await symlink(join(workspace, "real"), join(workspace, "safe-link"), "junction");
    await symlink(outside, join(workspace, "escape-link"), "junction");
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

  const result = await listFilesTool.execute(listFilesTool.validate({}), await toolContext(workspace));
  assert.equal(result.content, ["real/", "real/inside.txt", "safe-link/"].join("\n"));
  assert.equal(result.metadata.entryCount, 3);
  assert.equal(result.metadata.unsafeSymlinkCount, 1);
});

test("rejects an explicit listing start whose final or ancestor component is a directory link", async (context) => {
  const workspace = await temporaryDirectory("linked-start");
  await mkdir(join(workspace, "real", "nested"), { recursive: true });
  await writeFile(join(workspace, "real", "nested", "secret.txt"), "inside", "utf8");
  try {
    await symlink(join(workspace, "real"), join(workspace, "safe-link"), "junction");
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

  const parentResult = await listFilesTool.execute(listFilesTool.validate({}), await toolContext(workspace));
  assert.equal(
    parentResult.content,
    ["real/", "real/nested/", "real/nested/secret.txt", "safe-link/"].join("\n"),
  );

  for (const path of ["safe-link", "safe-link/nested"]) {
    const result = await listFilesTool.execute(listFilesTool.validate({ path }), await toolContext(workspace));
    assert.equal(result.status, "failure");
    assert.equal(result.metadata.error, "unsafe_symlink");
    assert.doesNotMatch(result.content, /secret|inside/i);
  }
});

test("converts abort and guard failures into stable non-throwing results", async () => {
  const workspace = await temporaryDirectory("results");
  const controller = new AbortController();
  const interruptedPromise = listFilesTool.execute(
    listFilesTool.validate({}),
    await toolContext(workspace, controller.signal),
  );
  controller.abort();
  const interrupted = await interruptedPromise;
  assert.deepEqual(interrupted, {
    status: "interrupted",
    summary: "File listing interrupted.",
    content: "The file listing was interrupted.",
    durationMs: 7,
    metadata: { path: ".", maxDepth: 4 },
  });

  const failure = await listFilesTool.execute(
    listFilesTool.validate({ path: "missing-private-name" }),
    await toolContext(workspace),
  );
  assert.deepEqual(failure, {
    status: "failure",
    summary: "Unable to list workspace files.",
    content: "Path does not exist.",
    durationMs: 7,
    metadata: { path: "missing-private-name", maxDepth: 4, error: "not_found" },
  });
  assert.doesNotMatch(JSON.stringify(failure), /awacode-list|stack/i);
});

test("never returns outside entries when a listing directory becomes a junction after resolution", async (context) => {
  const parent = await temporaryDirectory("directory-swap");
  const workspacePath = join(parent, "workspace");
  const insideDirectory = join(workspacePath, "scan");
  const outsideDirectory = join(parent, "outside");
  await mkdir(insideDirectory, { recursive: true });
  await mkdir(outsideDirectory);
  await writeFile(join(insideDirectory, "inside.txt"), "inside", "utf8");
  await writeFile(join(outsideDirectory, "OUTSIDE-SECRET.txt"), "secret", "utf8");

  const workspace = await WorkspaceGuard.create(workspacePath);
  const resolveListingDirectory = workspace.resolveListingDirectory.bind(workspace);
  let swapped = false;
  Object.defineProperty(workspace, "resolveListingDirectory", {
    configurable: true,
    value: async (path: string) => {
      const resolved = await resolveListingDirectory(path);
      if (!swapped) {
        await rename(insideDirectory, join(workspacePath, "scan-original"));
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
  const times = [400, 413];
  const observedEvents: string[] = [];
  const contextWithBarrier: ToolContext = {
    workspace,
    signal: new AbortController().signal,
    now: () => times.shift() ?? 413,
    accessBarrier: async (event) => {
      observedEvents.push(`${event.kind}:${event.path}`);
    },
  };

  const result = await listFilesTool.execute(
    listFilesTool.validate({ path: "scan" }),
    contextWithBarrier,
  );

  assert.equal(swapped, true);
  assert.equal(result.status, "failure");
  assert.doesNotMatch(JSON.stringify(result), /OUTSIDE-SECRET|awacode-list-directory-swap/i);
  assert.deepEqual(observedEvents, ["directory_resolved:scan", "directory_opened:scan"]);
});
