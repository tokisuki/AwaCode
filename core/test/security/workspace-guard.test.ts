import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  isPathWithinWorkspace,
  WorkspaceGuard,
  WorkspaceGuardError,
} from "../../src/security/workspace-guard.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-guard-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("requires the workspace root to be an existing directory", async () => {
  const parent = await temporaryDirectory("root");
  const file = join(parent, "file.txt");
  await writeFile(file, "text", "utf8");

  await assert.rejects(WorkspaceGuard.create(join(parent, "missing")), (error: unknown) => {
    assert.ok(error instanceof WorkspaceGuardError);
    assert.equal(error.code, "invalid_workspace");
    assert.equal(error.message, "Workspace must be an existing directory.");
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(WorkspaceGuard.create(file), (error: unknown) => {
    assert.ok(error instanceof WorkspaceGuardError);
    assert.equal(error.code, "invalid_workspace");
    return true;
  });
});

test("resolves existing regular files and directories to canonical workspace paths", async () => {
  const workspace = await temporaryDirectory("success");
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "main.ts"), "export {};", "utf8");
  const guard = await WorkspaceGuard.create(join(workspace, "."));

  assert.equal(guard.rootPath, resolve(workspace));
  assert.deepEqual(await guard.resolveFile("src\\main.ts"), {
    absolutePath: resolve(workspace, "src", "main.ts"),
    relativePath: "src/main.ts",
  });
  assert.deepEqual(await guard.resolveDirectory("."), {
    absolutePath: resolve(workspace),
    relativePath: ".",
  });
  assert.deepEqual(await guard.resolveDirectory("src"), {
    absolutePath: resolve(workspace, "src"),
    relativePath: "src",
  });
});

test("rejects missing paths and file-directory type mismatches with sanitized errors", async () => {
  const workspace = await temporaryDirectory("types");
  await mkdir(join(workspace, "folder"));
  await writeFile(join(workspace, "file.txt"), "text", "utf8");
  const guard = await WorkspaceGuard.create(workspace);

  for (const [operation, code] of [
    [() => guard.resolveFile("missing-secret-name.txt"), "not_found"],
    [() => guard.resolveFile("folder"), "not_file"],
    [() => guard.resolveDirectory("file.txt"), "not_directory"],
  ] as const) {
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof WorkspaceGuardError);
      assert.equal(error.code, code);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /missing-secret-name|awacode-guard|file\.txt|folder/);
      return true;
    });
  }
});

test("rejects unsafe path syntax before resolving the filesystem", async () => {
  const workspace = await temporaryDirectory("syntax");
  const guard = await WorkspaceGuard.create(workspace);

  for (const unsafePath of [
    "",
    "/outside",
    "C:\\outside",
    "D:/outside",
    "\\\\server\\share\\outside",
    "\\\\?\\C:\\outside",
    "\\\\.\\pipe\\outside",
    "nul\0byte",
    "../outside",
    "folder/../outside",
    "folder\\..\\outside",
  ]) {
    await assert.rejects(guard.resolveFile(unsafePath), (error: unknown) => {
      assert.ok(error instanceof WorkspaceGuardError);
      assert.equal(error.code, "invalid_path", unsafePath);
      assert.equal(error.message, "Path must be a safe relative workspace path.");
      return true;
    });
  }
});

test("checks containment by path components with Windows-only case folding", () => {
  assert.equal(isPathWithinWorkspace("/work/repo", "/work/repo", "linux"), true);
  assert.equal(isPathWithinWorkspace("/work/repo", "/work/repo/src/file.ts", "linux"), true);
  assert.equal(isPathWithinWorkspace("/work/repo", "/work/repository/file.ts", "linux"), false);
  assert.equal(isPathWithinWorkspace("/work/repo", "/WORK/repo/file.ts", "linux"), false);

  assert.equal(isPathWithinWorkspace("C:\\Work\\Repo", "c:\\work\\repo\\SRC\\file.ts", "win32"), true);
  assert.equal(isPathWithinWorkspace("C:\\Work\\Repo", "C:\\Work\\Repo2\\file.ts", "win32"), false);
  assert.equal(isPathWithinWorkspace("C:\\Work\\Repo", "D:\\Work\\Repo\\file.ts", "win32"), false);
});

async function createLinkOrSkip(
  context: test.TestContext,
  target: string,
  path: string,
  type: "file" | "junction",
): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "unknown";
    if (["EACCES", "EPERM", "UNKNOWN"].includes(code)) {
      context.skip(`symbolic links unavailable: ${code}`);
      return false;
    }
    throw error;
  }
}

test("allows internal links but rejects escaping file and directory links", async (context) => {
  const parent = await temporaryDirectory("links");
  const workspace = join(parent, "workspace");
  const prefixCollision = join(parent, "workspace2");
  await mkdir(join(workspace, "inside"), { recursive: true });
  await mkdir(prefixCollision);
  await writeFile(join(workspace, "inside", "file.txt"), "inside", "utf8");
  await writeFile(join(prefixCollision, "outside.txt"), "outside", "utf8");

  if (!await createLinkOrSkip(context, join(workspace, "inside", "file.txt"), join(workspace, "internal-file"), "file")) {
    return;
  }
  if (!await createLinkOrSkip(context, join(workspace, "inside"), join(workspace, "internal-directory"), "junction")) {
    return;
  }
  if (!await createLinkOrSkip(context, join(prefixCollision, "outside.txt"), join(workspace, "escaping-file"), "file")) {
    return;
  }
  if (!await createLinkOrSkip(context, prefixCollision, join(workspace, "escaping-directory"), "junction")) {
    return;
  }

  const guard = await WorkspaceGuard.create(workspace);
  assert.deepEqual(await guard.resolveFile("internal-file"), {
    absolutePath: resolve(workspace, "inside", "file.txt"),
    relativePath: "inside/file.txt",
  });
  assert.deepEqual(await guard.resolveDirectory("internal-directory"), {
    absolutePath: resolve(workspace, "inside"),
    relativePath: "inside",
  });

  for (const operation of [
    () => guard.resolveFile("escaping-file"),
    () => guard.resolveDirectory("escaping-directory"),
  ]) {
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof WorkspaceGuardError);
      assert.equal(error.code, "outside_workspace");
      assert.equal(error.message, "Path resolves outside the workspace.");
      assert.doesNotMatch(error.message, /workspace2|outside/);
      return true;
    });
  }
});
