import { once } from "node:events";

import { JsonRpcPeer } from "../src/protocol/rpc-peer.ts";
import { createCoreApplication } from "../src/runtime/core-application.ts";
import { DataRootInUseError } from "../src/persistence/data-root-lock.ts";

const root = process.argv[2];
const mode = process.argv[3] ?? "hold";
if (root === undefined) throw new Error("data root argument is required");

const peer = new JsonRpcPeer({ idPrefix: "fixture-", send: () => undefined });
let application;
try {
  application = await createCoreApplication(peer, { env: { AWACODE_DATA_DIR: root } });
} catch (error) {
  if (mode === "attempt" && error instanceof DataRootInUseError) {
    process.stdout.write("LOCKED\n");
    peer.close();
    process.exit(0);
  }
  throw error;
}
if (mode === "attempt") {
  application.close();
  peer.close();
  process.stdout.write("OPENED\n");
  process.exit(0);
}
process.stdout.write("READY\n");
try {
  await once(process.stdin, "data");
} finally {
  application.close();
  peer.close();
}
