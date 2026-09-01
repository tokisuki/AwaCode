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

function targetAncestors(target) {
  const segments = relative(demoRoot, target).split(sep);
  const ancestors = [demoRoot];
  let current = demoRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    ancestors.push(current);
  }
  return ancestors;
}

export async function assertSafeDemoTarget(target, { lstat: lstatPath = lstat } = {}) {
  const resolvedTarget = resolve(target);
  if (!isStrictChild(resolvedTarget, demoRoot)) {
    throw new Error("The reset target must be inside the demo directory.");
  }
  if (resolvedTarget === fixture || isStrictChild(fixture, resolvedTarget)) {
    throw new Error("The reset target cannot contain the read-only fixture.");
  }
  for (const ancestor of targetAncestors(resolvedTarget)) {
    try {
      if ((await lstatPath(ancestor)).isSymbolicLink()) {
        throw new Error("The reset target must not traverse a symbolic link or junction.");
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        return resolvedTarget;
      }
      throw error;
    }
  }
  return resolvedTarget;
}

export async function resetDemoWorkspace(target, { afterDeleteBeforeCopy } = {}) {
  const resolvedTarget = await assertSafeDemoTarget(target);
  await assertSafeDemoTarget(resolvedTarget);
  await rm(resolvedTarget, { recursive: true, force: true, maxRetries: 1 });
  await afterDeleteBeforeCopy?.();
  await assertSafeDemoTarget(resolvedTarget);
  await cp(fixture, resolvedTarget, { recursive: true, force: false, errorOnExist: true });
  process.stdout.write(`Demo workspace restored: ${resolvedTarget}\n`);
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const target = parseTarget(process.argv.slice(2));
  if (target !== undefined) {
    resetDemoWorkspace(target).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Unable to reset demo workspace."}\n`);
      process.exitCode = 1;
    });
  }
}
