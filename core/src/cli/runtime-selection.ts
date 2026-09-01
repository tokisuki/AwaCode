export interface NodeSelectionInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execPath: string;
  readonly nodeVersion: string;
}

export function selectNodeExecutable(input: NodeSelectionInput): string {
  const explicit = input.env.AWACODE_NODE_PATH?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const major = Number(input.nodeVersion.split(".", 1)[0]);
  if (!Number.isSafeInteger(major) || major < 24) {
    throw new Error("AwaCode CLI requires Node.js 24; set AWACODE_NODE_PATH to a Node 24 executable.");
  }
  return input.execPath;
}
