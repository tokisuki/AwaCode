import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceGuard } from "../../src/security/workspace-guard.ts";
import { ToolValidationError, type ToolContext } from "../../src/tools/contracts.ts";
import { searchTextTool } from "../../src/tools/search-text.ts";

const temporaryDirectories: string[] = [];

async function fixture(label: string): Promise<{ root: string; context: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), `awacode-search-${label}-`));
  temporaryDirectories.push(root);
  return {
    root,
    context: {
      workspace: await WorkspaceGuard.create(root),
      signal: new AbortController().signal,
      now: () => 10,
    },
  };
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("search_text validates its exact bounded input contract", () => {
  assert.equal(searchTextTool.name, "search_text");
  assert.equal(searchTextTool.approval, "none");
  assert.deepEqual(searchTextTool.validate({ query: "needle" }), {
    query: "needle",
    path: ".",
    isRegex: false,
  });
  assert.deepEqual(searchTextTool.validate({ query: "n.+e", path: "src", is_regex: true }), {
    query: "n.+e",
    path: "src",
    isRegex: true,
  });
  for (const invalid of [
    {},
    { query: "" },
    { query: "x", extra: true },
    { query: "[", is_regex: true },
    { query: "x", is_regex: "yes" },
  ]) {
    assert.throws(() => searchTextTool.validate(invalid), ToolValidationError);
  }
});

test("search_text reports ordered line matches while skipping generated, binary, and oversized files", async () => {
  const { root, context } = await fixture("skip");
  await mkdir(join(root, "src"));
  await mkdir(join(root, "dist"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "src", "a.txt"), "first needle\nsecond\nneedle last", "utf8");
  await writeFile(join(root, "src", "b.txt"), "NEEDLE ignored by case-sensitive search", "utf8");
  await writeFile(join(root, "dist", "generated.txt"), "needle", "utf8");
  await writeFile(join(root, "node_modules", "dependency.txt"), "needle", "utf8");
  await writeFile(join(root, "src", "binary.dat"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]));
  await writeFile(join(root, "src", "oversized.txt"), `needle${"x".repeat(1024 * 1024)}`, "utf8");

  const result = await searchTextTool.execute(
    searchTextTool.validate({ query: "needle" }),
    context,
  );

  assert.equal(result.status, "success");
  assert.equal(result.content, "src/a.txt:1: first needle\nsrc/a.txt:3: needle last");
  assert.deepEqual(result.metadata, {
    path: ".",
    matchCount: 2,
    filesSearched: 2,
    ignoredDirectoryCount: 2,
    binaryFileCount: 1,
    oversizedFileCount: 1,
    unsafeSymlinkCount: 0,
    matchLimitTruncated: false,
    contentTruncated: false,
  });
});

test("search_text bounds regex matches at 500 without splitting a file result line", async () => {
  const { root, context } = await fixture("limit");
  await writeFile(join(root, "many.txt"), Array.from({ length: 520 }, (_, index) => `item-${index}`).join("\n"), "utf8");

  const result = await searchTextTool.execute(
    searchTextTool.validate({ query: "^item-", is_regex: true }),
    context,
  );

  assert.equal(result.status, "success");
  assert.equal(result.metadata.matchCount, 500);
  assert.equal(result.metadata.matchLimitTruncated, true);
  assert.match(result.content, /^many\.txt:1: item-0/);
  assert.match(result.content, /many\.txt:500: item-499$/);
  assert.doesNotMatch(result.content, /item-500/);
});
