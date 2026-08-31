import {
  type JsonRpcMessage,
  JSON_RPC_VERSION,
  RPC_ERROR_CODES,
  RpcDisconnectedError,
  RpcFault,
  validateJsonRpcValue,
} from "./json-rpc.ts";

export interface JsonRpcPeerOptions {
  idPrefix: string;
  send(message: JsonRpcMessage): void | Promise<void>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  removeAbortListener(): void;
}

export interface RpcRequestOptions {
  signal?: AbortSignal;
}

interface MethodRegistration {
  parseParams(value: unknown): unknown | Promise<unknown>;
  handler(params: unknown): unknown | Promise<unknown>;
}

export class JsonRpcPeer {
  private readonly idPrefix: string;
  private readonly sendMessage: JsonRpcPeerOptions["send"];
  private readonly pending = new Map<string, PendingRequest>();
  private readonly methods = new Map<string, MethodRegistration>();
  private nextId = 1;
  private disconnected: RpcDisconnectedError | undefined;

  constructor(options: JsonRpcPeerOptions) {
    this.idPrefix = options.idPrefix;
    this.sendMessage = options.send;
  }

  register<T>(
    method: string,
    parseParams: (value: unknown) => T | Promise<T>,
    handler: (params: T) => unknown | Promise<unknown>,
  ): void {
    if (method.trim().length === 0) {
      throw new TypeError("JSON-RPC method must not be blank");
    }
    if (this.methods.has(method)) {
      throw new TypeError(`JSON-RPC method is already registered: ${method}`);
    }
    this.methods.set(method, {
      parseParams,
      handler: (params) => handler(params as T),
    });
  }

  request(method: string, params?: unknown, options: RpcRequestOptions = {}): Promise<unknown> {
    if (this.disconnected !== undefined) {
      return Promise.reject(this.disconnected);
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(options.signal.reason);
    }
    const id = `${this.idPrefix}${this.nextId++}`;
    const message = params === undefined
      ? { jsonrpc: JSON_RPC_VERSION, id, method }
      : { jsonrpc: JSON_RPC_VERSION, id, method, params };

    return new Promise((resolve, reject) => {
      const abort = () => this.rejectPending(id, options.signal?.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        removeAbortListener: () => options.signal?.removeEventListener("abort", abort),
      });
      try {
        const sent = this.sendMessage(message);
        void Promise.resolve(sent).catch((error: unknown) => this.rejectPending(id, error));
      } catch (error) {
        this.rejectPending(id, error);
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.disconnected !== undefined) {
      throw this.disconnected;
    }
    const message = params === undefined
      ? { jsonrpc: JSON_RPC_VERSION, method }
      : { jsonrpc: JSON_RPC_VERSION, method, params };
    await this.sendMessage(message);
  }

  close(reason?: unknown): void {
    if (this.disconnected !== undefined) {
      return;
    }
    this.disconnected = new RpcDisconnectedError(reason);
    for (const id of [...this.pending.keys()]) {
      this.rejectPending(id, this.disconnected);
    }
  }

  async receive(value: unknown): Promise<void> {
    if (this.disconnected !== undefined) {
      throw this.disconnected;
    }
    const inbound = validateJsonRpcValue(value);
    if (inbound.kind === "invalidRequest") {
      await this.sendError(inbound.id, RPC_ERROR_CODES.invalidRequest, "Invalid Request");
      return;
    }
    if (inbound.kind === "invalidResponse") {
      if (inbound.id !== null) {
        this.rejectPending(
          inbound.id,
          new RpcFault(RPC_ERROR_CODES.invalidRequest, "Invalid JSON-RPC response"),
        );
      }
      return;
    }
    if (inbound.kind === "notification") {
      const registration = this.methods.get(inbound.message.method);
      if (registration === undefined) {
        return;
      }
      try {
        const params = await registration.parseParams(inbound.message.params);
        await registration.handler(params);
      } catch {
        // Notifications never produce a wire response.
      }
      return;
    }
    if (inbound.kind === "request") {
      const registration = this.methods.get(inbound.message.method);
      if (registration === undefined) {
        await this.sendError(inbound.message.id, RPC_ERROR_CODES.methodNotFound, "Method not found");
        return;
      }
      let params: unknown;
      try {
        params = await registration.parseParams(inbound.message.params);
      } catch (error) {
        if (error instanceof RpcFault) {
          await this.sendError(inbound.message.id, error.code, error.message, error.data);
        } else {
          await this.sendError(inbound.message.id, RPC_ERROR_CODES.invalidParams, "Invalid params");
        }
        return;
      }
      try {
        const result = await registration.handler(params);
        await this.sendMessage({
          jsonrpc: JSON_RPC_VERSION,
          id: inbound.message.id,
          result: result === undefined ? null : result,
        });
      } catch (error) {
        if (error instanceof RpcFault) {
          await this.sendError(inbound.message.id, error.code, error.message, error.data);
        } else {
          await this.sendError(inbound.message.id, RPC_ERROR_CODES.internalError, "Internal error");
        }
      }
      return;
    }
    if (inbound.message.id === null) {
      return;
    }
    const pending = this.pending.get(inbound.message.id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(inbound.message.id);
    pending.removeAbortListener();
    if (inbound.kind === "error") {
      pending.reject(new RpcFault(
        inbound.message.error.code,
        inbound.message.error.message,
        inbound.message.error.data,
      ));
    } else {
      pending.resolve(inbound.message.result);
    }
  }

  private async sendError(id: string | null, code: number, message: string, data?: unknown): Promise<void> {
    const error = data === undefined ? { code, message } : { code, message, data };
    await this.sendMessage({ jsonrpc: JSON_RPC_VERSION, id, error });
  }

  private rejectPending(id: string, reason: unknown): void {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(id);
    pending.removeAbortListener();
    pending.reject(reason);
  }
}

export { RpcDisconnectedError };
