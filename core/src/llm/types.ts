export interface FunctionToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface AssistantModelMessage {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls: readonly FunctionToolCall[];
  readonly finishReason: string | null;
}

export interface UserModelMessage {
  readonly role: "user";
  readonly content: string;
}

export type ModelMessage = UserModelMessage;

export interface FunctionToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface ModelStreamRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly FunctionToolDefinition[];
  readonly onTextDelta?: (delta: string) => void;
  readonly signal?: AbortSignal;
}

export interface ModelProvider {
  stream(request: ModelStreamRequest): Promise<AssistantModelMessage>;
}
