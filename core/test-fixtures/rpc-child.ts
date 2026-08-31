import { StdioRpc } from "../src/protocol/stdio-rpc.ts";

const rpc = new StdioRpc({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  idPrefix: "core-",
});

rpc.peer.register(
  "child/run",
  (value) => value as { value: number },
  async ({ value }) => {
    const reverse = await rpc.peer.request("reverse/double", { value }) as { doubled: number };
    return { received: reverse.doubled };
  },
);

await rpc.done;
