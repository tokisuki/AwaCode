export type NdjsonErrorCode = "parse_error" | "line_too_long" | "incomplete_line";

export class NdjsonProtocolError extends Error {
  readonly code: NdjsonErrorCode;

  constructor(code: NdjsonErrorCode) {
    super(code);
    this.name = "NdjsonProtocolError";
    this.code = code;
  }
}

const DEFAULT_MAX_LINE_BYTES = 1_048_576;

export class NdjsonDecoder {
  private readonly decoder = new TextDecoder("utf-8");
  private readonly lineBytes: number[] = [];
  private readonly maxLineBytes: number;
  private terminalError: NdjsonProtocolError | undefined;

  constructor(maxLineBytes = DEFAULT_MAX_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes;
  }

  push(chunk: Uint8Array): unknown[] {
    this.throwIfTerminal();

    const values: unknown[] = [];
    for (const byte of chunk) {
      if (byte === 0x0a) {
        const value = this.decodeLine();
        if (value !== undefined) {
          values.push(value);
        }
        continue;
      }

      this.lineBytes.push(byte);
      const contentLength = this.lineBytes.length - (byte === 0x0d ? 1 : 0);
      if (contentLength > this.maxLineBytes) {
        this.fail("line_too_long");
      }
    }

    return values;
  }

  end(): unknown[] {
    this.throwIfTerminal();

    if (this.lineBytes.length === 0) {
      this.decoder.decode();
      return [];
    }

    const text = this.decodeBytes(this.lineBytes);
    this.lineBytes.length = 0;
    if (text.trim().length === 0) {
      return [];
    }

    this.fail("incomplete_line");
  }

  private decodeLine(): unknown | undefined {
    const hasCarriageReturn = this.lineBytes.at(-1) === 0x0d;
    const bytes = hasCarriageReturn ? this.lineBytes.slice(0, -1) : this.lineBytes;
    const text = this.decodeBytes(bytes);
    this.lineBytes.length = 0;

    if (text.trim().length === 0) {
      return undefined;
    }

    try {
      return JSON.parse(text);
    } catch {
      this.fail("parse_error");
    }
  }

  private decodeBytes(bytes: readonly number[]): string {
    return this.decoder.decode(Uint8Array.from(bytes), { stream: true }) + this.decoder.decode();
  }

  private fail(code: NdjsonErrorCode): never {
    const error = new NdjsonProtocolError(code);
    this.terminalError = error;
    throw error;
  }

  private throwIfTerminal(): void {
    if (this.terminalError !== undefined) {
      throw this.terminalError;
    }
  }
}

export function encodeNdjson(value: unknown): Uint8Array {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    if (error instanceof TypeError) {
      throw error;
    }
    throw new TypeError("NDJSON values must be JSON-serializable", { cause: error });
  }

  if (json === undefined) {
    throw new TypeError("NDJSON values must be JSON-serializable");
  }

  return new TextEncoder().encode(`${json}\n`);
}
