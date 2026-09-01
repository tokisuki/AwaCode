import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ModelConfigOperationError,
  ModelConfigService,
  type EffectiveModelConfig,
} from "../../src/config/model-config.ts";

const temporaryDirectories: string[] = [];

async function configuredRoot(label: string, apiKey = "fixture-connection-key"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `awacode-connection-${label}-`));
  temporaryDirectories.push(root);
  await writeFile(join(root, "config.json"), JSON.stringify({
    baseUrl: "https://gateway.example/v1",
    model: "connection-model",
    contextLimit: 32768,
    maxOutputTokens: 4096,
  }), "utf8");
  await writeFile(join(root, "auth.json"), JSON.stringify({ apiKey }), "utf8");
  return root;
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("only an explicit connection test invokes the injected boundary with the effective config", async () => {
  const root = await configuredRoot("success");
  const observed: Array<{ config: EffectiveModelConfig; signal: AbortSignal }> = [];
  const service = new ModelConfigService({
    env: { AWACODE_DATA_DIR: root },
    connectionTester: {
      test(config, signal) {
        observed.push({ config, signal });
        return Promise.resolve({ message: "gateway accepted configuration" });
      },
    },
  });

  await service.status();
  await service.save({
    baseUrl: "https://gateway.example/v1",
    model: "connection-model",
    contextLimit: 32768,
    maxOutputTokens: 4096,
    credential: { action: "keep" },
  });
  assert.equal(observed.length, 0);

  const signal = new AbortController().signal;
  const result = await service.testConnection(signal);

  assert.deepEqual(result, {
    ok: true,
    message: "gateway accepted configuration",
    model: "connection-model",
  });
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.signal, signal);
  assert.equal(observed[0]?.config.runnable, true);
  assert.equal(observed[0]?.config.apiKey, "fixture-connection-key");
  assert.equal(JSON.stringify(result).includes("fixture-connection-key"), false);
});

test("refuses an unconfigured test without invoking the boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "awacode-connection-missing-"));
  temporaryDirectories.push(root);
  let calls = 0;
  const service = new ModelConfigService({
    env: { AWACODE_DATA_DIR: root },
    connectionTester: {
      async test() {
        calls += 1;
        return {};
      },
    },
  });

  await assert.rejects(service.testConnection(new AbortController().signal), (error: unknown) =>
    error instanceof ModelConfigOperationError
    && error.kind === "not_configured"
    && error.message === "Model configuration is not runnable");
  assert.equal(calls, 0);
});

test("returns a bounded redacted tester failure without credential fragments", async () => {
  const activeSecret = "fixture-failure-key";
  const root = await configuredRoot("failure", activeSecret);
  const service = new ModelConfigService({
    env: { AWACODE_DATA_DIR: root },
    connectionTester: {
      async test() {
        throw new Error(`Authorization: Bearer ${activeSecret}; upstream repeated ${activeSecret}; ${"x".repeat(5000)}`);
      },
    },
  });

  const result = await service.testConnection(new AbortController().signal);

  assert.equal(result.ok, false);
  assert.equal(result.model, "connection-model");
  assert.equal(result.message.includes(activeSecret), false);
  assert.match(result.message, /Authorization: Bearer \[REDACTED\]/);
  assert.ok(result.message.length <= 1000);
});

test("maps an in-flight abort to a stable sanitized cancellation error", async () => {
  const root = await configuredRoot("abort");
  let entered!: () => void;
  const testerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const service = new ModelConfigService({
    env: { AWACODE_DATA_DIR: root },
    connectionTester: {
      test(_config, signal) {
        entered();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
  });
  const controller = new AbortController();
  const pending = service.testConnection(controller.signal);
  await testerEntered;
  controller.abort(new Error("fixture cancellation detail"));

  await assert.rejects(pending, (error: unknown) =>
    error instanceof ModelConfigOperationError
    && error.kind === "cancelled"
    && error.message === "Model connection test cancelled");
});
