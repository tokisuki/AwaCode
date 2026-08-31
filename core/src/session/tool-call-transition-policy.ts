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

const COMMON_API_KEY_VENDORS = [
  "openai",
  "anthropic",
  "azure",
  "azureopenai",
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
];

// Keep this policy closed: arbitrary words ending in Token/Secret are ordinary diagnostics.
const CREDENTIAL_LABELS: ReadonlySet<string> = new Set([
  "apikey",
  "accesskey",
  "privatekey",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "idtoken",
  "sessiontoken",
  "csrftoken",
  "clientsecret",
  "apisecret",
  "signingsecret",
  "webhooksecret",
  "token",
  "secret",
  "password",
  ...COMMON_API_KEY_VENDORS.map((vendor) => `${vendor}apikey`),
]);

interface AssignmentLabel {
  kind: "authorization" | "credential";
  quoted: boolean;
}

interface TextReplacement {
  start: number;
  end: number;
  text: string;
}

function isHorizontalWhitespace(character: string): boolean {
  return character === " " || character === "\t";
}

function isWhitespace(character: string): boolean {
  return /\s/.test(character);
}

function isBareLabelCharacter(character: string): boolean {
  // Separators belong to the full label, so matching cannot restart at a trailing Token/Secret word.
  return /[a-z0-9_\- \t]/i.test(character);
}

function normalizeCredentialLabel(label: string): string | null {
  const trimmed = label.trim();
  if (!/^[a-z0-9](?:[a-z0-9_\- \t]*[a-z0-9])?$/i.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/[\s_-]+/g, "").toLowerCase();
}

function readAssignmentLabel(value: string, separator: number): AssignmentLabel | null {
  let labelEnd = separator;
  while (labelEnd > 0 && isHorizontalWhitespace(value.charAt(labelEnd - 1))) {
    labelEnd -= 1;
  }

  let label: string;
  let quoted = false;
  if (labelEnd > 0 && value[labelEnd - 1] === '"') {
    const openingQuote = value.lastIndexOf('"', labelEnd - 2);
    if (openingQuote === -1) {
      return null;
    }
    label = value.slice(openingQuote + 1, labelEnd - 1);
    quoted = true;
  } else {
    let labelStart = labelEnd;
    while (labelStart > 0 && isBareLabelCharacter(value.charAt(labelStart - 1))) {
      labelStart -= 1;
    }
    while (labelStart < labelEnd && isHorizontalWhitespace(value.charAt(labelStart))) {
      labelStart += 1;
    }
    label = value.slice(labelStart, labelEnd);
  }

  const normalized = normalizeCredentialLabel(label);
  if (normalized === "authorization") {
    return { kind: "authorization", quoted };
  }
  return normalized !== null && CREDENTIAL_LABELS.has(normalized)
    ? { kind: "credential", quoted }
    : null;
}

function findClosingQuote(value: string, start: number, quote: string): number {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === "\r" || value[index] === "\n") {
      return -1;
    }
    if (value[index] === quote) {
      return index;
    }
  }
  return -1;
}

function authorizationSecretStart(value: string, start: number, end: number): number {
  const scheme = /^(?:bearer|basic)\s+/i.exec(value.slice(start, end));
  return scheme === null ? start : start + scheme[0].length;
}

function readAssignmentValue(
  value: string,
  separator: number,
  label: AssignmentLabel,
): TextReplacement | null {
  let valueStart = separator + 1;
  while (valueStart < value.length && isWhitespace(value.charAt(valueStart))) {
    valueStart += 1;
  }

  if (label.quoted) {
    if (value[separator] !== ":" || value[valueStart] !== '"') {
      return null;
    }
    const contentStart = valueStart + 1;
    const closingQuote = findClosingQuote(value, contentStart, '"');
    if (closingQuote === -1) {
      return null;
    }
    return {
      start: label.kind === "authorization"
        ? authorizationSecretStart(value, contentStart, closingQuote)
        : contentStart,
      end: closingQuote,
      text: "[REDACTED]",
    };
  }

  const quote = value[valueStart];
  if (quote === '"' || quote === "'") {
    const closingQuote = findClosingQuote(value, valueStart + 1, quote);
    if (closingQuote === -1) {
      return null;
    }
    const contentStart = valueStart + 1;
    const secretStart = label.kind === "authorization"
      ? authorizationSecretStart(value, contentStart, closingQuote)
      : contentStart;
    const scheme = value.slice(contentStart, secretStart).trim();
    return {
      start: valueStart,
      end: closingQuote + 1,
      text: scheme === "" ? "[REDACTED]" : `${scheme} [REDACTED]`,
    };
  }

  const secretStart = label.kind === "authorization"
    ? authorizationSecretStart(value, valueStart, value.length)
    : valueStart;
  let valueEnd = secretStart;
  while (valueEnd < value.length && !/[;\s,}\]]/.test(value.charAt(valueEnd))) {
    valueEnd += 1;
  }
  return secretStart === valueEnd
    ? null
    : { start: secretStart, end: valueEnd, text: "[REDACTED]" };
}

function redactCredentialAssignments(value: string): string {
  let result = "";
  let unchangedStart = 0;
  let searchStart = 0;
  while (searchStart < value.length) {
    const separatorOffset = value.slice(searchStart).search(/[:=]/);
    if (separatorOffset === -1) {
      break;
    }
    const separator = searchStart + separatorOffset;
    const label = readAssignmentLabel(value, separator);
    const replacement = label === null ? null : readAssignmentValue(value, separator, label);
    if (replacement === null) {
      searchStart = separator + 1;
      continue;
    }
    result += value.slice(unchangedStart, replacement.start);
    result += replacement.text;
    unchangedStart = replacement.end;
    searchStart = Math.max(separator + 1, replacement.end);
  }
  return result + value.slice(unchangedStart);
}

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
  return redactCredentialAssignments(withoutControls).slice(0, 4000);
}
