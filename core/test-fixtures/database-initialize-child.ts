import { once } from "node:events";

import { openDatabase } from "../src/persistence/database.ts";

const root = process.argv[2];
const timestamp = process.argv[3];
if (root === undefined) {
  throw new Error("data root argument is required");
}

process.stdout.write("READY\n");
await once(process.stdin, "data");

const connection = await openDatabase({
  env: { AWACODE_DATA_DIR: root },
  ...(timestamp === undefined ? {} : { now: () => new Date(timestamp) }),
});
try {
  const migrationCount = Number(
    connection.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count,
  );
  process.stdout.write(`${JSON.stringify({ version: connection.version, migrationCount })}\n`);
} finally {
  connection.close();
}
