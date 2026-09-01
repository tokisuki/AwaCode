import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonRpcPeer } from "../../src/protocol/rpc-peer.ts";
import { createCoreApplication } from "../../src/runtime/core-application.ts";
import { disposeChildChannel, spawnChildChannel } from "../support/child-process.ts";

test("a live Core exclusively owns its data root and a crashed owner releases it", async () => {
  const root = await mkdtemp(join(tmpdir(), "awacode-root-lock-"));
  const fixture = join(import.meta.dirname, "..", "..", "test-fixtures", "data-root-core-child.ts");
  const holder = spawnChildChannel(process.execPath, [
    fixture,
    root,
  ]);
  try {
    assert.equal(await holder.lines.nextLine(), "READY");
    const peer = new JsonRpcPeer({ idPrefix: "test-", send: () => undefined });
    await assert.rejects(
      createCoreApplication(peer, { env: { AWACODE_DATA_DIR: root } }).then((unexpected) => {
        unexpected.close();
        return unexpected;
      }),
      /already in use by another AwaCode Core/i,
    );
    peer.close();

    await disposeChildChannel(holder, "data-root lock holder");
    const recoveredPeer = new JsonRpcPeer({ idPrefix: "recovered-", send: () => undefined });
    const recovered = await createCoreApplication(recoveredPeer, { env: { AWACODE_DATA_DIR: root } });
    recovered.close();
    recoveredPeer.close();
  } finally {
    await disposeChildChannel(holder, "data-root lock holder cleanup").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
