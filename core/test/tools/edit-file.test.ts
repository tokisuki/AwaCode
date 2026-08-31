import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceGuard, WorkspaceGuardError } from "../../src/security/workspace-guard.ts";
import { ToolValidationError } from "../../src/tools/contracts.ts";
import {
  EditFilePreparationError,
  EditFileApplyError,
  applyPreparedEditFile,
  editFileTool,
  prepareEditFile,
} from "../../src/tools/edit-file.ts";
import { PERMISSION_TEXT_PREVIEW_BYTES } from "../../src/tools/permission.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-edit-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("validates exact edit_file input and defaults replace_all without retaining caller data", () => {
  assert.equal(editFileTool.name, "edit_file");
  assert.equal(editFileTool.approval, "write");
  assert.equal(typeof editFileTool.execute, "function");
  assert.deepEqual(editFileTool.inputSchema, {
    type: "object",
    additionalProperties: false,
    required: ["path", "old_text", "new_text"],
    properties: {
      path: { type: "string", minLength: 1 },
      old_text: { type: "string", minLength: 1 },
      new_text: { type: "string" },
      replace_all: { type: "boolean" },
    },
  });

  const source = { path: "src/main.ts", old_text: "old", new_text: "new" };
  const result = editFileTool.validate(source);
  assert.notEqual(result, source);
  assert.deepEqual(result, {
    path: "src/main.ts",
    oldText: "old",
    newText: "new",
    replaceAll: false,
  });
  assert.deepEqual(editFileTool.validate({
    path: "中文.txt",
    old_text: "旧",
    new_text: "",
    replace_all: true,
  }), {
    path: "中文.txt",
    oldText: "旧",
    newText: "",
    replaceAll: true,
  });

  const inherited = Object.create({ path: "file.txt" }) as Record<string, unknown>;
  inherited.old_text = "old";
  inherited.new_text = "new";
  for (const invalid of [
    null,
    [],
    inherited,
    {},
    { path: "file.txt", old_text: "old" },
    { path: "file.txt", old_text: "old", new_text: "new", extra: true },
    { path: undefined, old_text: "old", new_text: "new" },
    { path: "", old_text: "old", new_text: "new" },
    { path: "   ", old_text: "old", new_text: "new" },
    { path: 1, old_text: "old", new_text: "new" },
    { path: "file.txt", old_text: undefined, new_text: "new" },
    { path: "file.txt", old_text: "", new_text: "new" },
    { path: "file.txt", old_text: 1, new_text: "new" },
    { path: "file.txt", old_text: "old", new_text: undefined },
    { path: "file.txt", old_text: "old", new_text: 1 },
    { path: "file.txt", old_text: "old", new_text: "new", replace_all: undefined },
    { path: "file.txt", old_text: "old", new_text: "new", replace_all: "yes" },
  ]) {
    assert.throws(() => editFileTool.validate(invalid), ToolValidationError);
  }
});

test("prepares one exact replacement through a retained handle without changing the file", async () => {
  const workspacePath = await temporaryDirectory("prepare-one");
  const source = "first\r\n旧值\r\nlast";
  await writeFile(join(workspacePath, "sample.txt"), source, "utf8");
  const input = editFileTool.validate({
    path: "sample.txt",
    old_text: "旧值",
    new_text: "新值",
  });

  const prepared = await prepareEditFile(input, {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: new AbortController().signal,
    now: () => 0,
  });

  assert.equal(prepared.path, "sample.txt");
  assert.equal(prepared.replacementCount, 1);
  assert.equal(prepared.digest, createHash("sha256").update(Buffer.from(source)).digest("hex"));
  assert.ok(prepared.identity.dev !== 0n);
  assert.ok(prepared.identity.ino !== 0n);
  assert.deepEqual(prepared.permission, {
    kind: "write",
    title: "Edit workspace file",
    preview: {
      path: "sample.txt",
      replacementCount: 1,
      before: "旧值",
      after: "新值",
      sha256: prepared.digest,
    },
  });
  assert.equal(await readFile(join(workspacePath, "sample.txt"), "utf8"), source);
});

