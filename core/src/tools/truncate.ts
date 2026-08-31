import { Buffer } from "node:buffer";

export const DEFAULT_TOOL_CONTENT_BYTES = 50 * 1024;

export interface TruncatedUtf8Output {
  text: string;
  truncated: boolean;
  originalBytes: number;
  outputBytes: number;
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError("Output byte limit must be a positive integer.");
  }
}

function truncationMarker(omittedBytes: number): string {
  return `\n[truncated: ${omittedBytes} bytes omitted]`;
}

export function truncateUtf8Prefix(
  availablePrefix: string,
  originalBytes: number,
  limit: number = DEFAULT_TOOL_CONTENT_BYTES,
): TruncatedUtf8Output {
  validateLimit(limit);
  const availableBytes = Buffer.byteLength(availablePrefix);
  if (!Number.isSafeInteger(originalBytes) || originalBytes < availableBytes) {
    throw new RangeError("Original byte count must cover the available prefix.");
  }
  if (originalBytes <= limit) {
    if (availableBytes !== originalBytes) {
      throw new RangeError("Complete output is required when truncation is unnecessary.");
    }
    return {
      text: availablePrefix,
      truncated: false,
      originalBytes,
      outputBytes: originalBytes,
    };
  }

  let retainedCodeUnits = 0;
  let retainedBytes = 0;
  let bestCodeUnits = 0;
  let bestBytes = 0;
  let bestMarker = truncationMarker(originalBytes);
  if (Buffer.byteLength(bestMarker) > limit) {
    throw new RangeError("Output byte limit is too small for the truncation marker.");
  }

  for (const codePoint of availablePrefix) {
    retainedCodeUnits += codePoint.length;
    retainedBytes += Buffer.byteLength(codePoint);
    if (retainedBytes > limit) {
      break;
    }
    const marker = truncationMarker(originalBytes - retainedBytes);
    if (retainedBytes + Buffer.byteLength(marker) <= limit) {
      bestCodeUnits = retainedCodeUnits;
      bestBytes = retainedBytes;
      bestMarker = marker;
    }
  }

  const text = availablePrefix.slice(0, bestCodeUnits) + bestMarker;
  return {
    text,
    truncated: true,
    originalBytes,
    outputBytes: bestBytes + Buffer.byteLength(bestMarker),
  };
}

export function truncateUtf8Output(
  text: string,
  limit: number = DEFAULT_TOOL_CONTENT_BYTES,
): TruncatedUtf8Output {
  return truncateUtf8Prefix(text, Buffer.byteLength(text), limit);
}
