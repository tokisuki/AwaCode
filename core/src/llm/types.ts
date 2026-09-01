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

export interface SystemModelMessage {
  readonly role: "system";
  readonly content: string;
}

export interface AssistantHistoryModelMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly toolCalls: readonly FunctionToolCall[];
}

export interface ToolResultModelMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly content: string;
}

export type ModelMessage =
  | SystemModelMessage
  | UserModelMessage
  | AssistantHistoryModelMessage
  | ToolResultModelMessage;

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
