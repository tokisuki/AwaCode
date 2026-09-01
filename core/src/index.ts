import { pathToFileURL } from "node:url";

import { runStdioCore } from "./runtime/stdio-core.ts";

export const coreDescriptor = {
  name: "AwaCode Core",
  version: "0.1.0",
} as const;

export { createCoreApplication } from "./runtime/core-application.ts";
export { runStdioCore } from "./runtime/stdio-core.ts";

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await runStdioCore().catch(() => {
    process.stderr.write("AwaCode Core startup failed.\n");
    process.exitCode = 1;
  });
}
