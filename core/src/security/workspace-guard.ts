import { realpath, stat } from "node:fs/promises";
import { posix, relative, resolve, sep, win32 } from "node:path";

export type WorkspaceGuardErrorCode =
  | "invalid_workspace"
  | "invalid_path"
  | "outside_workspace"
  | "not_found"
  | "inaccessible"
  | "not_file"
  | "not_directory";

const ERROR_MESSAGES: Record<WorkspaceGuardErrorCode, string> = {
  invalid_workspace: "Workspace must be an existing directory.",
  invalid_path: "Path must be a safe relative workspace path.",
  outside_workspace: "Path resolves outside the workspace.",
  not_found: "Path does not exist.",
  inaccessible: "Path is not accessible.",
  not_file: "Path is not a regular file.",
  not_directory: "Path is not a directory.",
};

export class WorkspaceGuardError extends Error {
  readonly code: WorkspaceGuardErrorCode;

  constructor(code: WorkspaceGuardErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "WorkspaceGuardError";
    this.code = code;
  }
}

export interface ResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

export function isPathWithinWorkspace(
  workspaceRoot: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalizeForComparison = (value: string): string => {
    const normalized = pathApi.normalize(value);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const root = normalizeForComparison(workspaceRoot);
  const target = normalizeForComparison(targetPath);
  const pathFromRoot = pathApi.relative(root, target);
  return pathFromRoot === ""
    || (pathFromRoot !== ".."
      && !pathFromRoot.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(pathFromRoot));
}

function validatedRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new WorkspaceGuardError("invalid_path");
  }
  const normalizedSeparators = value.replaceAll("\\", "/");
  if (
    normalizedSeparators.startsWith("/")
    || /^[a-zA-Z]:/.test(normalizedSeparators)
    || normalizedSeparators.split("/").includes("..")
  ) {
    throw new WorkspaceGuardError("invalid_path");
  }
  return normalizedSeparators;
}

function filesystemError(error: unknown): WorkspaceGuardError {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return new WorkspaceGuardError(code === "ENOENT" ? "not_found" : "inaccessible");
}

export class WorkspaceGuard {
  readonly rootPath: string;

  private constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  static async create(workspaceRoot: string): Promise<WorkspaceGuard> {
    try {
      const canonicalRoot = await realpath(workspaceRoot);
      const rootStat = await stat(canonicalRoot);
      if (!rootStat.isDirectory()) {
        throw new WorkspaceGuardError("invalid_workspace");
      }
      return new WorkspaceGuard(canonicalRoot);
    } catch (error) {
      if (error instanceof WorkspaceGuardError) {
        throw error;
      }
      throw new WorkspaceGuardError("invalid_workspace");
    }
  }

  async resolveFile(path: string): Promise<ResolvedWorkspacePath> {
    return this.resolveExisting(path, "file");
  }

  async resolveDirectory(path: string): Promise<ResolvedWorkspacePath> {
    return this.resolveExisting(path, "directory");
  }

  private async resolveExisting(path: string, expected: "file" | "directory"): Promise<ResolvedWorkspacePath> {
    const safeRelativePath = validatedRelativePath(path);
    const candidate = resolve(this.rootPath, safeRelativePath.split("/").join(sep));
    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(candidate);
    } catch (error) {
      throw filesystemError(error);
    }
    if (!isPathWithinWorkspace(this.rootPath, canonicalTarget)) {
      throw new WorkspaceGuardError("outside_workspace");
    }

    let targetStat;
    try {
      targetStat = await stat(canonicalTarget);
    } catch (error) {
      throw filesystemError(error);
    }
    if (expected === "file" && !targetStat.isFile()) {
      throw new WorkspaceGuardError("not_file");
    }
    if (expected === "directory" && !targetStat.isDirectory()) {
      throw new WorkspaceGuardError("not_directory");
    }

    const workspaceRelative = relative(this.rootPath, canonicalTarget);
    return {
      absolutePath: canonicalTarget,
      relativePath: workspaceRelative === "" ? "." : workspaceRelative.split(sep).join("/"),
    };
  }
}
