import { glob } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const files = [];
for await (const file of glob("test/**/*.test.ts")) {
  files.push(file);
}
files.sort();

if (files.length === 0) {
  console.error("No TypeScript tests were found.");
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}
