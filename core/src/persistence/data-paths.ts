import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface DataPaths {
  root: string;
  database: string;
  config: string;
  auth: string;
  memory: string;
  backups: string;
}

export interface DataPathOptions {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}

export function resolveDataPaths(options: DataPathOptions = {}): DataPaths {
  const env = options.env ?? process.env;
  const override = env.AWACODE_DATA_DIR?.trim();
  const localAppData = env.LOCALAPPDATA?.trim();
  const platform = options.platform ?? process.platform;

  if (override === undefined || override.length === 0) {
    if (platform === "win32" && (localAppData === undefined || localAppData.length === 0)) {
      throw new TypeError("LOCALAPPDATA must be non-blank when AWACODE_DATA_DIR is not set");
    }
    if (localAppData === undefined || localAppData.length === 0) {
      throw new TypeError("LOCALAPPDATA must be non-blank when AWACODE_DATA_DIR is not set");
    }
  }

  const root = resolve(override === undefined || override.length === 0
    ? resolve(localAppData as string, "AwaCode")
    : override);
  return {
    root,
    database: resolve(root, "awacode.db"),
    config: resolve(root, "config.json"),
    auth: resolve(root, "auth.json"),
    memory: resolve(root, "memory"),
    backups: resolve(root, "backups"),
  };
}

export async function prepareDataPaths(options: DataPathOptions = {}): Promise<DataPaths> {
  const paths = resolveDataPaths(options);
  await mkdir(paths.backups, { recursive: true });
  return paths;
}
