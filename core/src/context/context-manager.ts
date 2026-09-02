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
  return contextLimit - maxOutputTokens;
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

function payloadReasoningContent(payload: unknown): string | undefined {
  if (
    typeof payload === "object"
    && payload !== null
    && "reasoningContent" in payload
    && typeof (payload as { reasoningContent?: unknown }).reasoningContent === "string"
  ) {
    return (payload as { reasoningContent: string }).reasoningContent;
  }
  return undefined;
}

function entryBlock(entry: ProviderHistoryEntry): ModelBlock {
  let messages: readonly ModelMessage[];
  if (entry.type === "message") {
    const content = payloadText(entry.payload);
    const reasoningContent = payloadReasoningContent(entry.payload);
    messages = entry.role === "assistant"
      ? [{
        role: "assistant",
        content,
        ...(reasoningContent === undefined ? {} : { reasoningContent }),
        toolCalls: [],
      }]
      : [{ role: entry.role, content }];
  } else {
    const reasoningContent = payloadReasoningContent(entry.payload);
    messages = [
      {
        role: "assistant",
        content: payloadText(entry.payload),
        ...(reasoningContent === undefined ? {} : { reasoningContent }),
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

function systemContextUpdate(entry: ProviderHistoryEntry): { systemText: string; sha256: string } | null {
  if (entry.type !== "message" || entry.role !== "system" || entry.kind !== "system_context_update"
    || typeof entry.payload !== "object" || entry.payload === null) return null;
  const payload = entry.payload as { systemText?: unknown; sha256?: unknown };
  return typeof payload.systemText === "string" && typeof payload.sha256 === "string"
    ? { systemText: payload.systemText, sha256: payload.sha256 }
    : null;
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
    return this.buildInternal(input);
  }

  async compressForOverflow(input: BuildContextInput): Promise<boolean> {
    if (this.summaryGenerator === undefined) {
      return false;
    }
    const existing = this.store.loadContextSnapshot(input.sessionId);
    const cutoff = existing?.summary === null || existing?.summary === undefined ? 0 : existing.summaryUptoSeq;
    const protectedIds = new Set([input.currentUserMessageId, ...(input.protectedMessageIds ?? [])]);
    const effectiveHistory = this.withStoredSystemUpdates(input);
    const protectedEntries = effectiveHistory.filter((entry) => protectedIds.has(entry.messageId));
    if (protectedEntries.length !== protectedIds.size) {
      throw new ContextBudgetError();
    }
    const protectedBarrierSeq = Math.min(
      ...protectedEntries
        .filter((entry) => entry.messageId !== input.currentUserMessageId)
        .map((entry) => entry.seq),
      Number.POSITIVE_INFINITY,
    );
    const candidates = effectiveHistory
      .filter((entry) => entry.seq > cutoff && entry.seq < protectedBarrierSeq)
      .map(entryBlock);
    if (candidates.length === 0) {
      throw new ContextBudgetError();
    }
    const baseline = existing?.baseline ?? input.systemText;
    const sourceSnapshot = existing?.sourceSnapshot ?? {};
    await this.compressBlocks(input, existing?.summary ?? null, baseline, sourceSnapshot, candidates);
    return true;
  }

  private async buildInternal(input: BuildContextInput): Promise<BuiltContext> {
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
    const baseline = existing?.baseline ?? input.systemText;
    const effectiveMemory = input.memory === null
      ? memoryFromSnapshot(existing?.sourceSnapshot)
      : input.memory;
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
    const snapshotInput = {
      sessionId: input.sessionId,
      baseline,
      sourceSnapshot: persistedSource,
      baselineSeq: existing?.baselineSeq ?? 0,
      summary: existing?.summary ?? null,
      summaryUptoSeq: existing?.summaryUptoSeq ?? 0,
    };
    const systemContextChanged = existing !== null && (previousSystem?.sha256 === undefined
      ? input.systemText !== existing.baseline
      : previousSystem.sha256 !== systemContextSha256);
    if (systemContextChanged) {
      this.store.appendSystemContextUpdate({ ...snapshotInput, systemText: input.systemText, sha256: systemContextSha256 });
    } else {
      this.store.saveContextSnapshot(snapshotInput);
    }

    const effectiveHistory = this.withStoredSystemUpdates(input);
    const pendingSystemUpdates = effectiveHistory
      .filter((entry) => entry.seq > (existing?.baselineSeq ?? 0))
      .flatMap((entry) => {
        const update = systemContextUpdate(entry);
        return update === null ? [] : [update];
      });
    const prefix: ModelMessage[] = [
      { role: "system", content: baseline },
      ...pendingSystemUpdates.map((update): ModelMessage => ({
        role: "system", content: `System context update:\n${update.systemText}`,
      })),
    ];
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

    const summaryCutoff = existing?.summary === null || existing?.summary === undefined
      ? 0
      : existing.summaryUptoSeq;
    const protectedIds = new Set([input.currentUserMessageId, ...(input.protectedMessageIds ?? [])]);
    const blocks = effectiveHistory
      .filter((entry) => systemContextUpdate(entry) === null)
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
    if (evictedBlocks.length > 0 && this.summaryGenerator !== undefined) {
      const compressiblePrefix: ModelBlock[] = [];
      for (const [index, block] of blocks.entries()) {
        if (selected.has(index)) {
          if (block.messageId !== input.currentUserMessageId) break;
          if (block.seq <= summaryCutoff) continue;
        }
        compressiblePrefix.push(block);
      }
      if (compressiblePrefix.length === 0 || !compressiblePrefix.some((block) => evictedBlocks.includes(block))) {
        throw new ContextBudgetError();
      }
      const maxEvictedSeq = compressiblePrefix.at(-1)!.seq;
      const systemUpdateBlocks = effectiveHistory
        .filter((entry) => entry.seq > summaryCutoff && entry.seq <= maxEvictedSeq && systemContextUpdate(entry) !== null)
        .map(entryBlock);
      await this.compressBlocks(
        input,
        existing?.summary ?? null,
        baseline,
        persistedSource,
        [...compressiblePrefix, ...systemUpdateBlocks].sort((left, right) => left.seq - right.seq),
      );
      return this.buildInternal(input);
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

  private withStoredSystemUpdates(input: BuildContextInput): ProviderHistoryEntry[] {
    const history = new Map(input.history.map((entry) => [entry.messageId, entry]));
    for (const message of this.store.loadSession(input.sessionId).messages) {
      if (message.status !== "complete" || message.role !== "system" || message.kind !== "system_context_update"
        || history.has(message.id)) continue;
      history.set(message.id, {
        type: "message",
        messageId: message.id,
        seq: message.seq,
        role: "system",
        kind: message.kind,
        payload: message.payload,
      });
    }
    return [...history.values()].sort((left, right) => left.seq - right.seq);
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
      const storedUpdates = this.store.loadSession(input.sessionId).messages
        .filter((message) => message.status === "complete" && message.role === "system"
          && message.kind === "system_context_update" && message.seq <= summaryUptoSeq)
        .flatMap((message) => {
          const entry: ProviderHistoryEntry = {
            type: "message", messageId: message.id, seq: message.seq, role: "system",
            kind: message.kind, payload: message.payload,
          };
          const update = systemContextUpdate(entry);
          return update === null ? [] : [{ seq: message.seq, ...update }];
        });
      const promoted = storedUpdates.at(-1);
      this.store.saveContextSnapshot({
        sessionId: input.sessionId,
        baseline: promoted?.systemText ?? baseline,
        sourceSnapshot,
        baselineSeq: promoted?.seq ?? this.store.loadContextSnapshot(input.sessionId)?.baselineSeq ?? 0,
        summary: replacementSummary,
        summaryUptoSeq,
      });
    } catch (error) {
      if (error instanceof ContextCompressionError) throw error;
      throw new ContextCompressionError("context_compression_failed", { cause: error });
    }
  }
}
