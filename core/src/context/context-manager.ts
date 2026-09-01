import type { FunctionToolDefinition, ModelMessage } from "../llm/types.ts";
import type { SessionStore } from "../persistence/session-store.ts";
import type { ProviderHistoryEntry } from "../session/history.ts";

export class ContextBudgetError extends Error {
  readonly code = "required_context_too_large" as const;

  constructor() {
    super("Required context does not fit within the configured model context window.");
    this.name = "ContextBudgetError";
  }
}

export interface ContextSourceSnapshotHook {
  readonly name: string;
  read(): unknown | Promise<unknown>;
}

export interface ContextManagerOptions {
  readonly sourceSnapshotHooks?: readonly ContextSourceSnapshotHook[];
}

export interface BuildContextInput {
  readonly sessionId: string;
  readonly history: readonly ProviderHistoryEntry[];
  readonly currentUserMessageId: string;
  readonly systemText: string;
  readonly transientSystemText?: string;
  readonly tools: readonly FunctionToolDefinition[];
  readonly contextLimit: number;
  readonly maxOutputTokens: number;
}

export interface BuiltContext {
  readonly messages: readonly ModelMessage[];
  readonly selectedMessageIds: readonly string[];
  readonly recentBudget: number;
  readonly estimatedTokens: number;
  readonly sourceSnapshot: Readonly<Record<string, unknown>>;
}

interface ModelBlock {
  readonly messageId: string;
  readonly messages: readonly ModelMessage[];
  readonly tokens: number;
}

export function estimateTextTokens(value: string): number {
  let units = 0;
  for (const codePoint of value) {
    units += codePoint.codePointAt(0)! <= 0x7f ? 0.25 : 1;
  }
  return Math.ceil(units);
}

export function recentContextBudget(contextLimit: number, maxOutputTokens: number): number {
  const usable = contextLimit - maxOutputTokens;
  return Math.min(15_000, Math.max(2_000, Math.floor(usable * 0.25)));
}

function payloadText(payload: unknown): string {
  if (
    typeof payload === "object"
    && payload !== null
    && "text" in payload
    && typeof (payload as { text?: unknown }).text === "string"
  ) {
    return (payload as { text: string }).text;
  }
  return JSON.stringify(payload) ?? "";
}

function entryBlock(entry: ProviderHistoryEntry): ModelBlock {
  let messages: readonly ModelMessage[];
  if (entry.type === "message") {
    const content = payloadText(entry.payload);
    messages = entry.role === "assistant"
      ? [{ role: "assistant", content, toolCalls: [] }]
      : [{ role: entry.role, content }];
  } else {
    messages = [
      {
        role: "assistant",
        content: payloadText(entry.payload),
        toolCalls: entry.toolCalls.map((call) => ({
          id: call.callId,
          name: call.toolName,
          arguments: call.inputText,
        })),
      },
      ...entry.toolResults.map((result) => ({
        role: "tool" as const,
        toolCallId: result.callId,
        content: JSON.stringify(result.result),
      })),
    ];
  }
  return {
    messageId: entry.messageId,
    messages,
    tokens: estimateTextTokens(JSON.stringify(messages)),
  };
}

function fixedTokens(messages: readonly ModelMessage[], tools: readonly FunctionToolDefinition[]): number {
  return estimateTextTokens(JSON.stringify(messages)) + estimateTextTokens(JSON.stringify(tools));
}

export class ContextManager {
  private readonly store: SessionStore;
  private readonly sourceSnapshotHooks: readonly ContextSourceSnapshotHook[];

  constructor(store: SessionStore, options: ContextManagerOptions = {}) {
    this.store = store;
    this.sourceSnapshotHooks = options.sourceSnapshotHooks ?? [];
  }

  async build(input: BuildContextInput): Promise<BuiltContext> {
    const usable = input.contextLimit - input.maxOutputTokens;
    const recentBudget = recentContextBudget(input.contextLimit, input.maxOutputTokens);
    const existing = this.store.loadContextSnapshot(input.sessionId);
    const baseline = existing?.baseline ?? input.systemText;
    const prefix: ModelMessage[] = [{ role: "system", content: baseline }];
    if (existing?.summary !== null && existing?.summary !== undefined && existing.summary.length > 0) {
      prefix.push({ role: "system", content: `Conversation summary:\n${existing.summary}` });
    }
    const suffix: ModelMessage[] = input.transientSystemText === undefined
      ? []
      : [{ role: "system", content: input.transientSystemText }];
    const sourceSnapshot: Record<string, unknown> = {};
    for (const hook of this.sourceSnapshotHooks) {
      sourceSnapshot[hook.name] = await hook.read();
    }
    const persistedSource = this.sourceSnapshotHooks.length === 0
      ? existing?.sourceSnapshot ?? {}
      : sourceSnapshot;
    this.store.saveContextSnapshot({
      sessionId: input.sessionId,
      baseline,
      sourceSnapshot: persistedSource,
      baselineSeq: existing?.baselineSeq ?? 0,
      summary: existing?.summary ?? null,
      summaryUptoSeq: existing?.summaryUptoSeq ?? 0,
    });

    const summaryCutoff = existing?.summary === null || existing?.summary === undefined
      ? 0
      : existing.summaryUptoSeq;
    const blocks = input.history
      .filter((entry) => entry.seq > summaryCutoff || entry.messageId === input.currentUserMessageId)
      .map(entryBlock);
    const requiredIndex = blocks.findIndex((block) => block.messageId === input.currentUserMessageId);
    if (requiredIndex === -1) {
      throw new ContextBudgetError();
    }
    const availableForRecent = Math.min(recentBudget, usable - fixedTokens([...prefix, ...suffix], input.tools));
    const required = blocks[requiredIndex]!;
    if (availableForRecent < 0 || required.tokens > availableForRecent) {
      throw new ContextBudgetError();
    }

    const selected = new Set<number>([requiredIndex]);
    let used = required.tokens;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (selected.has(index)) {
        continue;
      }
      const block = blocks[index]!;
      if (used + block.tokens <= availableForRecent) {
        selected.add(index);
        used += block.tokens;
      } else {
        break;
      }
    }
    const selectedBlocks = blocks.filter((_, index) => selected.has(index));
    const messages = [...prefix, ...selectedBlocks.flatMap((block) => block.messages), ...suffix];
    return {
      messages,
      selectedMessageIds: selectedBlocks.map((block) => block.messageId),
      recentBudget,
      estimatedTokens: fixedTokens(messages, input.tools),
      sourceSnapshot: persistedSource as Readonly<Record<string, unknown>>,
    };
  }
}
