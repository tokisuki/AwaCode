import { once } from "node:events";
import { writeFile } from "node:fs/promises";

import { openDatabase } from "../src/persistence/database.ts";
import { SessionStore } from "../src/persistence/session-store.ts";
import { transitionToolCall } from "../src/session/tool-call-state.ts";

const [root, markerPath] = process.argv.slice(2);
if (root === undefined || markerPath === undefined) {
  throw new Error("data root and marker path are required");
}

const ids = ["crash-session", "crash-assistant"];
const connection = await openDatabase({ env: { AWACODE_DATA_DIR: root } });
const store = new SessionStore(connection.db, { randomUUID: () => ids.shift() as string });
store.upsertProject({
  id: "crash-project",
  kind: "remote",
  value: "github.com/openai/awacode",
  remote: "github.com/openai/awacode",
  rootPath: "D:\\crash-fixture",
});
const session = store.createSession("crash-project", "Crashed execution");
connection.db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
store.insertAssistantMessageWithToolCalls({
  sessionId: session.id,
  payload: { text: "running tool" },
  toolCalls: [{ callId: "crash-call", ordinal: 0, toolName: "marker", inputText: "{}" }],
});
if (transitionToolCall(store, {
  callId: "crash-call",
  expectedStatus: "pending",
  status: "running",
}).kind !== "applied") {
  throw new Error("could not persist running call");
}

process.stdout.write("RUNNING\n");
process.stdin.on("data", (chunk: Buffer) => {
  if (chunk.toString("utf8").includes("EXECUTE")) {
    void writeFile(markerPath, "executed", "utf8");
  }
});
await once(process.stdin, "end");
connection.close();
