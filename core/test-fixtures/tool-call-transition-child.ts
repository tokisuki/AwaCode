import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { openDatabase } from "../src/persistence/database.ts";
import { SessionStore } from "../src/persistence/session-store.ts";
import { transitionToolCall } from "../src/session/tool-call-state.ts";

const [root, callId, targetValue, claimsDirectory] = process.argv.slice(2);
if (root === undefined || callId === undefined || targetValue === undefined || claimsDirectory === undefined) {
  throw new Error("data root, call ID, target status, and claims directory are required");
}
if (targetValue !== "running" && targetValue !== "denied" && targetValue !== "interrupted") {
  throw new Error(`unsupported transition target: ${targetValue}`);
}
const target = targetValue;

const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
try {
  const store = new SessionStore(connection.db);
  process.stdout.write("READY\n");
  await once(process.stdin, "data");
  const outcome = transitionToolCall(store, {
    callId,
    expectedStatus: "awaiting_approval",
    status: target,
    ...(target === "running" ? {} : { result: { decision: target } }),
  });
  if (outcome.kind === "applied") {
    await writeFile(join(claimsDirectory, `${target}.claim`), target, { encoding: "utf8", flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify({
    target,
    kind: outcome.kind,
    observedStatus: outcome.call.status,
  })}\n`);
} finally {
  connection.close();
}
