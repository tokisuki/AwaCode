import { createHash } from "node:crypto";

import type { FunctionToolDefinition, ModelMessage } from "../llm/types.ts";
import type { MemoryTexts } from "../memory/memory-store.ts";
import type { SessionStore } from "../persistence/session-store.ts";
import type { ProviderHistoryEntry } from "../session/history.ts";

export class ContextBudgetError extends Error {
  readonly code = "required_context_too_large" as const;

  constructor() {
    super("Required context does not fit within the configured model context window.");
    this.name = "ContextBudgetError";
  }
}

export class ContextCompressionError extends Error {
  readonly code: "context_compression_failed" | "context_overflow_after_compression";

  constructor(code: ContextCompressionError["code"], options: ErrorOptions = {}) {
    super(code === "context_compression_failed"
      ? "Context compression failed; increase the context limit or start a new session."
      : "The model context still overflowed after one compression retry; increase the context limit or start a new session.", options);
    this.name = "ContextCompressionError";
    this.code = code;
  }
}

export interface ContextSourceSnapshotHook {
  readonly name: string;
  read(): unknown | Promise<unknown>;
}

export interface ContextManagerOptions {
  readonly sourceSnapshotHooks?: readonly ContextSourceSnapshotHook[];
  readonly summaryGenerator?: (request: SummaryRequest) => Promise<string>;
}

export interface SummaryRequest {
  readonly previousSummary: string | null;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

export const SUMMARY_SYSTEM_PROMPT = "Generate a structured rolling summary of the conversation. Cover: goal; constraints and decisions; completed work; current state; blockers; next steps; relevant files. Replace, do not merely append to, any previous summary. Do not call tools.";

export interface BuildContextInput {
  readonly sessionId: string;
  readonly history: readonly ProviderHistoryEntry[];
  readonly currentUserMessageId: string;
  readonly protectedMessageIds?: readonly string[];
  readonly systemText: string;
  readonly transientSystemText?: string;
  readonly tools: readonly FunctionToolDefinition[];
  readonly contextLimit: number;
  readonly maxOutputTokens: number;
  readonly memory?: MemoryTexts | null;
  readonly signal?: AbortSignal;
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
  readonly seq: number;
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
    seq: entry.seq,
    messages,
    tokens: estimateTextTokens(JSON.stringify(messages)),
  };
}

function fixedTokens(messages: readonly ModelMessage[], tools: readonly FunctionToolDefinition[]): number {
  return estimateTextTokens(JSON.stringify(messages)) + estimateTextTokens(JSON.stringify(tools));
}

function summaryMessages(previousSummary: string | null, messages: readonly ModelMessage[]): readonly ModelMessage[] {
  return [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    ...(previousSummary === null
      ? []
      : [{ role: "system" as const, content: `Previous rolling summary:\n${previousSummary}` }]),
    ...messages,
  ];
}

function summaryBlockMessages(block: ModelBlock): readonly ModelMessage[] {
  return block.messages.map((message): ModelMessage =>
    message.role === "tool"
      ? { ...message, content: [...message.content].slice(0, 2_000).join("") }
      : message);
}

function memoryFromSnapshot(value: unknown): MemoryTexts | undefined {
  if (typeof value !== "object" || value === null || !("memory" in value)) return undefined;
  const memory = (value as { memory?: unknown }).memory;
  if (
    typeof memory !== "object"
    || memory === null
    || !("global" in memory)
    || !("project" in memory)
    || typeof memory.global !== "string"
    || typeof memory.project !== "string"
  ) return undefined;
  return { global: memory.global, project: memory.project };
}

export class ContextManager {
  private readonly store: SessionStore;
  private readonly sourceSnapshotHooks: readonly ContextSourceSnapshotHook[];
  private readonly summaryGenerator: ContextManagerOptions["summaryGenerator"];

  constructor(store: SessionStore, options: ContextManagerOptions = {}) {
    this.store = store;
    this.sourceSnapshotHooks = options.sourceSnapshotHooks ?? [];
    this.summaryGenerator = options.summaryGenerator;
  }

  async build(input: BuildContextInput): Promise<BuiltContext> {
    return this.buildInternal(input, true);
  }

