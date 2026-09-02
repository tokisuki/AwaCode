import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { resolveDataPaths, type DataPathOptions } from "../persistence/data-paths.ts";
import { redactDiagnostic } from "./diagnostic-redactor.ts";

const DEFAULT_CONTEXT_LIMIT = 1000000;
const DEFAULT_MAX_OUTPUT_TOKENS = 384000;
let inProcessSaveQueue: Promise<void> = Promise.resolve();

type OptionalSource = "environment" | "file" | "absent";
type LimitSource = "environment" | "file" | "default";

export interface ConfigIssue {
  code: string;
  field: string;
}

export interface ModelConfigSources {
  baseUrl: OptionalSource;
  model: OptionalSource;
  contextLimit: LimitSource;
  maxOutputTokens: LimitSource;
  apiKey: OptionalSource;
}

export interface EffectiveModelConfig {
  runnable: boolean;
  baseUrl: string | null;
  model: string | null;
  contextLimit: number;
  maxOutputTokens: number;
  apiKey: string | null;
  sources: ModelConfigSources;
  issues: ConfigIssue[];
}

export interface PublicConfigStatus {
  runnable: boolean;
  baseUrl: string | null;
  model: string | null;
  contextLimit: number;
  maxOutputTokens: number;
  hasApiKey: boolean;
  sources: ModelConfigSources;
  issues: ConfigIssue[];
}

export type CredentialAction =
  | { action: "keep" }
  | { action: "store"; apiKey: string }
  | { action: "remove" };

export interface SaveModelConfigInput {
  baseUrl: string;
  model: string;
  contextLimit: number;
  maxOutputTokens: number;
  credential: CredentialAction;
}

export interface ModelConnectionTester {
  test(config: EffectiveModelConfig, signal: AbortSignal): Promise<{ message?: string }>;
}

export interface ModelConnectionTestResult {
  ok: boolean;
  message: string;
  model: string;
}

export type ModelConfigOperationKind =
  | "save_failed"
  | "not_configured"
  | "test_unavailable"
  | "cancelled";

export class ModelConfigOperationError extends Error {
  readonly kind: ModelConfigOperationKind;

  constructor(kind: ModelConfigOperationKind, message: string) {
    super(message);
    this.name = "ModelConfigOperationError";
    this.kind = kind;
  }
}

export interface ModelConfigServiceOptions extends DataPathOptions {
  connectionTester?: ModelConnectionTester;
  /** @internal Deterministic barriers used only by real-disk tests. */
  testHooks?: {
    beforeRename?(kind: "config" | "auth", temporaryPath: string, targetPath: string): void | Promise<void>;
  };
}

interface LoadedJson {
  value: Record<string, unknown> | undefined;
  invalid: boolean;
}

interface SelectedValue {
  value: unknown;
  source: OptionalSource | LimitSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key));
}

async function loadJson(path: string): Promise<LoadedJson> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { value: undefined, invalid: false };
    }
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed)
      ? { value: parsed, invalid: false }
      : { value: undefined, invalid: true };
  } catch {
    return { value: undefined, invalid: true };
  }
}

function nonblankEnvironmentValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function selectOptional(
  env: Readonly<Record<string, string | undefined>>,
  environmentName: string,
  file: Record<string, unknown> | undefined,
  fileName: string,
): SelectedValue {
  const environment = nonblankEnvironmentValue(env, environmentName);
  if (environment !== undefined) {
    return { value: environment, source: "environment" };
  }
  return file !== undefined && Object.prototype.hasOwnProperty.call(file, fileName)
    ? { value: file[fileName], source: "file" }
    : { value: undefined, source: "absent" };
}

function selectLimit(
  env: Readonly<Record<string, string | undefined>>,
  environmentName: string,
  file: Record<string, unknown> | undefined,
  fileName: string,
  defaultValue: number,
): SelectedValue {
  const selected = selectOptional(env, environmentName, file, fileName);
  return selected.source === "absent"
    ? { value: defaultValue, source: "default" }
    : selected;
}

function hasControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function validBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0 || hasControlCharacters(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username.length === 0
      && parsed.password.length === 0
      && !value.includes("?")
      && !value.includes("#");
  } catch {
    return false;
  }
}

function validModel(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !hasControlCharacters(value);
}

function parseLimit(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : undefined;
}

function validApiKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value) && !hasControlCharacters(value);
}

