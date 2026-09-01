import { once } from "node:events";

const stdoutChunk = Buffer.alloc(4 * 1024, 0x4f);
const stderrChunk = Buffer.alloc(4 * 1024, 0x45);

for (let index = 0; index < 32; index += 1) {
  if (!process.stdout.write(stdoutChunk)) {
    await once(process.stdout, "drain");
  }
  if (!process.stderr.write(stderrChunk)) {
    await once(process.stderr, "drain");
  }
}
