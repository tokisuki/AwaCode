import { appendFileSync, writeFileSync } from "node:fs";

const [readyPath, heartbeatPath] = process.argv.slice(2);
if (readyPath === undefined || heartbeatPath === undefined) {
  throw new Error("resistant redirected grandchild requires readiness and heartbeat paths");
}

process.on("SIGTERM", () => {
  // Deliberately survive the graceful process-group signal.
});
writeFileSync(heartbeatPath, `grandchild:${process.pid}\n`, "utf8");
writeFileSync(readyPath, String(process.pid), "utf8");
setInterval(() => appendFileSync(heartbeatPath, ".", "utf8"), 25);