  async compressForOverflow(input: BuildContextInput): Promise<boolean> {
    if (this.summaryGenerator === undefined) {
      return false;
    }
    const existing = this.store.loadContextSnapshot(input.sessionId);
    const cutoff = existing?.summary === null || existing?.summary === undefined ? 0 : existing.summaryUptoSeq;
    const protectedIds = new Set([input.currentUserMessageId, ...(input.protectedMessageIds ?? [])]);
    const candidates = input.history
      .filter((entry) => entry.seq > cutoff && !protectedIds.has(entry.messageId))
      .map(entryBlock);
    if (candidates.length === 0) {
      return false;
    }
    const systemContextSha256 = createHash("sha256").update(input.systemText).digest("hex");
    const existingSource = typeof existing?.sourceSnapshot === "object" && existing.sourceSnapshot !== null
      ? existing.sourceSnapshot as Record<string, unknown>
      : {};
    const previousSystem = typeof existingSource.systemContext === "object" && existingSource.systemContext !== null
      ? existingSource.systemContext as { sha256?: unknown }
      : undefined;
    const baseline = existing === null || previousSystem?.sha256 !== systemContextSha256
      ? input.systemText
      : existing.baseline;
    const sourceSnapshot = existing?.sourceSnapshot ?? {};
    await this.compressBlocks(input, existing?.summary ?? null, baseline, sourceSnapshot, candidates);
    return true;
  }

  private async buildInternal(input: BuildContextInput, allowCompression: boolean): Promise<BuiltContext> {
    const usable = input.contextLimit - input.maxOutputTokens;
    const recentBudget = recentContextBudget(input.contextLimit, input.maxOutputTokens);
    const existing = this.store.loadContextSnapshot(input.sessionId);
    const systemContextSha256 = createHash("sha256").update(input.systemText).digest("hex");
    const existingSource = typeof existing?.sourceSnapshot === "object" && existing.sourceSnapshot !== null
      ? existing.sourceSnapshot as Record<string, unknown>
      : {};
    const previousSystem = typeof existingSource.systemContext === "object" && existingSource.systemContext !== null
      ? existingSource.systemContext as { sha256?: unknown }
      : undefined;
    const baseline = existing === null || previousSystem?.sha256 !== systemContextSha256
      ? input.systemText
      : existing.baseline;
    const effectiveMemory = input.memory === null
      ? memoryFromSnapshot(existing?.sourceSnapshot)
      : input.memory;
    const prefix: ModelMessage[] = [{ role: "system", content: baseline }];
    if (effectiveMemory?.global.length) {
      prefix.push({ role: "system", content: `Global memory:\n${effectiveMemory.global}` });
    }
    if (effectiveMemory?.project.length) {
      prefix.push({ role: "system", content: `Project memory (takes priority over global memory):\n${effectiveMemory.project}` });
    }
    if (existing?.summary !== null && existing?.summary !== undefined && existing.summary.length > 0) {
      prefix.push({ role: "system", content: `Conversation summary:\n${existing.summary}` });
    }
    const suffix: ModelMessage[] = input.transientSystemText === undefined
      ? []
      : [{ role: "system", content: input.transientSystemText }];
    const sourceSnapshot: Record<string, unknown> = {};
    for (const hook of this.sourceSnapshotHooks) {
      try {
        sourceSnapshot[hook.name] = await hook.read();
      } catch {
        const previous = typeof existing?.sourceSnapshot === "object" && existing.sourceSnapshot !== null
          ? existing.sourceSnapshot as Record<string, unknown>
          : {};
        if (Object.hasOwn(previous, hook.name)) {
          sourceSnapshot[hook.name] = previous[hook.name];
        }
      }
    }
    const contentSource = input.memory === null
      ? existing?.sourceSnapshot ?? {}
      : input.memory === undefined
        ? this.sourceSnapshotHooks.length === 0 ? existing?.sourceSnapshot ?? {} : sourceSnapshot
        : {
            ...(this.sourceSnapshotHooks.length === 0 ? {} : sourceSnapshot),
            memory: {
              global: input.memory.global,
              project: input.memory.project,
              globalSha256: createHash("sha256").update(input.memory.global).digest("hex"),
              projectSha256: createHash("sha256").update(input.memory.project).digest("hex"),
            },
          };
    const persistedSource = {
      ...(typeof contentSource === "object" && contentSource !== null ? contentSource as Record<string, unknown> : {}),
      systemContext: { sha256: systemContextSha256 },
    };
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
    const protectedIds = new Set([input.currentUserMessageId, ...(input.protectedMessageIds ?? [])]);
    const blocks = input.history
      .filter((entry) => entry.seq > summaryCutoff || protectedIds.has(entry.messageId))
      .map(entryBlock);
    const requiredIndices = blocks.flatMap((block, index) => protectedIds.has(block.messageId) ? [index] : []);
    if (requiredIndices.length !== protectedIds.size) {
      throw new ContextBudgetError();
    }
    const availableForRecent = Math.min(recentBudget, usable - fixedTokens([...prefix, ...suffix], input.tools));
    const requiredTokens = requiredIndices.reduce((total, index) => total + blocks[index]!.tokens, 0);
    if (availableForRecent < 0 || requiredTokens > availableForRecent) {
      throw new ContextBudgetError();
    }

    const selected = new Set<number>(requiredIndices);
    let used = requiredTokens;
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
    const evictedBlocks = blocks.filter((block, index) => !selected.has(index) && !protectedIds.has(block.messageId));
    if (allowCompression && evictedBlocks.length > 0 && this.summaryGenerator !== undefined) {
      await this.compressBlocks(
        input,
        existing?.summary ?? null,
        baseline,
        persistedSource,
        evictedBlocks,
      );
      return this.buildInternal(input, false);
    }
    const messages = [...prefix, ...selectedBlocks.flatMap((block) => block.messages), ...suffix];
    return {
      messages,
      selectedMessageIds: selectedBlocks.map((block) => block.messageId),
      recentBudget,
      estimatedTokens: fixedTokens(messages, input.tools),
      sourceSnapshot: persistedSource as Readonly<Record<string, unknown>>,
    };
  }

