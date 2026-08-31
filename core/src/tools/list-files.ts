import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { WorkspaceGuardError } from "../security/workspace-guard.ts";
import {
  assertExactPlainObject,
  ToolValidationError,
  type ToolDefinition,
} from "./contracts.ts";
import { truncateUtf8Output } from "./truncate.ts";

const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", "dist", "build"]);
const MAX_ENTRIES = 2_000;

class ListingInterruptedError extends Error {}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ListingInterruptedError();
  }
}

export interface ListFilesInput {
  path: string;
  maxDepth: number;
}

function validateListFilesInput(value: unknown): ListFilesInput {
  const input = assertExactPlainObject(value, ["path", "max_depth"], []);
  const path = Object.hasOwn(input, "path") ? input.path : ".";
  const maxDepth = Object.hasOwn(input, "max_depth") ? input.max_depth : 4;
  if (typeof path !== "string" || path.length === 0) {
    throw new ToolValidationError();
  }
  if (typeof maxDepth !== "number" || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 20) {
    throw new ToolValidationError();
  }
  return { path, maxDepth };
}

export const listFilesTool: ToolDefinition<ListFilesInput> = {
  name: "list_files",
  description: "List files and directories within the selected workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      max_depth: { type: "integer", minimum: 0, maximum: 20 },
    },
  },
  approval: "none",
  validate: validateListFilesInput,
  async execute(input, context) {
    const startedAt = context.now();
    const durationMs = () => Math.max(0, context.now() - startedAt);
    try {
      throwIfAborted(context.signal);
      const startingDirectory = await context.workspace.resolveDirectory(input.path);
      throwIfAborted(context.signal);
      const entries: string[] = [];
      let ignoredCount = 0;
      let unsafeSymlinkCount = 0;
      let entryLimitTruncated = false;

      const addEntry = (entry: string): boolean => {
        if (entries.length === MAX_ENTRIES) {
          entryLimitTruncated = true;
          return false;
        }
        entries.push(entry);
        return true;
      };

      const walk = async (absoluteDirectory: string, relativeDirectory: string, depthRemaining: number): Promise<boolean> => {
        throwIfAborted(context.signal);
        const children = await readdir(absoluteDirectory, { withFileTypes: true });
        throwIfAborted(context.signal);
        children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        for (const child of children) {
          throwIfAborted(context.signal);
          if (IGNORED_DIRECTORY_NAMES.has(child.name)) {
            ignoredCount += 1;
            continue;
          }
          const relativePath = relativeDirectory === "." ? child.name : `${relativeDirectory}/${child.name}`;
          if (child.isSymbolicLink()) {
            try {
              await context.workspace.resolveDirectory(relativePath);
              throwIfAborted(context.signal);
              if (!addEntry(`${relativePath}/`)) {
                return false;
              }
            } catch (error) {
              if (error instanceof WorkspaceGuardError && error.code === "not_directory") {
                try {
                  await context.workspace.resolveFile(relativePath);
                  throwIfAborted(context.signal);
                  if (!addEntry(relativePath)) {
                    return false;
                  }
                } catch {
                  unsafeSymlinkCount += 1;
                }
              } else {
                unsafeSymlinkCount += 1;
              }
            }
            continue;
          }
          if (child.isDirectory()) {
            if (!addEntry(`${relativePath}/`)) {
              return false;
            }
            if (depthRemaining > 0) {
              const guardedChild = await context.workspace.resolveDirectory(relativePath);
              throwIfAborted(context.signal);
              if (!await walk(guardedChild.absolutePath, relativePath, depthRemaining - 1)) {
                return false;
              }
            }
          } else if (!addEntry(relativePath)) {
            return false;
          }
        }
        return true;
      };

      await walk(startingDirectory.absolutePath, startingDirectory.relativePath, input.maxDepth);
      throwIfAborted(context.signal);
      const content = truncateUtf8Output(entries.join("\n"));
      return {
        status: "success",
        summary: `Listed ${entries.length} workspace entries.`,
        content: content.text,
        durationMs: durationMs(),
        metadata: {
          path: startingDirectory.relativePath,
          maxDepth: input.maxDepth,
          entryCount: entries.length,
          ignoredCount,
          unsafeSymlinkCount,
          entryLimitTruncated,
          contentTruncated: content.truncated,
        },
      };
    } catch (error) {
      if (error instanceof ListingInterruptedError || context.signal.aborted) {
        return {
          status: "interrupted",
          summary: "File listing interrupted.",
          content: "The file listing was interrupted.",
          durationMs: durationMs(),
          metadata: { path: input.path, maxDepth: input.maxDepth },
        };
      }
      const guardedError = error instanceof WorkspaceGuardError ? error : undefined;
      return {
        status: "failure",
        summary: "Unable to list workspace files.",
        content: guardedError?.message ?? "The directory could not be read.",
        durationMs: durationMs(),
        metadata: {
          path: input.path,
          maxDepth: input.maxDepth,
          error: guardedError?.code ?? "filesystem_error",
        },
      };
    }
  },
};
