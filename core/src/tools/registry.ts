import type { ToolDefinition } from "./contracts.ts";

export type ToolRegistryErrorCode = "invalid_name" | "duplicate_name" | "not_found";

const ERROR_MESSAGES: Record<ToolRegistryErrorCode, string> = {
  invalid_name: "Tool name is invalid.",
  duplicate_name: "Tool name is already registered.",
  not_found: "Tool is not registered.",
};

export class ToolRegistryError extends Error {
  readonly code: ToolRegistryErrorCode;

  constructor(code: ToolRegistryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ToolRegistryError";
    this.code = code;
  }
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition<unknown>>();

  register<T>(definition: ToolDefinition<T>): void {
    if (!/^[a-z][a-z0-9_]*$/.test(definition.name)) {
      throw new ToolRegistryError("invalid_name");
    }
    if (this.definitions.has(definition.name)) {
      throw new ToolRegistryError("duplicate_name");
    }
    this.definitions.set(definition.name, definition as ToolDefinition<unknown>);
  }

  get(name: string): ToolDefinition<unknown> {
    const definition = this.definitions.get(name);
    if (definition === undefined) {
      throw new ToolRegistryError("not_found");
    }
    return definition;
  }

  list(): ToolDefinition<unknown>[] {
    return [...this.definitions.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  }
}
