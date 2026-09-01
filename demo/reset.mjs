import { cp, lstat, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const demoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const fixture = resolve(demoRoot, "fixture");

function usage(message) {
  process.stderr.write(`${message}\nUsage: node demo/reset.mjs --target <path-inside-demo>\n`);
  process.exitCode = 2;
}

function parseTarget(argv) {
  if (argv.length !== 2 || argv[0] !== "--target" || argv[1].trim().length === 0) {
    usage("An explicit --target is required.");
    return undefined;
  }
  return resolve(argv[1]);
}

function isStrictChild(path, parent) {
  const pathRelative = relative(parent, path);
  return pathRelative.length > 0 && !pathRelative.startsWith(`..${sep}`) && pathRelative !== ".." && !pathRelative.includes(`:${sep}`);
}

async function reset(target) {
  if (!isStrictChild(target, demoRoot)) {
    throw new Error("The reset target must be inside the demo directory.");
  }
  if (target === fixture || isStrictChild(fixture, target)) {
    throw new Error("The reset target cannot contain the read-only fixture.");
  }
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error("The reset target must not be a symbolic link.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rm(target, { recursive: true, force: true, maxRetries: 1 });
  await cp(fixture, target, { recursive: true, force: false, errorOnExist: true });
  process.stdout.write(`Demo workspace restored: ${target}\n`);
}

const target = parseTarget(process.argv.slice(2));
if (target !== undefined) {
  reset(target).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Unable to reset demo workspace."}\n`);
    process.exitCode = 1;
  });
}