  private async compressBlocks(
    input: BuildContextInput,
    previousSummary: string | null,
    baseline: string,
    sourceSnapshot: unknown,
    blocks: readonly ModelBlock[],
  ): Promise<void> {
    try {
      const maxOutputTokens = Math.min(input.maxOutputTokens, 4_096);
      let nextBlock = 0;
      let replacementSummary = previousSummary;
      let summaryUptoSeq = 0;
      while (nextBlock < blocks.length) {
        const batchMessages: ModelMessage[] = [];
        let batchEnd = nextBlock;
        while (batchEnd < blocks.length) {
          const candidateMessages = [...batchMessages, ...summaryBlockMessages(blocks[batchEnd]!)];
          const requestTokens = estimateTextTokens(JSON.stringify(summaryMessages(replacementSummary, candidateMessages)))
            + maxOutputTokens;
          if (requestTokens > input.contextLimit) {
            break;
          }
          batchMessages.push(...summaryBlockMessages(blocks[batchEnd]!));
          batchEnd += 1;
        }
        if (batchEnd === nextBlock) {
          throw new ContextCompressionError("context_compression_failed", {
            cause: new Error("A required atomic summary block does not fit within the provider context limit."),
          });
        }
        const generated = (await this.summaryGenerator!({
          previousSummary: replacementSummary,
          messages: batchMessages,
          maxOutputTokens,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })).trim();
        if (generated.length === 0) {
          throw new Error("empty summary");
        }
        replacementSummary = generated;
        summaryUptoSeq = Math.max(...blocks.slice(nextBlock, batchEnd).map((block) => block.seq));
        nextBlock = batchEnd;
      }
      this.store.saveContextSnapshot({
        sessionId: input.sessionId,
        baseline,
        sourceSnapshot,
        baselineSeq: summaryUptoSeq,
        summary: replacementSummary,
        summaryUptoSeq,
      });
    } catch (error) {
      if (error instanceof ContextCompressionError) throw error;
      throw new ContextCompressionError("context_compression_failed", { cause: error });
    }
  }
}
