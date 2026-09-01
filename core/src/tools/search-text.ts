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

interface RegexFrame {
  hasAlternation: boolean;
  hasQuantifier: boolean;
  unboundedQuantifiers: number;
}

interface RegexAtom {
  kind: "plain" | "group";
  hasAlternation: boolean;
  hasQuantifier: boolean;
}

function isSafeRegexPattern(pattern: string): boolean {
  const frames: RegexFrame[] = [{ hasAlternation: false, hasQuantifier: false, unboundedQuantifiers: 0 }];
  const groupAtoms: RegexAtom[] = [];
  let atom: RegexAtom | undefined;
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined || /^[1-9]$/u.test(escaped)) return false;
      index += 1;
      atom = { kind: "plain", hasAlternation: false, hasQuantifier: false };
      continue;
    }
    if (inClass) {
      if (character === "]") {
        inClass = false;
        atom = { kind: "plain", hasAlternation: false, hasQuantifier: false };
      }
      continue;
    }
    if (character === "[") {
      inClass = true;
      atom = undefined;
      continue;
    }
    if (character === "(") {
      if (pattern[index + 1] === "?" && pattern[index + 2] !== ":") return false;
      if (pattern[index + 1] === "?" && pattern[index + 2] === ":") index += 2;
      frames.push({ hasAlternation: false, hasQuantifier: false, unboundedQuantifiers: 0 });
      groupAtoms.push({ kind: "group", hasAlternation: false, hasQuantifier: false });
      atom = undefined;
      continue;
    }
    if (character === ")") {
      const frame = frames.pop();
      const group = groupAtoms.pop();
      if (frame === undefined || group === undefined || frames.length === 0) return false;
      const parent = frames.at(-1)!;
      parent.hasAlternation ||= frame.hasAlternation;
      parent.hasQuantifier ||= frame.hasQuantifier;
      parent.unboundedQuantifiers += frame.unboundedQuantifiers;
      atom = { kind: "group", hasAlternation: frame.hasAlternation, hasQuantifier: frame.hasQuantifier };
      continue;
    }
    if (character === "|") {
      const frame = frames.at(-1)!;
      frame.hasAlternation = true;
      frame.unboundedQuantifiers = 0;
      atom = undefined;
      continue;
    }
    if (character === "*" || character === "+" || character === "?" || character === "{") {
      if (atom === undefined) return false;
      let unbounded = character === "*" || character === "+";
      if (character === "{") {
        const close = pattern.indexOf("}", index + 1);
        if (close === -1) return false;
        const range = pattern.slice(index + 1, close);
        unbounded = /^\d+,$/u.test(range);
        index = close;
      }
      if (atom.kind === "group" && (atom.hasAlternation || atom.hasQuantifier)) return false;
      const frame = frames.at(-1)!;
      frame.hasQuantifier = true;
      if (unbounded && ++frame.unboundedQuantifiers > 1) return false;
      atom = { kind: "plain", hasAlternation: false, hasQuantifier: true };
      continue;
    }
    if (character === "^" || character === "$") {
      atom = undefined;
      continue;
    }
    atom = { kind: "plain", hasAlternation: false, hasQuantifier: false };
  }
  return !inClass && frames.length === 1 && groupAtoms.length === 0;
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
    if (!isSafeRegexPattern(input.query)) {
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

async function readSearchableText(handle: FileHandle, afterStat: () => Promise<void>): Promise<string | null> {
  const stats = await handle.stat();
  if (stats.size > MAX_FILE_BYTES) {
    return null;
  }
  await afterStat();
  const bounded = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
  let bytesRead = 0;
  while (bytesRead < bounded.length) {
    const chunk = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
    if (chunk.bytesRead === 0) break;
    bytesRead += chunk.bytesRead;
  }
  if (bytesRead > MAX_FILE_BYTES) {
    return null;
  }
  const bytes = bounded.subarray(0, bytesRead);
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
        const text = await readSearchableText(handle, async () => {
          await context.accessBarrier?.({ kind: "file_sized", path: opened.resolved.relativePath });
          throwIfAborted(context.signal);
        });
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
