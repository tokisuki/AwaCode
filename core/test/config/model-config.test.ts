import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModelConfigService } from "../../src/config/model-config.ts";
import { openDatabase } from "../../src/persistence/database.ts";

const temporaryDirectories: string[] = [];

async function dataRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `awacode-config-${label}-`));
  temporaryDirectories.push(root);
  return root;
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("missing model files expose safe defaults and absent sources", async () => {
  const root = await dataRoot("missing");
  const service = new ModelConfigService({ env: { AWACODE_DATA_DIR: root } });

  assert.deepEqual(await service.status(), {
    runnable: false,
    baseUrl: null,
    model: null,
    contextLimit: 32768,
    maxOutputTokens: 4096,
    hasApiKey: false,
    sources: {
      baseUrl: "absent",
      model: "absent",
      contextLimit: "default",
      maxOutputTokens: "default",
      apiKey: "absent",
    },
    issues: [
      { code: "missing_base_url", field: "baseUrl" },
      { code: "missing_model", field: "model" },
      { code: "missing_api_key", field: "apiKey" },
    ],
  });
});

test("loads a valid effective model configuration from local files", async () => {
  const root = await dataRoot("files");
  await writeFile(join(root, "config.json"), JSON.stringify({
    baseUrl: "https://gateway.example/v1",
    model: "demo-model",
    contextLimit: 64000,
    maxOutputTokens: 8000,
  }), "utf8");
  await writeFile(join(root, "auth.json"), JSON.stringify({ apiKey: "saved-key-value" }), "utf8");

  const effective = await new ModelConfigService({ env: { AWACODE_DATA_DIR: root } }).loadEffective();

  assert.equal(effective.apiKey, "saved-key-value");
  assert.deepEqual(effective, {
    runnable: true,
    baseUrl: "https://gateway.example/v1",
    model: "demo-model",
    contextLimit: 64000,
    maxOutputTokens: 8000,
    apiKey: "saved-key-value",
    sources: {
      baseUrl: "file",
      model: "file",
      contextLimit: "file",
      maxOutputTokens: "file",
      apiKey: "file",
    },
    issues: [],
  });
});

test("nonblank environment settings override files while blank values do not", async () => {
  const root = await dataRoot("environment");
  await writeFile(join(root, "config.json"), JSON.stringify({
    baseUrl: "https://file.example/v1",
    model: "file-model",
    contextLimit: 32000,
    maxOutputTokens: 3000,
  }), "utf8");
  await writeFile(join(root, "auth.json"), JSON.stringify({ apiKey: "file-key-value" }), "utf8");

  const effective = await new ModelConfigService({
    env: {
      AWACODE_DATA_DIR: root,
      AWACODE_BASE_URL: " https://environment.example/api ",
      AWACODE_MODEL: "  ",
      AWACODE_CONTEXT_LIMIT: "48000",
      AWACODE_MAX_OUTPUT_TOKENS: "6000",
      AWACODE_API_KEY: "environment-key-value",
    },
  }).loadEffective();

  assert.deepEqual(effective, {
    runnable: true,
    baseUrl: "https://environment.example/api",
    model: "file-model",
    contextLimit: 48000,
    maxOutputTokens: 6000,
    apiKey: "environment-key-value",
    sources: {
      baseUrl: "environment",
      model: "file",
      contextLimit: "environment",
      maxOutputTokens: "environment",
      apiKey: "environment",
    },
    issues: [],
  });
});

test("an invalid environment override masks a valid file value and reports the field", async () => {
  const root = await dataRoot("invalid-override");
  await writeFile(join(root, "config.json"), JSON.stringify({
    baseUrl: "https://file.example/v1",
    model: "file-model",
    contextLimit: 32000,
    maxOutputTokens: 3000,
  }), "utf8");
  await writeFile(join(root, "auth.json"), JSON.stringify({ apiKey: "file-key-value" }), "utf8");

  const status = await new ModelConfigService({
    env: {
      AWACODE_DATA_DIR: root,
      AWACODE_BASE_URL: "https://user:password@gateway.example/v1?debug=true",
    },
  }).status();

  assert.equal(status.runnable, false);
  assert.equal(status.baseUrl, null);
  assert.equal(status.sources.baseUrl, "environment");
  assert.deepEqual(status.issues, [{ code: "invalid_base_url", field: "baseUrl" }]);
});

