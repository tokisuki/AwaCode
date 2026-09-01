function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, fallback = "?"): string {
  return typeof value === "string" ? value : fallback;
}

function ordinal(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value + 1 : 0;
}

export function formatCoreNotification(method: string, paramsValue: unknown): string {
  const params = record(paramsValue) ?? {};
  switch (method) {
    case "agent/phase":
      return `\n[phase] ${text(params.phase)}\n`;
    case "stream/text":
      return text(params.delta, "");
    case "stream/commit":
      return `\n[commit] ${text(params.messageId)}\n`;
    case "tool/start":
      return `\n[tool ${ordinal(params.ordinal)}] ${text(params.name)} started\n`;
    case "tool/end":
      return `[tool ${ordinal(params.ordinal)}] ${text(params.name)} ${text(params.status)}: ${text(params.summary, "")}\n`;
    case "agent/status":
      return `\n[status] ${text(params.status)}: ${text(params.reason, "")}\n`;
    default:
      return "";
  }
}

function payloadText(value: unknown): string {
  const payload = record(value);
  return payload === undefined ? "" : text(payload.text, "");
}

function resultSummary(value: unknown): string {
  const result = record(value);
  return result === undefined ? "" : text(result.summary, "");
}

export function formatLoadedSession(value: unknown): string {
  const loaded = record(value);
  const session = record(loaded?.session);
  const messages = Array.isArray(loaded?.messages) ? loaded.messages : [];
  const toolCalls = Array.isArray(loaded?.toolCalls) ? loaded.toolCalls : [];
  const lines = [
    `Session ${text(session?.id)} — ${text(session?.title, "Untitled")} [${text(session?.status)}]`,
  ];
  for (const valueMessage of messages) {
    const message = record(valueMessage) ?? {};
    lines.push(`#${String(message.seq ?? "?")} ${text(message.role)}/${text(message.kind)} [${text(message.status)}]: ${payloadText(message.payload)}`);
  }
  for (const valueCall of toolCalls) {
    const call = record(valueCall) ?? {};
    lines.push(`tool ${ordinal(call.ordinal)} ${text(call.toolName)} [${text(call.status)}]: ${resultSummary(call.result)}`);
  }
  lines.push("");
  return lines.join("\n");
}
