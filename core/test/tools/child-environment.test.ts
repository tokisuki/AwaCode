import assert from "node:assert/strict";
import test from "node:test";

import { filterChildEnvironment } from "../../src/tools/child-environment.ts";

test("filters credential-like child variables case-insensitively without mutating the input", () => {
  const inherited = Object.create({ INHERITED_SAFE: "ignore", INHERITED_TOKEN: "ignore-secret" }) as NodeJS.ProcessEnv;
  Object.assign(inherited, {
    PATH: "safe-path",
    HOME: "safe-home",
    AWACODE_API_KEY: "awacode-secret",
    openai_api_key: "openai-secret",
    OTHER_API_KEY: "other-secret",
    github_ToKeN: "github-secret",
    authorizationHeader: "authorization-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    accessToken: "access-secret",
    clientSecret: "client-secret",
    PGPASSWORD: "pg-password-secret",
    DATABASE_PASSWORD: "database-password-secret",
    databasePassword: "camel-password-secret",
    apiKey: "camel-api-key-secret",
    serviceApiKey: "service-api-key-secret",
    AWS_ACCESS_KEY_ID: "aws-access-key-secret",
    accessKey: "camel-access-key-secret",
    privateKey: "camel-private-key-secret",
    SERVICE_PRIVATE_KEY: "service-private-key-secret",
    DATABASE_HOST: "database.example",
    API_ENDPOINT: "https://example.invalid",
    ACCESS_MODE: "readonly",
    PRIVATE_MODE: "false",
    PUBLIC_KEY_ALGORITHM: "ed25519",
    KEYBOARD_LAYOUT: "us",
    MONKEY_PATCH: "enabled",
    EMPTY_VALUE: "",
    UNDEFINED_VALUE: undefined,
  });
  Object.defineProperty(inherited, Symbol("symbol-secret"), {
    enumerable: true,
    value: "symbol-value",
  });
  const before = Object.getOwnPropertyDescriptors(inherited);

  const filtered = filterChildEnvironment(inherited);

  assert.deepEqual(filtered, {
    PATH: "safe-path",
    HOME: "safe-home",
    DATABASE_HOST: "database.example",
    API_ENDPOINT: "https://example.invalid",
    ACCESS_MODE: "readonly",
    PRIVATE_MODE: "false",
    PUBLIC_KEY_ALGORITHM: "ed25519",
    KEYBOARD_LAYOUT: "us",
    MONKEY_PATCH: "enabled",
    EMPTY_VALUE: "",
  });
  assert.notEqual(filtered, inherited);
  assert.deepEqual(Object.getOwnPropertyDescriptors(inherited), before);
  assert.equal(Object.getPrototypeOf(filtered), Object.prototype);
  assert.deepEqual(Reflect.ownKeys(filtered), [
    "PATH",
    "HOME",
    "DATABASE_HOST",
    "API_ENDPOINT",
    "ACCESS_MODE",
    "PRIVATE_MODE",
    "PUBLIC_KEY_ALGORITHM",
    "KEYBOARD_LAYOUT",
    "MONKEY_PATCH",
    "EMPTY_VALUE",
  ]);
});