test("save writes compact files and keep, store, and remove have literal credential semantics", async () => {
  const root = await dataRoot("save-actions");
  const service = new ModelConfigService({ env: { AWACODE_DATA_DIR: root } });
  const secret = "fixture-saved-api-key";

  const stored = await service.save({
    baseUrl: "https://gateway.example/v1",
    model: "first-model",
    contextLimit: 50000,
    maxOutputTokens: 5000,
    credential: { action: "store", apiKey: secret },
  });

  assert.equal(JSON.stringify(stored).includes(secret), false);
  assert.deepEqual(stored, {
    runnable: true,
    baseUrl: "https://gateway.example/v1",
    model: "first-model",
    contextLimit: 50000,
    maxOutputTokens: 5000,
    hasApiKey: true,
    sources: {
      baseUrl: "file",
      model: "file",
      contextLimit: "file",
      maxOutputTokens: "file",
      apiKey: "file",
    },
    issues: [],
  });
  assert.equal(
    await readFile(join(root, "config.json"), "utf8"),
    '{"baseUrl":"https://gateway.example/v1","model":"first-model","contextLimit":50000,"maxOutputTokens":5000}',
  );
  assert.equal(await readFile(join(root, "auth.json"), "utf8"), JSON.stringify({ apiKey: secret }));

  await service.save({
    baseUrl: "https://second.example/api",
    model: "second-model",
    contextLimit: 60000,
    maxOutputTokens: 6000,
    credential: { action: "keep" },
  });
  assert.equal(await readFile(join(root, "auth.json"), "utf8"), JSON.stringify({ apiKey: secret }));

  const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
  connection.close();
  assert.equal((await readFile(join(root, "awacode.db"))).includes(Buffer.from(secret)), false);

  const removed = await service.save({
    baseUrl: "https://second.example/api",
    model: "second-model",
    contextLimit: 60000,
    maxOutputTokens: 6000,
    credential: { action: "remove" },
  });
  assert.equal(removed.hasApiKey, false);
  await assert.rejects(access(join(root, "auth.json")), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");

  await service.save({
    baseUrl: "https://second.example/api",
    model: "second-model",
    contextLimit: 60000,
    maxOutputTokens: 6000,
    credential: { action: "remove" },
  });
  await assert.rejects(access(join(root, "auth.json")), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("save rejects representative invalid configuration and credential values before writing", async () => {
  const root = await dataRoot("save-invalid");
  const service = new ModelConfigService({ env: { AWACODE_DATA_DIR: root } });
  const invalidInputs = [
    {
      baseUrl: "relative/v1",
      model: "model",
      contextLimit: 32768,
      maxOutputTokens: 4096,
      credential: { action: "keep" as const },
    },
    {
      baseUrl: "https://gateway.example/v1",
      model: "bad\nmodel",
      contextLimit: 32768,
      maxOutputTokens: 4096,
      credential: { action: "keep" as const },
    },
    {
      baseUrl: "https://gateway.example/v1",
      model: "bad\u0085model",
      contextLimit: 32768,
      maxOutputTokens: 4096,
      credential: { action: "keep" as const },
    },
    {
      baseUrl: "https://gateway.example/v1",
      model: "model",
      contextLimit: 4096,
      maxOutputTokens: 4096,
      credential: { action: "keep" as const },
    },
    {
      baseUrl: "https://gateway.example/v1",
      model: "model",
      contextLimit: 32768,
      maxOutputTokens: 4096,
      credential: { action: "store" as const, apiKey: "" },
    },
    {
      baseUrl: "https://gateway.example/v1",
      model: "model",
      contextLimit: 32768,
      maxOutputTokens: 4096,
      credential: { action: "store" as const, apiKey: "key\u0085value" },
    },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(service.save(input), TypeError);
  }
  await assert.rejects(access(join(root, "config.json")), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("a malformed local config becomes a safe issue instead of exposing parser diagnostics", async () => {
  const root = await dataRoot("parse-failure");
  await writeFile(join(root, "config.json"), "{broken", "utf8");

  const status = await new ModelConfigService({ env: { AWACODE_DATA_DIR: root } }).status();

  assert.equal(status.runnable, false);
  assert.equal(status.issues.some((issue) => issue.code === "invalid_config_file" && issue.field === "config"), true);
});

test("an atomic write failure preserves the prior file and cleans only its own temporary file", async () => {
  const root = await dataRoot("atomic-failure");
  const original = '{"baseUrl":"https://old.example/v1","model":"old","contextLimit":32000,"maxOutputTokens":3000}';
  await writeFile(join(root, "config.json"), original, "utf8");
  const service = new ModelConfigService({
    env: { AWACODE_DATA_DIR: root },
    testHooks: {
      beforeRename(kind) {
        if (kind === "config") {
          throw new Error("fixture rename failure");
        }
      },
    },
  });

  await assert.rejects(service.save({
    baseUrl: "https://new.example/v1",
    model: "new",
    contextLimit: 48000,
    maxOutputTokens: 4000,
    credential: { action: "keep" },
  }), (error: unknown) => error instanceof Error && error.message === "Model configuration save failed");

  assert.equal(await readFile(join(root, "config.json"), "utf8"), original);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("concurrent saves are serialized in call order", async () => {
  const root = await dataRoot("concurrent");
  let renameCalls = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const service = new ModelConfigService({
    env: { AWACODE_DATA_DIR: root },
    testHooks: {
      async beforeRename(kind) {
        if (kind === "config" && ++renameCalls === 1) {
          firstEntered();
          await firstBlocked;
        }
      },
    },
  });
  const first = service.save({
    baseUrl: "https://first.example/v1",
    model: "first",
    contextLimit: 32000,
    maxOutputTokens: 3000,
    credential: { action: "keep" },
  });
  await entered;
  const second = service.save({
    baseUrl: "https://second.example/v1",
    model: "second",
    contextLimit: 64000,
    maxOutputTokens: 6000,
    credential: { action: "keep" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(renameCalls, 2);
  assert.equal(
    await readFile(join(root, "config.json"), "utf8"),
    '{"baseUrl":"https://second.example/v1","model":"second","contextLimit":64000,"maxOutputTokens":6000}',
  );
});
