import { pathToFileURL } from "node:url";

import { runStdioCore } from "./runtime/stdio-core.ts";
import { DataRootInUseError } from "./persistence/data-root-lock.ts";

export const coreDescriptor = {
  name: "AwaCode Core",
  version: "0.1.0",
} as const;

export { createCoreApplication } from "./runtime/core-application.ts";
export { runStdioCore } from "./runtime/stdio-core.ts";

export function startupDiagnostic(error: unknown): string {
  return error instanceof DataRootInUseError
    ? "AwaCode Core is already running for this data directory. Close the other Core and retry."
    : "AwaCode Core startup failed.";
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await runStdioCore().catch((error: unknown) => {
    process.stderr.write(`${startupDiagnostic(error)}\n`);
    process.exitCode = 1;
  });
}