test("bounds exact approval preview fields by UTF-8 bytes without exposing absolute paths", async () => {
  const workspacePath = await temporaryDirectory("bounded-preview");
  const oldText = "旧".repeat(2_000);
  const newText = "新".repeat(2_000);
  await writeFile(join(workspacePath, "sample.txt"), `prefix${oldText}suffix`, "utf8");
  const prepared = await prepareEditFile(editFileTool.validate({
    path: "sample.txt",
    old_text: oldText,
    new_text: newText,
  }), {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: new AbortController().signal,
    now: () => 0,
  });

  assert.deepEqual(Reflect.ownKeys(prepared.permission.preview).sort(), [
    "after",
    "before",
    "path",
    "replacementCount",
    "sha256",
  ]);
  assert.ok(Buffer.byteLength(prepared.permission.preview.before) <= PERMISSION_TEXT_PREVIEW_BYTES);
  assert.ok(Buffer.byteLength(prepared.permission.preview.after) <= PERMISSION_TEXT_PREVIEW_BYTES);
  assert.match(prepared.permission.preview.before, /\[truncated: \d+ bytes omitted\]$/);
  assert.match(prepared.permission.preview.after, /\[truncated: \d+ bytes omitted\]$/);
  assert.doesNotMatch(JSON.stringify(prepared.permission), new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test("requires unique default matches and counts every non-overlapping replace_all match", async () => {
  const workspacePath = await temporaryDirectory("matches");
  await writeFile(join(workspacePath, "none.txt"), "alpha", "utf8");
  await writeFile(join(workspacePath, "many.txt"), "aaaa", "utf8");
  const context = {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: new AbortController().signal,
    now: () => 0,
  };

  await assert.rejects(
    prepareEditFile(editFileTool.validate({ path: "none.txt", old_text: "missing", new_text: "x" }), context),
    (error: unknown) => error instanceof EditFilePreparationError && error.code === "match_not_found",
  );
  await assert.rejects(
    prepareEditFile(editFileTool.validate({ path: "many.txt", old_text: "aa", new_text: "x" }), context),
    (error: unknown) => error instanceof EditFilePreparationError && error.code === "match_not_unique",
  );
  const prepared = await prepareEditFile(
    editFileTool.validate({ path: "many.txt", old_text: "aa", new_text: "x", replace_all: true }),
    context,
  );
  assert.equal(prepared.replacementCount, 2);
  assert.equal(prepared.permission.preview.replacementCount, 2);
});

test("rejects NUL and malformed UTF-8 before requesting approval", async () => {
  const workspacePath = await temporaryDirectory("binary");
  await writeFile(join(workspacePath, "nul.bin"), Buffer.from([0x61, 0x00, 0x62]));
  await writeFile(join(workspacePath, "invalid.bin"), Buffer.from([0x61, 0xc3, 0x28]));
  const context = {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: new AbortController().signal,
    now: () => 0,
  };

  for (const path of ["nul.bin", "invalid.bin"]) {
    await assert.rejects(
      prepareEditFile(editFileTool.validate({ path, old_text: "a", new_text: "b" }), context),
      (error: unknown) => error instanceof EditFilePreparationError && error.code === "unsupported_encoding",
    );
  }
});

test("atomically replaces every exact match while preserving UTF-8, CRLF, no final newline, and mode", async () => {
  const workspacePath = await temporaryDirectory("atomic-success");
  const targetPath = join(workspacePath, "sample.txt");
  const source = "头\r\nold + old\r\n尾";
  await writeFile(targetPath, source, "utf8");
  if (process.platform !== "win32") {
    await chmod(targetPath, 0o640);
  }
  const context = {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: new AbortController().signal,
    now: () => 0,
  };
  const prepared = await prepareEditFile(editFileTool.validate({
    path: "sample.txt",
    old_text: "old",
    new_text: "新",
    replace_all: true,
  }), context);

  const result = await applyPreparedEditFile(prepared, context);

  assert.deepEqual(result, { path: "sample.txt", replacementCount: 2, replaceAll: true });
  assert.equal(await readFile(targetPath, "utf8"), "头\r\n新 + 新\r\n尾");
  if (process.platform !== "win32") {
    assert.equal((await stat(targetPath)).mode & 0o777, 0o640);
  }
  assert.deepEqual(await readdir(workspacePath), ["sample.txt"]);
});

test("rejects a content change after approval without overwriting the changed file", async () => {
  const workspacePath = await temporaryDirectory("changed-content");
  const targetPath = join(workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  const context = {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: new AbortController().signal,
    now: () => 0,
  };
  const prepared = await prepareEditFile(
    editFileTool.validate({ path: "sample.txt", old_text: "old", new_text: "new" }),
    context,
  );
  await writeFile(targetPath, "externally changed old", "utf8");

  await assert.rejects(
    applyPreparedEditFile(prepared, context),
    (error: unknown) => error instanceof EditFileApplyError && error.code === "file_changed",
  );
  assert.equal(await readFile(targetPath, "utf8"), "externally changed old");
  assert.deepEqual(await readdir(workspacePath), ["sample.txt"]);
});

test("rechecks the approved digest immediately before replace and removes the prepared temp", async () => {
  const workspacePath = await temporaryDirectory("changed-before-replace");
  const targetPath = join(workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  const context = {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: new AbortController().signal,
    now: () => 0,
  };
  const prepared = await prepareEditFile(
    editFileTool.validate({ path: "sample.txt", old_text: "old", new_text: "new" }),
    context,
  );
  let barrierCalls = 0;

  await assert.rejects(
    applyPreparedEditFile(prepared, context, {
      barrier: async (event) => {
        if (event === "before_replace") {
          barrierCalls += 1;
          await writeFile(targetPath, "changed at final check old", "utf8");
        }
      },
    }),
    (error: unknown) => error instanceof EditFileApplyError && error.code === "file_changed",
  );
  assert.equal(barrierCalls, 1);
  assert.equal(await readFile(targetPath, "utf8"), "changed at final check old");
  assert.deepEqual(await readdir(workspacePath), ["sample.txt"]);
});

for (const change of ["rewrite", "swap"] as const) {
  test(`rejects a ${change} of the temporary snapshot without deleting an unowned replacement`, async () => {
    const workspacePath = await temporaryDirectory(`changed-temp-${change}`);
    const targetPath = join(workspacePath, "sample.txt");
    const temporaryName = `owned-${change}`;
    const temporaryPath = join(workspacePath, `.awacode-edit-${temporaryName}.tmp`);
    const attackerContent = `unapproved-${change}`;
    await writeFile(targetPath, "before old after", "utf8");
    const context = {
      workspace: await WorkspaceGuard.create(workspacePath),
      signal: new AbortController().signal,
      now: () => 0,
    };
    const prepared = await prepareEditFile(
      editFileTool.validate({ path: "sample.txt", old_text: "old", new_text: "new" }),
      context,
    );

    await assert.rejects(
      applyPreparedEditFile(prepared, context, {
        createTemporaryName: () => temporaryName,
        barrier: async () => {
          if (change === "swap") {
            await rm(temporaryPath);
          }
          await writeFile(temporaryPath, attackerContent, "utf8");
        },
      }),
      (error: unknown) => error instanceof EditFileApplyError
        && error.code === "temporary_file_changed",
    );

    assert.equal(await readFile(targetPath, "utf8"), "before old after");
    if (change === "rewrite") {
      assert.deepEqual(await readdir(workspacePath), ["sample.txt"]);
    } else {
      assert.equal(await readFile(temporaryPath, "utf8"), attackerContent);
    }
  });
}

test("rechecks the temporary snapshot after the replace operation hook", async () => {
  const workspacePath = await temporaryDirectory("changed-temp-replace-hook");
  const targetPath = join(workspacePath, "sample.txt");
  const temporaryPath = join(workspacePath, ".awacode-edit-replace-hook.tmp");
  await writeFile(targetPath, "before old after", "utf8");
  const context = {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: new AbortController().signal,
    now: () => 0,
  };
  const prepared = await prepareEditFile(
    editFileTool.validate({ path: "sample.txt", old_text: "old", new_text: "new" }),
    context,
  );

  await assert.rejects(
    applyPreparedEditFile(prepared, context, {
      createTemporaryName: () => "replace-hook",
      async beforeOperation(operation) {
        if (operation === "replace") {
          await writeFile(temporaryPath, "unapproved-at-replace", "utf8");
        }
      },
    }),
    (error: unknown) => error instanceof EditFileApplyError
      && error.code === "temporary_file_changed",
  );

  assert.equal(await readFile(targetPath, "utf8"), "before old after");
  assert.deepEqual(await readdir(workspacePath), ["sample.txt"]);
});

test("rechecks the target snapshot after the replace operation hook", async () => {
  const workspacePath = await temporaryDirectory("changed-target-replace-hook");
  const targetPath = join(workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  const context = {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: new AbortController().signal,
    now: () => 0,
  };
  const prepared = await prepareEditFile(
    editFileTool.validate({ path: "sample.txt", old_text: "old", new_text: "new" }),
    context,
  );

  await assert.rejects(
    applyPreparedEditFile(prepared, context, {
      async beforeOperation(operation) {
        if (operation === "replace") {
          await writeFile(targetPath, "changed by replace hook old", "utf8");
        }
      },
    }),
    (error: unknown) => error instanceof EditFileApplyError && error.code === "file_changed",
  );

  assert.equal(await readFile(targetPath, "utf8"), "changed by replace hook old");
  assert.deepEqual(await readdir(workspacePath), ["sample.txt"]);
});

test("rejects a final-file symlink before approval even when its target stays inside the workspace", async (context) => {
  const workspacePath = await temporaryDirectory("internal-link");
  const targetPath = join(workspacePath, "target.txt");
  await writeFile(targetPath, "before old after", "utf8");
  try {
    await symlink(targetPath, join(workspacePath, "link.txt"), "file");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "unknown";
    if (["EACCES", "EPERM", "UNKNOWN"].includes(code)) {
      context.skip(`file links unavailable: ${code}`);
      return;
    }
    throw error;
  }
  const toolContext = {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: new AbortController().signal,
    now: () => 0,
  };

  await assert.rejects(
    prepareEditFile(
      editFileTool.validate({ path: "link.txt", old_text: "old", new_text: "new" }),
      toolContext,
    ),
    (error: unknown) => error instanceof WorkspaceGuardError && error.code === "unsafe_file_symlink",
  );
  assert.equal(await readFile(targetPath, "utf8"), "before old after");
});

test("exclusive temp creation never deletes a colliding file it did not create", async () => {
  const workspacePath = await temporaryDirectory("temp-collision");
  const targetPath = join(workspacePath, "sample.txt");
  const collisionPath = join(workspacePath, ".awacode-edit-collision.tmp");
  await writeFile(targetPath, "before old after", "utf8");
  await writeFile(collisionPath, "belongs to another operation", "utf8");
  const context = {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: new AbortController().signal,
    now: () => 0,
  };
  const prepared = await prepareEditFile(
    editFileTool.validate({ path: "sample.txt", old_text: "old", new_text: "new" }),
    context,
  );

  await assert.rejects(
    applyPreparedEditFile(prepared, context, { createTemporaryName: () => "collision" }),
    (error: unknown) => error instanceof EditFileApplyError
      && error.code === "atomic_replace_failed"
      && error.operation === "create",
  );
  assert.equal(await readFile(targetPath, "utf8"), "before old after");
  assert.equal(await readFile(collisionPath, "utf8"), "belongs to another operation");
});

for (const secondHookEffect of ["throw", "cancel"] as const) {
  test(`captures temp ownership in one create operation when a repeated hook would ${secondHookEffect}`, async () => {
    const workspacePath = await temporaryDirectory(`single-create-${secondHookEffect}`);
    const targetPath = join(workspacePath, "sample.txt");
    await writeFile(targetPath, "before old after", "utf8");
    const controller = new AbortController();
    const context = {
      workspace: await WorkspaceGuard.create(workspacePath),
      signal: controller.signal,
      now: () => 0,
    };
    const prepared = await prepareEditFile(
      editFileTool.validate({ path: "sample.txt", old_text: "old", new_text: "new" }),
      context,
    );
    let createHooks = 0;

    const outcome = await applyPreparedEditFile(prepared, context, {
      createTemporaryName: () => `single-${secondHookEffect}`,
      beforeOperation(operation) {
        if (operation === "create") {
          createHooks += 1;
          if (createHooks === 2) {
            if (secondHookEffect === "cancel") {
              controller.abort(new Error("cancelled during repeated create hook"));
            } else {
              throw new Error("failed during repeated create hook");
            }
          }
        }
      },
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    assert.deepEqual(await readdir(workspacePath), ["sample.txt"]);
    assert.equal(createHooks, 1);
    assert.ok("value" in outcome);
    assert.equal(await readFile(targetPath, "utf8"), "before new after");
  });
}

for (const firstHookEffect of ["throw", "cancel"] as const) {
  test(`a ${firstHookEffect} in the single create hook fails before ownership begins without a leak`, async () => {
    const workspacePath = await temporaryDirectory(`first-create-${firstHookEffect}`);
    const targetPath = join(workspacePath, "sample.txt");
    await writeFile(targetPath, "before old after", "utf8");
    const controller = new AbortController();
    const context = {
      workspace: await WorkspaceGuard.create(workspacePath),
      signal: controller.signal,
      now: () => 0,
    };
    const prepared = await prepareEditFile(
      editFileTool.validate({ path: "sample.txt", old_text: "old", new_text: "new" }),
      context,
    );
    let createHooks = 0;

    await assert.rejects(
      applyPreparedEditFile(prepared, context, {
        createTemporaryName: () => `first-${firstHookEffect}`,
        beforeOperation(operation) {
          if (operation === "create") {
            createHooks += 1;
            if (firstHookEffect === "cancel") {
              controller.abort(new Error("cancelled before create"));
            } else {
              throw new Error("failed before create");
            }
          }
        },
      }),
      (error: unknown) => error instanceof EditFileApplyError
        && error.code === (firstHookEffect === "cancel" ? "interrupted" : "atomic_replace_failed")
        && (firstHookEffect === "cancel" || error.operation === "create"),
    );

    assert.equal(createHooks, 1);
    assert.deepEqual(await readdir(workspacePath), ["sample.txt"]);
    assert.equal(await readFile(targetPath, "utf8"), "before old after");
  });
}

test("injected write, sync, and replace failures preserve the target and leak no temp files", async () => {
  for (const operation of ["write", "sync", "replace"] as const) {
    const workspacePath = await temporaryDirectory(`failure-${operation}`);
    const targetPath = join(workspacePath, "sample.txt");
    await writeFile(targetPath, "before old after", "utf8");
    const context = {
      workspace: await WorkspaceGuard.create(workspacePath),
      signal: new AbortController().signal,
      now: () => 0,
    };
    const prepared = await prepareEditFile(
      editFileTool.validate({ path: "sample.txt", old_text: "old", new_text: "new" }),
      context,
    );

    await assert.rejects(
      applyPreparedEditFile(prepared, context, {
        beforeOperation(candidate) {
          if (candidate === operation) {
            throw new Error(`injected ${operation} failure`);
          }
        },
      }),
      (error: unknown) => error instanceof EditFileApplyError
        && error.code === "atomic_replace_failed"
        && error.operation === operation,
    );
    assert.equal(await readFile(targetPath, "utf8"), "before old after");
    assert.deepEqual(await readdir(workspacePath), ["sample.txt"]);
  }
});

test("deletes the exact match without adding a newline or BOM", async () => {
  const workspacePath = await temporaryDirectory("deletion");
  const targetPath = join(workspacePath, "sample.txt");
  await writeFile(targetPath, "keep DELETE tail", "utf8");
  const context = {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: new AbortController().signal,
    now: () => 0,
  };
  const prepared = await prepareEditFile(
    editFileTool.validate({ path: "sample.txt", old_text: "DELETE ", new_text: "" }),
    context,
  );

  await applyPreparedEditFile(prepared, context);

  assert.deepEqual(await readFile(targetPath), Buffer.from("keep tail"));
});

test("treats post-approval deletion and same-content path replacement as file_changed", async () => {
  for (const change of ["delete", "replace"] as const) {
    const workspacePath = await temporaryDirectory(`identity-${change}`);
    const targetPath = join(workspacePath, "sample.txt");
    const savedPath = join(workspacePath, "saved.txt");
    await writeFile(targetPath, "before old after", "utf8");
    const context = {
      workspace: await WorkspaceGuard.create(workspacePath),
      signal: new AbortController().signal,
      now: () => 0,
    };
    const prepared = await prepareEditFile(
      editFileTool.validate({ path: "sample.txt", old_text: "old", new_text: "new" }),
      context,
    );
    if (change === "delete") {
      await rm(targetPath);
    } else {
      await rename(targetPath, savedPath);
      await writeFile(targetPath, "before old after", "utf8");
    }

    await assert.rejects(
      applyPreparedEditFile(prepared, context),
      (error: unknown) => error instanceof EditFileApplyError && error.code === "file_changed",
    );
    if (change === "replace") {
      assert.equal(await readFile(targetPath, "utf8"), "before old after");
    }
    assert.equal((await readdir(workspacePath)).some((name) => name.startsWith(".awacode-edit-")), false);
  }
});

test("an abort after exclusive temp creation interrupts without a partial write or temp leak", async () => {
  const workspacePath = await temporaryDirectory("abort-temp");
  const targetPath = join(workspacePath, "sample.txt");
  await writeFile(targetPath, "before old after", "utf8");
  const controller = new AbortController();
  const context = {
    workspace: await WorkspaceGuard.create(workspacePath),
    signal: controller.signal,
    now: () => 0,
  };
  const prepared = await prepareEditFile(
    editFileTool.validate({ path: "sample.txt", old_text: "old", new_text: "new" }),
    context,
  );

  await assert.rejects(
    applyPreparedEditFile(prepared, context, {
      beforeOperation(operation) {
        if (operation === "write") {
          controller.abort(new Error("cancelled"));
        }
      },
    }),
    (error: unknown) => error instanceof EditFileApplyError && error.code === "interrupted",
  );
  assert.equal(await readFile(targetPath, "utf8"), "before old after");
  assert.deepEqual(await readdir(workspacePath), ["sample.txt"]);
});
