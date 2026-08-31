import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import test from "node:test";

import { StdioRpc } from "../../src/protocol/stdio-rpc.ts";

test("a real child completes request and reverse request then exits cleanly on stdin EOF", async () => {
  const fixture = fileURLToPath(new URL("../../test-fixtures/rpc-child.ts", import.meta.url));
  const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
  assert.ok(child.stdin);
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  const adapterDiagnostics = new PassThrough();
  const hostDiagnostics: Buffer[] = [];
  adapterDiagnostics.on("data", (chunk: Buffer) => hostDiagnostics.push(Buffer.from(chunk)));
  const childDiagnostics: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => childDiagnostics.push(Buffer.from(chunk)));
  const host = new StdioRpc({
    stdin: child.stdout,
    stdout: child.stdin,
    stderr: adapterDiagnostics,
    idPrefix: "ui-",
  });
  host.peer.register(
    "reverse/double",
    (value) => value as { value: number },
    ({ value }) => ({ doubled: value * 2 }),
  );

  const result = await host.peer.request("child/run", { value: 21 });
  assert.deepEqual(result, { received: 42 });

  child.stdin.end();
  const [code, signal] = await once(child, "exit");
  await host.done;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(Buffer.concat(hostDiagnostics).toString("utf8"), "");
  assert.equal(Buffer.concat(childDiagnostics).toString("utf8"), "");
});
