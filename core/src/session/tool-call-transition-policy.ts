export type ToolCallStatus =
  | "pending"
  | "awaiting_approval"
  | "running"
  | "success"
  | "failure"
  | "denied"
  | "interrupted";

const LEGAL_TRANSITIONS: Readonly<Record<ToolCallStatus, ReadonlySet<ToolCallStatus>>> = {
  pending: new Set(["running", "awaiting_approval", "failure", "interrupted"]),
  awaiting_approval: new Set(["running", "denied", "interrupted"]),
  running: new Set(["success", "failure", "interrupted"]),
  success: new Set(),
  failure: new Set(),
  denied: new Set(),
  interrupted: new Set(),
};

const TERMINAL_STATUSES: ReadonlySet<ToolCallStatus> = new Set([
  "success",
  "failure",
  "denied",
  "interrupted",
]);

const API_KEY_LABEL_PATTERN = String.raw`api[\s_-]*key`;
const COMMON_API_KEY_VENDOR_PATTERN = [
  "openai",
  "anthropic",
  String.raw`azure(?:[\s_-]*openai)?`,
  "google",
  "gemini",
  "github",
  "gitlab",
  "aws",
  "stripe",
  "cohere",
  "mistral",
  "groq",
  "openrouter",
  "xai",
  "deepseek",
].join("|");

// Keep this policy closed: arbitrary words ending in Token/Secret are ordinary diagnostics.
const CREDENTIAL_LABEL_PATTERN = [
  String.raw`(?:${COMMON_API_KEY_VENDOR_PATTERN})[\s_-]*${API_KEY_LABEL_PATTERN}`,
  API_KEY_LABEL_PATTERN,
  String.raw`(?:access|private)[\s_-]*key`,
  String.raw`(?:access|refresh|auth|bearer|id|session|csrf)[\s_-]*token`,
  String.raw`(?:client|api|signing|webhook)[\s_-]*secret`,
  "token",
  "secret",
  "password",
].join("|");

const JSON_AUTHORIZATION_ASSIGNMENT =
  /("authorization"\s*:\s*")(?:(bearer|basic)\s+)?[^"\r\n]*"/gi;
const JSON_CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`("(?:${CREDENTIAL_LABEL_PATTERN})"\s*:\s*")[^"\r\n]*"`,
  "gi",
);
const AUTHORIZATION_ASSIGNMENT =
  /(?<![a-z0-9_-])(\bauthorization\b\s*[:=]\s*)(?:(bearer|basic)\s+)?(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^;\s,}\]\r\n]+))/gi;
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`(?<![a-z0-9_-])(\b(?:${CREDENTIAL_LABEL_PATTERN})\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^;\s,}\]\r\n]+)`,
  "gi",
);

export function isLegalToolCallTransition(from: ToolCallStatus, to: ToolCallStatus): boolean {
  return LEGAL_TRANSITIONS[from].has(to);
}

export function isTerminalToolCallStatus(status: ToolCallStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function assertStrictJsonValue(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError("terminal tool-call result must be strict JSON without numeric normalization");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError("terminal tool-call result must contain only JSON values");
  }
  if (ancestors.has(value)) {
    throw new TypeError("terminal tool-call result must not contain cycles");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError("terminal tool-call result arrays must use the standard JSON shape");
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError(
            "terminal tool-call result arrays must contain enumerable data properties for every element",
          );
        }
        assertStrictJsonValue(descriptor.value, ancestors);
      }
      if (Reflect.ownKeys(value).some((key) => {
        if (key === "length") {
          return false;
        }
        if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key)) {
          return true;
        }
        const index = Number(key);
        return !Number.isSafeInteger(index) || index >= value.length;
      })) {
        throw new TypeError("terminal tool-call result arrays must not contain non-index properties");
      }
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("terminal tool-call result objects must be plain JSON objects");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError("terminal tool-call result objects must not contain symbol keys");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("terminal tool-call result objects must contain enumerable data properties only");
      }
      assertStrictJsonValue(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function assertStrictTerminalToolCallResult(value: unknown): void {
  if (value === null) {
    throw new TypeError("terminal tool-call transition requires a non-null JSON result");
  }
  assertStrictJsonValue(value, new Set());
}

export function stringifyTerminalToolCallResult(value: unknown): string {
  assertStrictTerminalToolCallResult(value);
  return JSON.stringify(value);
}

export function sanitizeToolCallErrorText(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const withoutControls = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  const withoutJsonAuthorization = withoutControls.replace(
    JSON_AUTHORIZATION_ASSIGNMENT,
    (_match, prefix: string, scheme: string | undefined) =>
      `${prefix}${scheme === undefined ? "" : `${scheme} `}[REDACTED]"`,
  );
  const withoutJsonCredentials = withoutJsonAuthorization.replace(
    JSON_CREDENTIAL_ASSIGNMENT,
    "$1[REDACTED]\"",
  );
  const withoutAuthorization = withoutJsonCredentials.replace(
    AUTHORIZATION_ASSIGNMENT,
    (
      _match,
      label: string,
      explicitScheme: string | undefined,
      doubleQuotedValue: string | undefined,
      singleQuotedValue: string | undefined,
      unquotedValue: string | undefined,
    ) => {
      const valueText = doubleQuotedValue ?? singleQuotedValue ?? unquotedValue ?? "";
      const embeddedScheme = /^(bearer|basic)\s+/i.exec(valueText)?.[1];
      const scheme = explicitScheme ?? embeddedScheme;
      return `${label}${scheme === undefined ? "" : `${scheme} `}[REDACTED]`;
    },
  );
  return withoutAuthorization.replace(CREDENTIAL_ASSIGNMENT, "$1[REDACTED]").slice(0, 4000);
}
