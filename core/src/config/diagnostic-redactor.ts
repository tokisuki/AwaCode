import {
  isCredentialDiagnosticLabel,
  sanitizeToolCallErrorText,
} from "../session/tool-call-transition-policy.ts";

const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const TRUNCATED = "[Truncated]";
const MAX_DEPTH = 8;
const MAX_ENTRIES = 100;
const MAX_CHARACTERS = 12000;
const MAX_KEY_CHARACTERS = 256;

interface RedactionBudget {
  entries: number;
  characters: number;
  truncated: boolean;
}

function consumeString(value: string, budget: RedactionBudget): string {
  if (value.length <= budget.characters) {
    budget.characters -= value.length;
    return value;
  }
  budget.truncated = true;
  const available = Math.max(0, budget.characters - TRUNCATED.length);
  budget.characters = 0;
  return `${value.slice(0, available)}${TRUNCATED}`;
}

function redactString(value: string, activeSecrets: readonly string[], budget: RedactionBudget): string {
  let redacted = value;
  for (const secret of activeSecrets) {
    redacted = redacted.split(secret).join(REDACTED);
  }
  return consumeString(sanitizeToolCallErrorText(redacted) ?? "", budget);
}

function redactValue(
  value: unknown,
  activeSecrets: readonly string[],
  ancestors: Set<object>,
  budget: RedactionBudget,
  depth: number,
): unknown {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value, activeSecrets, budget);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : consumeString(String(value), budget);
  }
  if (typeof value !== "object") {
    return consumeString("[Unsupported]", budget);
  }
  if (ancestors.has(value)) {
    return consumeString(CIRCULAR, budget);
  }
  if (depth >= MAX_DEPTH || budget.entries <= 0 || budget.characters <= 0) {
    budget.truncated = true;
    return TRUNCATED;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      const limit = Math.min(value.length, budget.entries);
      for (let index = 0; index < limit; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor !== undefined && descriptor.enumerable && "value" in descriptor) {
          budget.entries -= 1;
          output.push(redactValue(descriptor.value, activeSecrets, ancestors, budget, depth + 1));
        } else {
          output.push(consumeString("[Unavailable]", budget));
        }
      }
      if (limit < value.length || budget.truncated) {
        output.push(TRUNCATED);
      }
      return output;
    }

    const output: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        continue;
      }
      if (budget.entries <= 0 || budget.characters <= 0) {
        budget.truncated = true;
        break;
      }
      if (key.length > MAX_KEY_CHARACTERS) {
        budget.truncated = true;
        continue;
      }
      budget.entries -= 1;
      budget.characters -= key.length;
      output[key] = isCredentialDiagnosticLabel(key)
        ? consumeString(REDACTED, budget)
        : redactValue(descriptor.value, activeSecrets, ancestors, budget, depth + 1);
    }
    if (budget.truncated && !Object.prototype.hasOwnProperty.call(output, "truncated")) {
      output.truncated = TRUNCATED;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

export function redactDiagnostic(value: unknown, activeSecrets: readonly string[] = []): unknown {
  const secrets = [...new Set(activeSecrets.filter((secret) => secret.length > 0))]
    .sort((left, right) => right.length - left.length);
  return redactValue(value, secrets, new Set(), {
    entries: MAX_ENTRIES,
    characters: MAX_CHARACTERS,
    truncated: false,
  }, 0);
}
