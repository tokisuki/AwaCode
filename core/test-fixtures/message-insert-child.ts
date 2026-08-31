import { once } from "node:events";

import { openDatabase } from "../src/persistence/database.ts";
import { SessionStore } from "../src/persistence/session-store.ts";

const [root, sessionId, marker] = process.argv.slice(2);
if (root === undefined || sessionId === undefined || marker === undefined) {
  throw new Error("data root, session ID, and marker arguments are required");
}

process.stdout.write("READY\n");
await once(process.stdin, "data");

const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
try {
  const message = new SessionStore(connection.db).insertMessage({
    sessionId,
    role: "user",
    kind: "text",
    payload: { marker },
  });
  process.stdout.write(`${JSON.stringify({ seq: message.seq, marker })}\n`);
} finally {
  connection.close();
}
