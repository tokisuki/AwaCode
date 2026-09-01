import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { resolveProjectIdentity } from "../../src/project/project-identity.ts";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

function cleanEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|OPENAI|ANTHROPIC|AZURE|AWS)/i.test(name))),
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd, env: cleanEnvironment(), encoding: "utf8" });
  return result.stdout.trim();
}

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `awacode-project-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function initializeRepository(label: string): Promise<string> {
  const directory = await temporaryDirectory(label);
  await git(directory, "init");
  await git(directory, "config", "commit.gpgsign", "false");
  return directory;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("normalizes scp and URL remotes and gives different clones one stable remote identity", async () => {
  const first = await initializeRepository("remote-first");
  const second = await initializeRepository("remote-second");
  const third = await initializeRepository("remote-third");
  await git(first, "remote", "add", "origin", "git@GitHub.COM:OpenAI/AwaCode.git");
  await git(second, "remote", "add", "origin", "https://User:Pass@github.com:443/openai/awacode.git/?ignored=1#fragment");
  await git(third, "remote", "add", "origin", "ssh://Git@GitHub.com:22/OpenAI/AwaCode.git");

  const firstIdentity = await resolveProjectIdentity(first);
  const secondIdentity = await resolveProjectIdentity(second);
  const thirdIdentity = await resolveProjectIdentity(third);

  assert.deepEqual(
    { kind: firstIdentity.kind, value: firstIdentity.value, remote: firstIdentity.remote, id: firstIdentity.id },
    {
      kind: "remote",
      value: "github.com/openai/awacode",
      remote: "github.com/openai/awacode",
      id: "2cf3e837bc8c0f9b0c868b67af2ecf33bbe829f38f4c15f95814dc66c25f5749",
    },
  );
  assert.equal(secondIdentity.id, firstIdentity.id);
  assert.equal(secondIdentity.value, "github.com/openai/awacode");
  assert.notEqual(secondIdentity.rootPath, firstIdentity.rootPath);
  assert.equal(thirdIdentity.id, firstIdentity.id);
  assert.equal(thirdIdentity.value, "github.com/openai/awacode");
});

test("uses the lexicographically first root commit when no origin remote exists", async () => {
  const repository = await initializeRepository("root");
  await git(repository, "config", "user.name", "AwaCode Test");
  await git(repository, "config", "user.email", "awacode@example.invalid");
  await git(repository, "commit", "--allow-empty", "-m", "root commit");
  const rootHash = await git(repository, "rev-list", "--max-parents=0", "HEAD");

  const identity = await resolveProjectIdentity(repository);

  assert.equal(identity.kind, "root");
  assert.equal(identity.value, rootHash);
  assert.equal(identity.remote, undefined);
  assert.equal(identity.id, sha256(`root:${rootHash}`));
});

test("falls back to the normalized real path for non-Git directories and unborn repositories", async () => {
  const parent = await temporaryDirectory("path");
  const plain = join(parent, "plain", "nested", "..");
  await mkdir(plain, { recursive: true });
  const unborn = await initializeRepository("unborn");

  for (const directory of [plain, unborn]) {
    const real = normalize(await realpath(directory));
    const identity = await resolveProjectIdentity(directory, { platform: "win32" });

    assert.equal(identity.kind, "path");
    assert.equal(identity.value, real.toLowerCase());
    assert.equal(identity.rootPath, real);
    assert.equal(identity.remote, undefined);
    assert.equal(identity.id, sha256(`path:${real.toLowerCase()}`));
  }
});

for (const [label, remote] of [
  ["forward-slash drive", "C:/repo/project.git"],
  ["backslash drive", "D:\\repo\\project.git"],
  ["UNC", "\\\\server\\share\\project.git"],
  ["file URL", "file:///C:/repo/project.git"],
] as const) {
  test(`treats a ${label} origin as local and falls back to path identity`, async () => {
    const repository = await initializeRepository(`local-${label.replaceAll(" ", "-")}`);
    await git(repository, "remote", "add", "origin", remote);
    const real = normalize(await realpath(repository));
    const expectedPath = process.platform === "win32" ? real.toLowerCase() : real;

    const resolved = await resolveProjectIdentity(repository);

    assert.equal(resolved.kind, "path");
    assert.equal(resolved.value, expectedPath);
    assert.equal(resolved.remote, undefined);
    assert.equal(resolved.id, sha256(`path:${expectedPath}`));
  });
}

test("rejects a workspace that is not an existing directory", async () => {
  const parent = await temporaryDirectory("missing");
  await assert.rejects(resolveProjectIdentity(join(parent, "does-not-exist")), /existing directory/);
});

test("treats a relative local origin as local and falls back without failing workspace resolution", async () => {
  const repository = await initializeRepository("relative-origin");
  await git(repository, "remote", "add", "origin", "../shared/repository.git");
  const real = normalize(await realpath(repository));
  const identity = await resolveProjectIdentity(repository);
  const expectedPath = process.platform === "win32" ? real.toLowerCase() : real;
  assert.equal(identity.kind, "path");
  assert.equal(identity.value, expectedPath);
  assert.equal(identity.remote, undefined);
});
