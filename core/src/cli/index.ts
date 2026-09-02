import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { parseCliArguments } from "./arguments.ts";
import { formatCliError } from "./error-format.ts";
import { formatCoreNotification, formatLoadedSession } from "./presentation.ts";
import { selectNodeExecutable } from "./runtime-selection.ts";
import {
  cancelAgentRun,
  forwardCoreStderr,
  promptForPermission,
  runCliCommand,
} from "./terminal-client.ts";
import { StdioRpc } from "../protocol/stdio-rpc.ts";
import type { PermissionRequest } from "../tools/permission.ts";

const EVENT_METHODS = [
  "agent/phase",
  "stream/text",
  "stream/commit",
  "tool/start",
  "tool/end",
  "memory/updated",
  "agent/status",
] as const;

async function run(): Promise<void> {
  const command = parseCliArguments(process.argv.slice(2));
  const node = selectNodeExecutable({
    env: process.env,
    execPath: process.execPath,
    nodeVersion: process.versions.node,
  });
  const coreEntry = fileURLToPath(new URL("../index.js", import.meta.url));
  const child = spawn(node, [coreEntry], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const childExit = once(child, "close").then(() => undefined);
  const detachStderr = forwardCoreStderr(child.stderr, process.stderr);
  const rpc = new StdioRpc({
    stdin: child.stdout,
    stdout: child.stdin,
    stderr: process.stderr,
    idPrefix: "cli-",
  });
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  for (const method of EVENT_METHODS) {
    rpc.peer.register(method, (value) => value, (params) => {
      process.stdout.write(formatCoreNotification(method, params));
    });
  }
  rpc.peer.register("permission/request", (value) => value as PermissionRequest, async (request) =>
    await promptForPermission(request, {
      write: (value) => { process.stdout.write(value); },
      readLine: async () => await lines.question(""),
    }));

  let interrupted = false;
  let cancellation: Promise<void> | undefined;
  const onSigint = () => {
    if (cancellation !== undefined) return;
    interrupted = true;
    cancellation = cancelAgentRun({
      requestCancel: async () => {
        await rpc.peer.request("agent/cancel", {});
        child.stdin.end();
      },
      childExit,
      terminateChild: () => { child.kill("SIGKILL"); },
    });
  };
  process.once("SIGINT", onSigint);
  try {
    const result = await runCliCommand(command, rpc.peer, {
      displaySession: (loaded) => { process.stdout.write(formatLoadedSession(loaded)); },
    });
    if (command.kind !== "resume" && result !== undefined) {
      const final = result as { status?: unknown; reason?: unknown };
      process.stdout.write(`\n[result] ${String(final.status ?? "unknown")}: ${String(final.reason ?? "")}\n`);
    }
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    process.off("SIGINT", onSigint);
    lines.close();
    if (!child.stdin.destroyed) child.stdin.end();
    await (cancellation ?? childExit);
    detachStderr();
    await rpc.done;
  }
  if (interrupted) process.exitCode = 130;
}

await run().catch((error: unknown) => {
  process.stderr.write(`${formatCliError(error)}\n`);
  process.exitCode = 1;
});
