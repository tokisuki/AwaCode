import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { openDatabase } from "../src/persistence/database.ts";
import { SessionStore } from "../src/persistence/session-store.ts";
import { WorkspaceGuard } from "../src/security/workspace-guard.ts";
import type { CommandProcessAdapter } from "../src/tools/command-process.ts";
import { executeRunCommand } from "../src/tools/run-command.ts";

const [dataRoot, workspacePath, callId] = process.argv.slice(2);
if (dataRoot === undefined || workspacePath === undefined || callId === undefined) {
  throw new Error("approved command child requires data root, workspace, and call ID");
}

const systemRoot = process.env.SystemRoot?.trim();
const processAdapter: CommandProcessAdapter = {
  platform: process.platform,
  windowsPowerShellExecutable: systemRoot === undefined || systemRoot.length === 0
    ? "powershell.exe"
    : resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  spawn(executable, args, options) {
    const child = spawn(executable, [...args], options) as ReturnType<CommandProcessAdapter["spawn"]>;
    if (child.pid === undefined) {
      throw new Error("approved command fixture did not receive a child PID");
    }
    process.stdout.write(`RUNNING:${child.pid}\n`);
    return child;
  },
};

const connection = await openDatabase({ env: { AWACODE_DATA_DIR: dataRoot } });
const store = new SessionStore(connection.db);
const workspace = await WorkspaceGuard.create(workspacePath);
await executeRunCommand({
  callId,
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
  processAdapter,
});
