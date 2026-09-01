import type { Readable, Writable } from "node:stream";

import type { CliCommand } from "./arguments.ts";
import type { PermissionDecision, PermissionRequest } from "../tools/permission.ts";

export interface CliRpcClient {
  request(method: string, params?: unknown): Promise<unknown>;
}

export interface CliCommandOutput {
  displaySession(loaded: unknown): void;
}

export type CliCommandResult = unknown;

export async function runCliCommand(
  command: CliCommand,
  client: CliRpcClient,
  output: CliCommandOutput,
): Promise<CliCommandResult> {
  if (command.kind === "resume") {
    const loaded = await client.request("session/load", { sessionId: command.sessionId });
    output.displaySession(loaded);
    return { kind: "resumed", sessionId: command.sessionId };
  }
  if (command.kind === "continue") {
    return await client.request("agent/run", { sessionId: command.sessionId, prompt: command.prompt });
  }
  const selected = await client.request("workspace/set", { workspace: command.workspace }) as { projectId?: unknown };
  if (typeof selected.projectId !== "string") {
    throw new TypeError("Core returned an invalid workspace selection");
  }
  const created = await client.request("session/create", {
    projectId: selected.projectId,
    title: command.prompt,
  }) as { id?: unknown };
  if (typeof created.id !== "string") {
    throw new TypeError("Core returned an invalid session");
  }
  return await client.request("agent/run", { sessionId: created.id, prompt: command.prompt });
}

export interface PermissionPromptIo {
  write(text: string): void;
  readLine(): Promise<string>;
}

export async function promptForPermission(
  request: PermissionRequest,
  io: PermissionPromptIo,
): Promise<PermissionDecision> {
  io.write(`\n[permission] ${request.title}\n${JSON.stringify(request.preview, null, 2)}\n`);
  for (;;) {
    io.write("Decision (allow_once | deny): ");
    const decision = await io.readLine();
    if (decision === "allow_once" || decision === "deny") {
      return decision;
    }
  }
}

export function forwardCoreStderr(source: Readable, destination: Writable): () => void {
  source.pipe(destination, { end: false });
  return () => source.unpipe(destination);
}

export interface CancelAgentRunOptions {
  requestCancel(): Promise<unknown>;
  childExit: Promise<unknown>;
  terminateChild(): void;
  wait?: (settled: Promise<unknown>, timeoutMs: number) => Promise<boolean>;
  timeoutMs?: number;
}

async function waitBounded(settled: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settled.then(() => true, () => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function cancelAgentRun(options: CancelAgentRunOptions): Promise<void> {
  try {
    void options.requestCancel().catch(() => undefined);
  } catch {
    // A synchronous transport failure must not bypass the bounded child wait.
  }
  const exited = await (options.wait ?? waitBounded)(options.childExit, options.timeoutMs ?? 1_500);
  if (!exited) {
    options.terminateChild();
    await options.childExit.catch(() => undefined);
  }
}
