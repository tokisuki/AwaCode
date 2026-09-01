export type CliCommand =
  | { kind: "new"; workspace: string; prompt: string }
  | { kind: "continue"; sessionId: string; prompt: string }
  | { kind: "resume"; sessionId: string };

const USAGE = "Usage: awacode --workspace <path> --prompt <task> | --session <id> --prompt <task> | --resume <id>";

function fail(): never {
  throw new TypeError(USAGE);
}

export function parseCliArguments(argv: readonly string[]): CliCommand {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      name === undefined
      || value === undefined
      || !["--workspace", "--prompt", "--session", "--resume"].includes(name)
      || values.has(name)
      || value.trim().length === 0
    ) {
      fail();
    }
    values.set(name, value);
  }
  if (values.size === 2 && values.has("--workspace") && values.has("--prompt")) {
    return { kind: "new", workspace: values.get("--workspace")!, prompt: values.get("--prompt")! };
  }
  if (values.size === 2 && values.has("--session") && values.has("--prompt")) {
    return { kind: "continue", sessionId: values.get("--session")!, prompt: values.get("--prompt")! };
  }
  if (values.size === 1 && values.has("--resume")) {
    return { kind: "resume", sessionId: values.get("--resume")! };
  }
  return fail();
}

export { USAGE as CLI_USAGE };
