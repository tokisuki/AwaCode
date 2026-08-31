import { writeFileSync } from "node:fs";

const markerPath = process.argv[2];
if (markerPath === undefined) {
  throw new Error("termination marker path is required");
}

process.on("SIGTERM", () => {
  writeFileSync(markerPath, "SIGTERM observed", "utf8");
});
process.stdout.write("READY\n");
setInterval(() => {}, 1000);
