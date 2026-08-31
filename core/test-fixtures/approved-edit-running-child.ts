import { openDatabase } from "../src/persistence/database.ts";
import { SessionStore } from "../src/persistence/session-store.ts";
import { WorkspaceGuard } from "../src/security/workspace-guard.ts";
import { executeEditFile } from "../src/tools/edit-file.ts";

const [dataRoot, workspacePath, callId] = process.argv.slice(2);
if (dataRoot === undefined || workspacePath === undefined || callId === undefined) {
  throw new Error("approved edit child requires data root, workspace, and call ID");
}

const connection = await openDatabase({ env: { AWACODE_DATA_DIR: dataRoot } });
const store = new SessionStore(connection.db);
const workspace = await WorkspaceGuard.create(workspacePath);
const call = store.loadToolCall(callId);
const input = JSON.parse(call.inputText) as unknown;

await executeEditFile({
  callId,
  input,
  store,
  permissionClient: {
    async requestPermission() {
      return "allow_once";
    },
  },
  context: {
    workspace,
    signal: new AbortController().signal,
    now: () => 0,
  },
  applyOptions: {
    async beforeOperation(operation) {
      if (operation === "create") {
        process.stdout.write("RUNNING\n");
        await new Promise<void>(() => {});
      }
    },
  },
});
