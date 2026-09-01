import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";

import type { EffectiveModelConfig } from "../config/model-config.ts";
import { redactDiagnostic } from "../config/diagnostic-redactor.ts";
import type { ModelConnectionTester } from "../config/model-config.ts";
import { canRetryModelError, retryDelayMilliseconds } from "./retry.ts";
import type { AssistantModelMessage, FunctionToolCall, ModelProvider, ModelStreamRequest } from "./types.ts";
import { ModelContextOverflowError } from "./types.ts";

function completionMessages(request: ModelStreamRequest): ChatCompletionMessageParam[] {
  return request.messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      } as ChatCompletionAssistantMessageParam;
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      } as ChatCompletionToolMessageParam;
    }
    return { role: message.role, content: message.content };
  });
}

interface PartialToolCall {
  id: string | undefined;
  name: string | undefined;
  arguments: string;
}

class MalformedStreamError extends Error {
  constructor() {
    super("Malformed model stream");
  }
}

export type ModelRequestErrorCode = "cancelled" | "malformed_stream" | "request_failed";

export class ModelRequestError extends Error {
  readonly code: ModelRequestErrorCode;
  readonly diagnostic: unknown;

  constructor(code: ModelRequestErrorCode, message: string, diagnostic: unknown) {
    super(message);
    this.name = "ModelRequestError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

export interface OpenAIChatClientOptions {
  readonly sleep?: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;
}

function completeToolCalls(partials: ReadonlyMap<number, PartialToolCall>): FunctionToolCall[] {
  return [...partials.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      if (call.id === undefined || call.name === undefined) {
        throw new MalformedStreamError();
      }
      try {
        JSON.parse(call.arguments);
      } catch {
        throw new MalformedStreamError();
      }
      return { id: call.id, name: call.name, arguments: call.arguments };
    });
}

function diagnosticFor(error: unknown, apiKey: string): unknown {
  const candidate = error instanceof Error
    ? {
      name: error.name,
      message: error.message,
      ...(typeof error === "object" && error !== null && "status" in error ? {
        status: (error as { status: unknown }).status,
      } : {}),
      ...(typeof error === "object" && error !== null && "error" in error ? {
        error: (error as { error: unknown }).error,
      } : {}),
    }
    : { message: String(error) };
  return redactDiagnostic(candidate, [apiKey]);
}

function isContextOverflowResponse(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error) || error.status !== 400) {
    return false;
  }
  const payload = "error" in error && typeof error.error === "object" && error.error !== null
    ? error.error as Record<string, unknown>
    : {};
  const code = typeof payload.code === "string" ? payload.code.toLowerCase() : "";
  const message = [
    error instanceof Error ? error.message : "",
    typeof payload.message === "string" ? payload.message : "",
  ].join(" ").toLowerCase();
  return code === "context_length_exceeded"
    || code === "context_window_exceeded"
    || /(?:maximum )?context (?:length|window).*(?:exceed|overflow)|too many tokens/u.test(message);
}

export class OpenAIChatClient implements ModelProvider {
  private readonly client: OpenAI;
  private readonly config: EffectiveModelConfig;
  private readonly sleep: NonNullable<OpenAIChatClientOptions["sleep"]>;

  constructor(config: EffectiveModelConfig, options: OpenAIChatClientOptions = {}) {
    if (config.baseUrl === null || config.model === null || config.apiKey === null) {
      throw new TypeError("Model configuration is not runnable");
    }
    this.config = config;
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      maxRetries: 0,
    });
    this.sleep = options.sleep ?? sleep;
  }

  async stream(request: ModelStreamRequest): Promise<AssistantModelMessage> {
    let attempts = 0;
    while (true) {
      let emittedOutput = false;
      try {
        return await this.streamOnce(request, () => {
          emittedOutput = true;
        });
      } catch (error) {
        if (error instanceof ModelRequestError) {
          throw error;
        }
        if (request.signal?.aborted) {
          throw new ModelRequestError("cancelled", "Model request cancelled", {});
        }
        if (error instanceof MalformedStreamError) {
          throw new ModelRequestError("malformed_stream", "Model stream was malformed", {});
        }
        if (isContextOverflowResponse(error)) {
          throw new ModelContextOverflowError(diagnosticFor(error, this.config.apiKey!));
        }
        attempts += 1;
        if (!canRetryModelError(error, attempts, emittedOutput)) {
          throw new ModelRequestError("request_failed", "Model request failed", diagnosticFor(error, this.config.apiKey!));
        }
        try {
          await this.sleep(retryDelayMilliseconds(error, attempts), request.signal);
        } catch {
          throw new ModelRequestError("cancelled", "Model request cancelled", {});
        }
      }
    }
  }

  private async streamOnce(
    request: ModelStreamRequest,
    onOutput: () => void,
  ): Promise<AssistantModelMessage> {
    const completion = await this.client.chat.completions.create({
      model: this.config.model!,
      messages: completionMessages(request),
      max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
      stream: true,
      ...(request.tools === undefined ? {} : { tools: [...request.tools] as ChatCompletionTool[] }),
    }, { signal: request.signal });
    let content = "";
    let finishReason: string | null = null;
    const toolCalls = new Map<number, PartialToolCall>();
    for await (const chunk of completion as AsyncIterable<ChatCompletionChunk>) {
      const choice = chunk.choices[0];
      if (choice === undefined) {
        continue;
      }
      if (typeof choice.delta.content === "string") {
        onOutput();
        content += choice.delta.content;
        request.onTextDelta?.(choice.delta.content);
      }
      for (const fragment of choice.delta.tool_calls ?? []) {
        onOutput();
        const current = toolCalls.get(fragment.index) ?? { id: undefined, name: undefined, arguments: "" };
        if (typeof fragment.id === "string") {
          current.id = `${current.id ?? ""}${fragment.id}`;
        }
        if (typeof fragment.function?.name === "string") {
          current.name = `${current.name ?? ""}${fragment.function.name}`;
        }
        if (typeof fragment.function?.arguments === "string") {
          current.arguments += fragment.function.arguments;
        }
        toolCalls.set(fragment.index, current);
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        finishReason = choice.finish_reason;
      }
    }
    if (finishReason === null) {
      throw new MalformedStreamError();
    }
    return { role: "assistant", content, toolCalls: completeToolCalls(toolCalls), finishReason };
  }
}

export class OpenAIModelConnectionTester implements ModelConnectionTester {
  async test(config: EffectiveModelConfig, signal: AbortSignal): Promise<{ message?: string }> {
    await new OpenAIChatClient({ ...config, maxOutputTokens: 1 }).stream({
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      signal,
    });
    return { message: "Model connection succeeded" };
  }
}

async function sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
