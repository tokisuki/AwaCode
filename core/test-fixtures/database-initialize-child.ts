import { once } from "node:events";
import { watch } from "node:fs/promises";
import { join } from "node:path";

import { openDatabase } from "../src/persistence/database.ts";

const root = process.argv[2];
const timestamp = process.argv[3];
const mode = process.argv[4];
if (root === undefined) {
  throw new Error("data root argument is required");
}

process.stdout.write("READY\n");
await once(process.stdin, "data");

const options = {
  env: { AWACODE_DATA_DIR: root },
  ...(timestamp === undefined ? {} : { now: () => new Date(timestamp) }),
};
let opening: ReturnType<typeof openDatabase>;
if (mode === "watch-backup") {
  const watcher = watch(join(root, "backups"));
  const nextArtifact = watcher[Symbol.asyncIterator]().next();
  opening = openDatabase(options);
  const event = await nextArtifact;
  process.stdout.write(`BACKUP_ARTIFACT ${String(event.value?.filename)}\n`);
} else {
  opening = openDatabase(options);
}
const connection = await opening;
try {
  const migrationCount = Number(
    connection.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count,
  );
  process.stdout.write(`${JSON.stringify({ version: connection.version, migrationCount })}\n`);
} finally {
  connection.close();
}
