import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveDataPaths, type DataPathOptions } from "../persistence/data-paths.ts";

export type MemoryScope = "global" | "project";

export interface MemoryTexts {
  global: string;
  project: string;
}

export interface MemoryWriteInput {
  scope: MemoryScope;
  projectId: string;
  oldText?: string;
  newText: string;
}

export interface MemoryWriteResult {
  scope: MemoryScope;
  operation: "append" | "update" | "forget";
  characters: number;
}

export class MemoryStoreError extends Error {
  readonly code: "invalid_project_id" | "match_not_found" | "match_not_unique" | "atomic_write_failed";
  constructor(code: MemoryStoreError["code"], options: ErrorOptions = {}) {
    super("Memory operation failed.", options);
    this.name = "MemoryStoreError";
    this.code = code;
  }
}

export interface MemoryStoreOptions {
  createTemporaryName?: () => string;
  beforeReplace?: () => void | Promise<void>;
}

function countOccurrences(text: string, query: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const match = text.indexOf(query, offset);
    if (match < 0) return count;
    count += 1;
    offset = match + query.length;
  }
}

function appendText(existing: string, addition: string): string {
  if (existing.length === 0) return addition;
  if (addition.length === 0) return existing;
  return `${existing}${existing.endsWith("\n") ? "" : "\n"}${addition}`;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export class MemoryStore {
  private readonly memoryRoot: string;
  private readonly createTemporaryName: () => string;
  private readonly beforeReplace: (() => void | Promise<void>) | undefined;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(pathOptions: DataPathOptions = {}, options: MemoryStoreOptions = {}) {
    this.memoryRoot = resolveDataPaths(pathOptions).memory;
    this.createTemporaryName = options.createTemporaryName ?? randomUUID;
    this.beforeReplace = options.beforeReplace;
  }

  async read(projectId: string): Promise<MemoryTexts> {
    return {
      global: await readText(this.pathFor("global", projectId)),
      project: await readText(this.pathFor("project", projectId)),
    };
  }

  async write(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    const path = this.pathFor(input.scope, input.projectId);
    return this.serialized(path, async () => {
      const existing = await readText(path);
      let next: string;
      let operation: MemoryWriteResult["operation"];
      if (input.oldText === undefined) {
        next = appendText(existing, input.newText);
        operation = "append";
      } else {
        const matches = countOccurrences(existing, input.oldText);
        if (matches === 0) throw new MemoryStoreError("match_not_found");
        if (matches !== 1) throw new MemoryStoreError("match_not_unique");
        next = existing.replace(input.oldText, input.newText);
        operation = input.newText.length === 0 ? "forget" : "update";
      }
      await this.atomicWrite(path, next);
      return { scope: input.scope, operation, characters: next.length };
    });
  }

  private pathFor(scope: MemoryScope, projectId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) {
      throw new MemoryStoreError("invalid_project_id");
    }
    return scope === "global"
      ? join(this.memoryRoot, "global.md")
      : join(this.memoryRoot, "projects", `${projectId}.md`);
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = join(dirname(path), `.awacode-memory-${this.createTemporaryName()}.tmp`);
    let created = false;
    try {
      const handle = await open(temporaryPath, "wx");
      created = true;
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.beforeReplace?.();
      await rename(temporaryPath, path);
      created = false;
    } catch (error) {
      throw error instanceof MemoryStoreError ? error : new MemoryStoreError("atomic_write_failed", { cause: error });
    } finally {
      if (created) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }

  private async serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.queues.set(path, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(path) === tail) {
        this.queues.delete(path);
      }
    }
  }
}
