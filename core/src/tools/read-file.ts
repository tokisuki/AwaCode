import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";

import { WorkspaceGuardError } from "../security/workspace-guard.ts";
import {
  assertExactPlainObject,
  ToolValidationError,
  type ToolDefinition,
} from "./contracts.ts";
import {
  DEFAULT_TOOL_CONTENT_BYTES,
  truncateUtf8Prefix,
} from "./truncate.ts";

class UnsupportedFileError extends Error {}

class FileReadInterruptedError extends Error {}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new FileReadInterruptedError();
  }
}

class BoundedUtf8Collector {
  private readonly prefixParts: string[] = [];
  private prefixBytes = 0;
  private totalBytes = 0;

  append(text: string): void {
    this.totalBytes += Buffer.byteLength(text);
    if (this.prefixBytes === DEFAULT_TOOL_CONTENT_BYTES) {
      return;
    }
    for (const codePoint of text) {
      const codePointBytes = Buffer.byteLength(codePoint);
      if (this.prefixBytes + codePointBytes > DEFAULT_TOOL_CONTENT_BYTES) {
        return;
      }
      this.prefixParts.push(codePoint);
      this.prefixBytes += codePointBytes;
    }
  }

  finish() {
    return truncateUtf8Prefix(this.prefixParts.join(""), this.totalBytes);
  }
}

export interface ReadFileInput {
  path: string;
  offsetLine: number;
  limitLines: number;
}

function validateReadFileInput(value: unknown): ReadFileInput {
  const input = assertExactPlainObject(value, ["path", "offset_line", "limit_lines"], ["path"]);
  const path = input.path;
  const offsetLine = Object.hasOwn(input, "offset_line") ? input.offset_line : 1;
  const limitLines = Object.hasOwn(input, "limit_lines") ? input.limit_lines : 200;
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new ToolValidationError();
  }
  if (typeof offsetLine !== "number" || !Number.isInteger(offsetLine) || offsetLine < 1) {
    throw new ToolValidationError();
  }
  if (typeof limitLines !== "number" || !Number.isInteger(limitLines) || limitLines < 1 || limitLines > 2_000) {
    throw new ToolValidationError();
  }
  return { path, offsetLine, limitLines };
}

export const readFileTool: ToolDefinition<ReadFileInput> = {
  name: "read_file",
  description: "Read numbered lines from a UTF-8 file within the selected workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string" },
      offset_line: { type: "integer", minimum: 1 },
      limit_lines: { type: "integer", minimum: 1, maximum: 2_000 },
    },
  },
  approval: "none",
  validate: validateReadFileInput,
  async execute(input, context) {
    const startedAt = context.now();
    const durationMs = () => Math.max(0, context.now() - startedAt);
    try {
      throwIfAborted(context.signal);
      const resolved = await context.workspace.resolveFile(input.path);
      throwIfAborted(context.signal);
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const output = new BoundedUtf8Collector();
      let originalBytes = 0;
      let currentLine = 1;
      let totalLines = 0;
      let linesReturned = 0;
      let selectedLineStarted = false;
      let pendingCarriageReturn = false;
      let sawInput = false;
      let endedWithNewline = false;

      const lineIsSelected = (): boolean =>
        currentLine >= input.offsetLine && currentLine < input.offsetLine + input.limitLines;

      const beginSelectedLine = (): void => {
        if (!lineIsSelected() || selectedLineStarted) {
          return;
        }
        if (linesReturned > 0) {
          output.append("\n");
        }
        output.append(`${currentLine}: `);
        selectedLineStarted = true;
        linesReturned += 1;
      };

      const appendText = (text: string): void => {
        beginSelectedLine();
        if (lineIsSelected()) {
          output.append(text);
        }
      };

      const finishLine = (): void => {
        beginSelectedLine();
        totalLines += 1;
        currentLine += 1;
        selectedLineStarted = false;
        endedWithNewline = true;
      };

      const processText = (text: string): void => {
        let checkedCodePoints = 0;
        for (const codePoint of text) {
          if ((checkedCodePoints++ & 1_023) === 0) {
            throwIfAborted(context.signal);
          }
          sawInput = true;
          if (pendingCarriageReturn) {
            pendingCarriageReturn = false;
            if (codePoint === "\n") {
              finishLine();
              continue;
            }
            appendText("\r");
            endedWithNewline = false;
          }
          if (codePoint === "\r") {
            pendingCarriageReturn = true;
            endedWithNewline = false;
          } else if (codePoint === "\n") {
            finishLine();
          } else {
            appendText(codePoint);
            endedWithNewline = false;
          }
        }
      };

      const stream = createReadStream(resolved.absolutePath, { signal: context.signal });
      for await (const chunk of stream) {
        throwIfAborted(context.signal);
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        originalBytes += bytes.length;
        if (bytes.includes(0)) {
          throw new UnsupportedFileError();
        }
        try {
          processText(decoder.decode(bytes, { stream: true }));
        } catch (error) {
          if (error instanceof TypeError) {
            throw new UnsupportedFileError();
          }
          throw error;
        }
      }
      throwIfAborted(context.signal);
      try {
        processText(decoder.decode());
      } catch (error) {
        if (error instanceof TypeError) {
          throw new UnsupportedFileError();
        }
        throw error;
      }
      if (pendingCarriageReturn) {
        appendText("\r");
        endedWithNewline = false;
      }
      if (sawInput && !endedWithNewline) {
        beginSelectedLine();
        totalLines += 1;
      }
      const content = output.finish();
      return {
        status: "success",
        summary: `Read ${linesReturned} ${linesReturned === 1 ? "line" : "lines"} from the workspace file.`,
        content: content.text,
        durationMs: durationMs(),
        metadata: {
          path: resolved.relativePath,
          offsetLine: input.offsetLine,
          limitLines: input.limitLines,
          linesReturned,
          totalLines,
          hasMore: totalLines > input.offsetLine - 1 + linesReturned,
          contentTruncated: content.truncated,
          originalBytes,
        },
      };
    } catch (error) {
      if (error instanceof FileReadInterruptedError || context.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        return {
          status: "interrupted",
          summary: "File read interrupted.",
          content: "The file read was interrupted.",
          durationMs: durationMs(),
          metadata: { path: input.path, offsetLine: input.offsetLine, limitLines: input.limitLines },
        };
      }
      if (error instanceof UnsupportedFileError) {
        return {
          status: "failure",
          summary: "Unable to read workspace file.",
          content: "File is binary or is not valid UTF-8.",
          durationMs: durationMs(),
          metadata: { path: input.path, offsetLine: input.offsetLine, limitLines: input.limitLines, error: "unsupported_encoding" },
        };
      }
      const guardedError = error instanceof WorkspaceGuardError ? error : undefined;
      return {
        status: "failure",
        summary: "Unable to read workspace file.",
        content: guardedError?.message ?? "The file could not be read.",
        durationMs: durationMs(),
        metadata: {
          path: input.path,
          offsetLine: input.offsetLine,
          limitLines: input.limitLines,
          error: guardedError?.code ?? "filesystem_error",
        },
      };
    }
  },
};
