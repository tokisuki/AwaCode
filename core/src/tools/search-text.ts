import { Buffer } from "node:buffer";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";

import { WorkspaceGuardError } from "../security/workspace-guard.ts";
import {
  assertExactPlainObject,
  ToolValidationError,
  type ToolDefinition,
} from "./contracts.ts";
import { truncateUtf8Output } from "./truncate.ts";

const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", "dist", "build"]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MATCHES = 500;
const MAX_QUERY_BYTES = 16 * 1024;

class SearchInterruptedError extends Error {}
class UnsupportedSearchFileError extends Error {}

export interface SearchTextInput {
  query: string;
  path: string;
  isRegex: boolean;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new SearchInterruptedError();
  }
}

function validateSearchTextInput(value: unknown): SearchTextInput {
  const input = assertExactPlainObject(value, ["query", "path", "is_regex"], ["query"]);
  const path = Object.hasOwn(input, "path") ? input.path : ".";
  const isRegex = Object.hasOwn(input, "is_regex") ? input.is_regex : false;
  if (
    typeof input.query !== "string"
    || input.query.length === 0
    || input.query.includes("\0")
    || Buffer.byteLength(input.query) > MAX_QUERY_BYTES
    || typeof path !== "string"
    || path.length === 0
    || typeof isRegex !== "boolean"
  ) {
    throw new ToolValidationError();
  }
  if (isRegex) {
    try {
      new RegExp(input.query, "u");
    } catch {
      throw new ToolValidationError();
    }
  }
  return { query: input.query, path, isRegex };
}

function lineMatcher(input: SearchTextInput): (line: string) => boolean {
  if (!input.isRegex) {
    return (line) => line.includes(input.query);
  }
  const expression = new RegExp(input.query, "u");
  return (line) => expression.test(line);
}

async function readSearchableText(handle: FileHandle): Promise<string | null> {
  const stats = await handle.stat();
  if (stats.size > MAX_FILE_BYTES) {
    return null;
  }
  const bytes = await handle.readFile();
  if (bytes.includes(0)) {
    throw new UnsupportedSearchFileError();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new UnsupportedSearchFileError();
  }
}

export const searchTextTool: ToolDefinition<SearchTextInput> = {
  name: "search_text",
  description: "Search UTF-8 text files recursively within the selected workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: MAX_QUERY_BYTES },
      path: { type: "string" },
      is_regex: { type: "boolean" },
    },
  },
  approval: "none",
  validate: validateSearchTextInput,
  async execute(input, context) {
    const startedAt = context.now();
    const durationMs = () => Math.max(0, context.now() - startedAt);
    const matches: string[] = [];
    let filesSearched = 0;
    let ignoredDirectoryCount = 0;
    let binaryFileCount = 0;
    let oversizedFileCount = 0;
    let unsafeSymlinkCount = 0;
    let matchLimitTruncated = false;
    let resolvedStart = input.path;
    const matchesLine = lineMatcher(input);

    const searchFile = async (path: string): Promise<boolean> => {
      let handle: FileHandle | undefined;
      try {
        throwIfAborted(context.signal);
        const opened = await context.workspace.openFile(
          path,
          async (resolved) => {
            await context.accessBarrier?.({ kind: "file_resolved", path: resolved.relativePath });
            throwIfAborted(context.signal);
          },
          async (resolved) => {
            await context.accessBarrier?.({ kind: "file_opened", path: resolved.relativePath });
            throwIfAborted(context.signal);
          },
        );
        handle = opened.handle;
        const text = await readSearchableText(handle);
        if (text === null) {
          oversizedFileCount += 1;
          return true;
        }
        filesSearched += 1;
        const lines = text.split(/\r\n|\n|\r/u);
        for (const [index, line] of lines.entries()) {
          throwIfAborted(context.signal);
          if (!matchesLine(line)) {
            continue;
          }
          if (matches.length === MAX_MATCHES) {
            matchLimitTruncated = true;
            return false;
          }
          matches.push(`${opened.resolved.relativePath}:${index + 1}: ${line}`);
        }
        return true;
      } catch (error) {
        if (error instanceof UnsupportedSearchFileError) {
          binaryFileCount += 1;
          return true;
        }
        throw error;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    };

    const walk = async (path: string, starting: boolean): Promise<boolean> => {
      const opened = await context.workspace.openListingDirectory(
        path,
        async (resolved) => {
          await context.accessBarrier?.({ kind: "directory_resolved", path: resolved.relativePath });
          throwIfAborted(context.signal);
        },
        async (resolved) => {
          await context.accessBarrier?.({ kind: "directory_opened", path: resolved.relativePath });
          throwIfAborted(context.signal);
        },
      );
      const children: Dirent[] = [];
      try {
        if (starting) {
          resolvedStart = opened.resolved.relativePath;
        }
        for await (const child of opened.directory) {
          throwIfAborted(context.signal);
          children.push(child);
        }
        await context.workspace.revalidateOpenedDirectory(opened);
      } finally {
        await opened.directory.close().catch(() => undefined);
        await opened.identityHandle.close().catch(() => undefined);
      }
      children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const child of children) {
        throwIfAborted(context.signal);
        if (child.isDirectory() && IGNORED_DIRECTORY_NAMES.has(child.name)) {
          ignoredDirectoryCount += 1;
          continue;
        }
        const childPath = opened.resolved.relativePath === "."
          ? child.name
          : `${opened.resolved.relativePath}/${child.name}`;
        if (child.isSymbolicLink()) {
          unsafeSymlinkCount += 1;
          continue;
        }
        if (child.isDirectory()) {
          if (!await walk(childPath, false)) {
            return false;
          }
        } else if (child.isFile() && !await searchFile(childPath)) {
          return false;
        }
      }
      return true;
    };

    try {
      throwIfAborted(context.signal);
      await walk(input.path, true);
      const content = truncateUtf8Output(matches.join("\n"));
      return {
        status: "success",
        summary: `Found ${matches.length} text ${matches.length === 1 ? "match" : "matches"}.`,
        content: content.text,
        durationMs: durationMs(),
        metadata: {
          path: resolvedStart,
          matchCount: matches.length,
          filesSearched,
          ignoredDirectoryCount,
          binaryFileCount,
          oversizedFileCount,
          unsafeSymlinkCount,
          matchLimitTruncated,
          contentTruncated: content.truncated,
        },
      };
    } catch (error) {
      if (error instanceof SearchInterruptedError || context.signal.aborted) {
        return {
          status: "interrupted",
          summary: "Text search interrupted.",
          content: "The text search was interrupted.",
          durationMs: durationMs(),
          metadata: { path: input.path, matchCount: matches.length },
        };
      }
      const guarded = error instanceof WorkspaceGuardError ? error : undefined;
      return {
        status: "failure",
        summary: "Unable to search workspace text.",
        content: guarded?.message ?? "Workspace text could not be searched.",
        durationMs: durationMs(),
        metadata: { path: input.path, error: guarded?.code ?? "filesystem_error" },
      };
    }
  },
};
