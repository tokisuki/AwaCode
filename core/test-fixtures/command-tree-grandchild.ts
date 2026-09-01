import { appendFileSync, writeFileSync } from "node:fs";

const sentinelPath = process.argv[2];
if (sentinelPath === undefined) {
  throw new Error("command tree grandchild requires a sentinel path");
}

writeFileSync(sentinelPath, `grandchild:${process.pid}\n`, "utf8");
process.stdout.write(`GRANDCHILD_READY ${process.pid}\n`);
setInterval(() => appendFileSync(sentinelPath, ".", "utf8"), 25);