export function parseSaveModelConfigInput(value: unknown): SaveModelConfigInput {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["baseUrl", "model", "contextLimit", "maxOutputTokens", "credential"])
  ) {
    throw new TypeError("Invalid model configuration");
  }
  const { baseUrl, model, credential } = value;
  const contextLimit = parseLimit(value.contextLimit);
  const maxOutputTokens = parseLimit(value.maxOutputTokens);
  if (
    !validBaseUrl(baseUrl)
    || !validModel(model)
    || contextLimit === undefined
    || maxOutputTokens === undefined
    || maxOutputTokens >= contextLimit
    || !isRecord(credential)
  ) {
    throw new TypeError("Invalid model configuration");
  }
  let parsedCredential: CredentialAction;
  if (credential.action === "keep" && hasExactKeys(credential, ["action"])) {
    parsedCredential = { action: "keep" };
  } else if (credential.action === "remove" && hasExactKeys(credential, ["action"])) {
    parsedCredential = { action: "remove" };
  } else if (
    credential.action === "store"
    && hasExactKeys(credential, ["action", "apiKey"])
    && validApiKey(credential.apiKey)
  ) {
    parsedCredential = { action: "store", apiKey: credential.apiKey };
  } else {
    throw new TypeError("Invalid model configuration credential action");
  }
  return {
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    contextLimit,
    maxOutputTokens,
    credential: parsedCredential,
  };
}

