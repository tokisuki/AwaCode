import type { Readable, Writable } from "node:stream";

import type { CoreApplicationOptions } from "./core-application.ts";
import { createCoreApplication } from "./core-application.ts";
import { StdioRpc } from "../protocol/stdio-rpc.ts";

export interface RunStdioCoreOptions extends CoreApplicationOptions {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

export async function runStdioCore(options: RunStdioCoreOptions = {}): Promise<void> {
  const rpc = new StdioRpc({
    stdin: options.stdin ?? process.stdin,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    idPrefix: "core-",
    autoStart: false,
  });
  const application = await createCoreApplication(rpc.peer, options);
  try {
    rpc.start();
    await rpc.done;
  } finally {
    application.close();
  }
}
