import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

import { encodeNdjson, NdjsonDecoder, NdjsonProtocolError } from "./ndjson.ts";
import { JSON_RPC_VERSION, RPC_ERROR_CODES, type JsonRpcMessage } from "./json-rpc.ts";
import { JsonRpcPeer } from "./rpc-peer.ts";

export interface StdioRpcOptions {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  idPrefix: string;
}

export class StdioRpc {
  readonly peer: JsonRpcPeer;
  readonly done: Promise<void>;

  private writeTail: Promise<void> = Promise.resolve();
  private inputTail: Promise<void> = Promise.resolve();
  private readonly options: StdioRpcOptions;
  private readonly decoder = new NdjsonDecoder();
  private readonly activeReceives = new Set<Promise<void>>();
  private readonly resolveDone: () => void;
  private finished = false;

  constructor(options: StdioRpcOptions) {
    this.options = options;
    this.peer = new JsonRpcPeer({
      idPrefix: options.idPrefix,
      send: (message) => this.enqueueWrite(message),
    });
    let resolveDone!: () => void;
    this.done = new Promise((resolve) => { resolveDone = resolve; });
    this.resolveDone = resolveDone;
    options.stdin.on("data", (chunk: unknown) => {
      this.enqueueInput(() => this.processChunk(chunk));
    });
    options.stdin.once("end", () => {
      this.enqueueInput(() => this.finishEof());
    });
    options.stdin.once("error", (error: Error) => {
      this.enqueueInput(() => this.fail(error));
    });
    options.stdin.resume();
  }

  private enqueueWrite(message: JsonRpcMessage): Promise<void> {
    const write = this.writeTail.then(async () => {
      if (!this.options.stdout.write(encodeNdjson(message))) {
        await once(this.options.stdout, "drain");
      }
    });
    this.writeTail = write.catch(() => {});
    return write;
  }

  private enqueueInput(operation: () => Promise<void>): void {
    this.inputTail = this.inputTail.then(async () => {
      if (!this.finished) {
        await operation();
      }
    }).catch((error: unknown) => this.fail(error));
  }

  private async processChunk(chunk: unknown): Promise<void> {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : this.toBytes(chunk);
    const values = this.decoder.push(bytes);
    for (const value of values) {
      this.dispatch(value);
    }
  }

  private async finishEof(): Promise<void> {
    const values = this.decoder.end();
    for (const value of values) {
      this.dispatch(value);
    }
    this.finished = true;
    this.peer.close();
    await Promise.allSettled([...this.activeReceives]);
    await this.writeTail;
    this.resolveDone();
  }

  private async fail(error: unknown): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.options.stdin.pause();
    const diagnostic = error instanceof NdjsonProtocolError ? error.code : "transport_error";
    try {
      this.options.stderr.write(`JSON-RPC stdio failure: ${diagnostic}\n`);
    } catch {
      // A diagnostic stream failure cannot be reported elsewhere.
    }
    if (error instanceof NdjsonProtocolError && error.code === "parse_error") {
      try {
        await this.enqueueWrite({
          jsonrpc: JSON_RPC_VERSION,
          id: null,
          error: { code: RPC_ERROR_CODES.parseError, message: "Parse error" },
        });
      } catch {
        // The peer is closed below even when the parse-error response cannot be written.
      }
    }
    this.peer.close(error);
    await this.writeTail;
    this.resolveDone();
  }

  private toBytes(chunk: unknown): Uint8Array {
    if (chunk instanceof Uint8Array) {
      return chunk;
    }
    throw new TypeError("stdin emitted a non-byte chunk");
  }

  private dispatch(value: unknown): void {
    const receive = this.peer.receive(value);
    this.activeReceives.add(receive);
    void receive
      .catch((error: unknown) => this.fail(error))
      .finally(() => this.activeReceives.delete(receive));
  }
}
