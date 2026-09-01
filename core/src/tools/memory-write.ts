import {
  assertExactPlainObject,
  ToolExecutionError,
  ToolValidationError,
  type ToolDefinition,
} from "./contracts.ts";
import { MemoryStoreError, type MemoryScope } from "../memory/memory-store.ts";

export interface MemoryWriteToolInput {
  scope: MemoryScope;
  oldText?: string;
  newText: string;
}

function validateMemoryWriteInput(value: unknown): MemoryWriteToolInput {
  const input = assertExactPlainObject(value, ["scope", "old_text", "new_text"], ["scope", "new_text"]);
  if (
    (input.scope !== "global" && input.scope !== "project")
    || typeof input.new_text !== "string"
    || (Object.hasOwn(input, "old_text") && (typeof input.old_text !== "string" || input.old_text.length === 0))
    || (!Object.hasOwn(input, "old_text") && input.new_text.length === 0)
  ) {
    throw new ToolValidationError();
  }
  return {
    scope: input.scope,
    ...(typeof input.old_text === "string" ? { oldText: input.old_text } : {}),
    newText: input.new_text,
  };
}

export const memoryWriteTool: ToolDefinition<MemoryWriteToolInput> = {
  name: "memory_write",
  description: "Write global or project memory only when the current user explicitly asks to remember, update, or forget it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["scope", "new_text"],
    properties: {
      scope: { type: "string", enum: ["project", "global"] },
      old_text: { type: "string", minLength: 1 },
      new_text: { type: "string" },
    },
  },
  approval: "none",
  validate: validateMemoryWriteInput,
  async execute(input, context) {
    const startedAt = context.now();
    const durationMs = () => Math.max(0, context.now() - startedAt);
    const runtime = context.memoryRuntime;
    if (runtime === undefined) {
      throw new ToolExecutionError();
    }
    if (context.signal.aborted) {
      return {
        status: "interrupted",
        summary: "Memory update interrupted.",
        content: "Memory was not updated.",
        durationMs: durationMs(),
        metadata: { scope: input.scope, error: "cancelled" },
      };
    }
    try {
      const result = await runtime.store.write({
        scope: input.scope,
        projectId: runtime.projectId,
        ...(input.oldText === undefined ? {} : { oldText: input.oldText }),
        newText: input.newText,
      });
      return {
        status: "success",
        summary: `${input.scope === "project" ? "Project" : "Global"} memory updated.`,
        content: `Updated ${input.scope} memory with an exact ${result.operation} operation.`,
        durationMs: durationMs(),
        metadata: { ...result },
      };
    } catch (error) {
      const code = error instanceof MemoryStoreError ? error.code : "memory_write_failed";
      return {
        status: "failure",
        summary: "Unable to update memory.",
        content: code === "match_not_found"
          ? "The exact memory text was not found."
          : code === "match_not_unique"
            ? "The exact memory text matched more than once."
            : "Memory could not be written atomically.",
        durationMs: durationMs(),
        metadata: { scope: input.scope, error: code },
      };
    }
  },
};