async function atomicWrite(
  targetPath: string,
  contents: string,
  kind: "config" | "auth",
  beforeRename?: (kind: "config" | "auth", temporaryPath: string, targetPath: string) => void | Promise<void>,
): Promise<void> {
  const directory = dirname(targetPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = resolve(directory, `.${basename(targetPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    await beforeRename?.(kind, temporaryPath, targetPath);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function publicStatus(effective: EffectiveModelConfig): PublicConfigStatus {
  return {
    runnable: effective.runnable,
    baseUrl: effective.baseUrl,
    model: effective.model,
    contextLimit: effective.contextLimit,
    maxOutputTokens: effective.maxOutputTokens,
    hasApiKey: effective.apiKey !== null,
    sources: effective.sources,
    issues: effective.issues,
  };
}

function ownStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function safeConnectionMessage(value: unknown, activeSecret: string, fallback: string): string {
  const source = typeof value === "string" ? value : ownStringProperty(value, "message");
  if (source === undefined) {
    return fallback;
  }
  const redacted = redactDiagnostic(source, [activeSecret]);
  return typeof redacted === "string" && redacted.length > 0
    ? redacted.slice(0, 1000)
    : fallback;
}

export class ModelConfigService {
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly options: DataPathOptions;
  private readonly beforeRename: NonNullable<ModelConfigServiceOptions["testHooks"]>["beforeRename"];
  private readonly connectionTester: ModelConnectionTester | undefined;

  constructor(options: ModelConfigServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.options = {
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    };
    this.beforeRename = options.testHooks?.beforeRename;
    this.connectionTester = options.connectionTester;
  }

  async loadEffective(): Promise<EffectiveModelConfig> {
    const paths = resolveDataPaths(this.options);
    const [config, auth] = await Promise.all([loadJson(paths.config), loadJson(paths.auth)]);
    const issues: ConfigIssue[] = [];
    if (config.invalid) {
      issues.push({ code: "invalid_config_file", field: "config" });
    }
    if (auth.invalid) {
      issues.push({ code: "invalid_auth_file", field: "auth" });
    }

    const selectedBaseUrl = selectOptional(this.env, "AWACODE_BASE_URL", config.value, "baseUrl");
    const selectedModel = selectOptional(this.env, "AWACODE_MODEL", config.value, "model");
    const selectedContextLimit = selectLimit(
      this.env,
      "AWACODE_CONTEXT_LIMIT",
      config.value,
      "contextLimit",
      DEFAULT_CONTEXT_LIMIT,
    );
    const selectedMaxOutputTokens = selectLimit(
      this.env,
      "AWACODE_MAX_OUTPUT_TOKENS",
      config.value,
      "maxOutputTokens",
      DEFAULT_MAX_OUTPUT_TOKENS,
    );
    const selectedApiKey = selectOptional(this.env, "AWACODE_API_KEY", auth.value, "apiKey");

    let baseUrl: string | null = null;
    if (selectedBaseUrl.source === "absent") {
      issues.push({ code: "missing_base_url", field: "baseUrl" });
    } else if (!validBaseUrl(selectedBaseUrl.value)) {
      issues.push({ code: "invalid_base_url", field: "baseUrl" });
    } else {
      baseUrl = selectedBaseUrl.value.trim();
    }

    let model: string | null = null;
    if (selectedModel.source === "absent") {
      issues.push({ code: "missing_model", field: "model" });
    } else if (!validModel(selectedModel.value)) {
      issues.push({ code: "invalid_model", field: "model" });
    } else {
      model = selectedModel.value.trim();
    }

    const parsedContextLimit = parseLimit(selectedContextLimit.value);
    const contextLimit = parsedContextLimit ?? DEFAULT_CONTEXT_LIMIT;
    if (parsedContextLimit === undefined) {
      issues.push({ code: "invalid_context_limit", field: "contextLimit" });
    }

    const parsedMaxOutputTokens = parseLimit(selectedMaxOutputTokens.value);
    const maxOutputTokens = parsedMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    if (parsedMaxOutputTokens === undefined) {
      issues.push({ code: "invalid_max_output_tokens", field: "maxOutputTokens" });
    } else if (parsedContextLimit !== undefined && parsedMaxOutputTokens >= parsedContextLimit) {
      issues.push({
        code: "max_output_tokens_not_less_than_context_limit",
        field: "maxOutputTokens",
      });
    }

    let apiKey: string | null = null;
    if (selectedApiKey.source === "absent") {
      issues.push({ code: "missing_api_key", field: "apiKey" });
    } else if (!validApiKey(selectedApiKey.value)) {
      issues.push({ code: "invalid_api_key", field: "apiKey" });
    } else {
      apiKey = selectedApiKey.value;
    }

    return {
      runnable: issues.length === 0,
      baseUrl,
      model,
      contextLimit,
      maxOutputTokens,
      apiKey,
      sources: {
        baseUrl: selectedBaseUrl.source as OptionalSource,
        model: selectedModel.source as OptionalSource,
        contextLimit: selectedContextLimit.source as LimitSource,
        maxOutputTokens: selectedMaxOutputTokens.source as LimitSource,
        apiKey: selectedApiKey.source as OptionalSource,
      },
      issues,
    };
  }

  async status(): Promise<PublicConfigStatus> {
    return publicStatus(await this.loadEffective());
  }

  async save(input: SaveModelConfigInput): Promise<PublicConfigStatus> {
    const validated = parseSaveModelConfigInput(input);
    const operation = inProcessSaveQueue.then(async () => {
      try {
        const paths = resolveDataPaths(this.options);
        await atomicWrite(paths.config, JSON.stringify({
          baseUrl: validated.baseUrl,
          model: validated.model,
          contextLimit: validated.contextLimit,
          maxOutputTokens: validated.maxOutputTokens,
        }), "config", this.beforeRename);
        if (validated.credential.action === "store") {
          await atomicWrite(
            paths.auth,
            JSON.stringify({ apiKey: validated.credential.apiKey }),
            "auth",
            this.beforeRename,
          );
        } else if (validated.credential.action === "remove") {
          await rm(paths.auth, { force: true });
        }
        return await this.status();
      } catch {
        throw new ModelConfigOperationError("save_failed", "Model configuration save failed");
      }
    });
    inProcessSaveQueue = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async testConnection(signal: AbortSignal): Promise<ModelConnectionTestResult> {
    if (signal.aborted) {
      throw new ModelConfigOperationError("cancelled", "Model connection test cancelled");
    }
    const effective = await this.loadEffective();
    if (!effective.runnable || effective.model === null || effective.apiKey === null) {
      throw new ModelConfigOperationError("not_configured", "Model configuration is not runnable");
    }
    if (this.connectionTester === undefined) {
      throw new ModelConfigOperationError("test_unavailable", "Model connection tester is unavailable");
    }
    try {
      const result = await this.connectionTester.test(effective, signal);
      if (signal.aborted) {
        throw new ModelConfigOperationError("cancelled", "Model connection test cancelled");
      }
      return {
        ok: true,
        message: safeConnectionMessage(result, effective.apiKey, "Model connection succeeded"),
        model: effective.model,
      };
    } catch (error) {
      if (signal.aborted || (error instanceof ModelConfigOperationError && error.kind === "cancelled")) {
        throw new ModelConfigOperationError("cancelled", "Model connection test cancelled");
      }
      return {
        ok: false,
        message: safeConnectionMessage(error, effective.apiKey, "Model connection test failed"),
        model: effective.model,
      };
    }
  }
}
