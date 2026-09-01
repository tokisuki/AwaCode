import { once } from "node:events";

import { JsonRpcPeer } from "../src/protocol/rpc-peer.ts";
import { createCoreApplication } from "../src/runtime/core-application.ts";

const root = process.argv[2];
if (root === undefined) throw new Error("data root argument is required");

const peer = new JsonRpcPeer({ idPrefix: "fixture-", send: () => undefined });
const application = await createCoreApplication(peer, { env: { AWACODE_DATA_DIR: root } });
process.stdout.write("READY\n");
try {
  await once(process.stdin, "data");
} finally {
  application.close();
  peer.close();
}
