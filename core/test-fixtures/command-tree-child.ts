import { spawn } from "node:child_process";
import { join } from "node:path";

const sentinelPath = process.argv[2];
if (sentinelPath === undefined) {
  throw new Error("command tree child requires a sentinel path");
}

const grandchildFixture = join(import.meta.dirname, "command-tree-grandchild.ts");
const grandchild = spawn(process.execPath, [grandchildFixture, sentinelPath], {
  stdio: ["ignore", "pipe", "inherit"],
  windowsHide: true,
});
let buffered = "";
grandchild.stdout.setEncoding("utf8");
grandchild.stdout.on("data", (chunk: string) => {
  buffered += chunk;
  const newline = buffered.indexOf("\n");
  if (newline >= 0) {
    const line = buffered.slice(0, newline).replace(/\r$/, "");
    if (line.startsWith("GRANDCHILD_READY ")) {
      process.stdout.write(`TREE_READY ${process.pid} ${line.slice("GRANDCHILD_READY ".length)}\n`);
    }
    grandchild.stdout.removeAllListeners("data");
  }
});
setInterval(() => {}, 1_000);
