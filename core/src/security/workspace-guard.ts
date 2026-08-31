import type { BigIntStats, Dir } from "node:fs";
import { lstat, open, opendir, realpath, stat, type FileHandle } from "node:fs/promises";
import { posix, relative, resolve, sep, win32 } from "node:path";

export type WorkspaceGuardErrorCode =
  | "invalid_workspace"
  | "invalid_path"
  | "outside_workspace"
  | "not_found"
  | "inaccessible"
  | "not_file"
  | "not_directory"
  | "path_changed"
  | "unsafe_symlink";

const ERROR_MESSAGES: Record<WorkspaceGuardErrorCode, string> = {
  invalid_workspace: "Workspace must be an existing directory.",
  invalid_path: "Path must be a safe relative workspace path.",
  outside_workspace: "Path resolves outside the workspace.",
  not_found: "Path does not exist.",
  inaccessible: "Path is not accessible.",
  not_file: "Path is not a regular file.",
  not_directory: "Path is not a directory.",
  path_changed: "Path changed during guarded access.",
  unsafe_symlink: "Directory path contains a symbolic link.",
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

export interface OpenedWorkspaceFile {
  handle: FileHandle;
  resolved: ResolvedWorkspacePath;
}

export interface OpenedWorkspaceDirectory {
  directory: Dir;
  identityHandle: FileHandle;
  requestedPath: string;
  resolved: ResolvedWorkspacePath;
}

function sameStableIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino !== 0n && right.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
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

  async resolveListingDirectory(path: string): Promise<ResolvedWorkspacePath> {
    const safeRelativePath = validatedRelativePath(path);
    let currentPath = this.rootPath;
    for (const component of safeRelativePath.split("/")) {
      if (component === "" || component === ".") {
        continue;
      }
      currentPath = resolve(currentPath, component);
      try {
        if ((await lstat(currentPath)).isSymbolicLink()) {
          throw new WorkspaceGuardError("unsafe_symlink");
        }
      } catch (error) {
        if (error instanceof WorkspaceGuardError) {
          throw error;
        }
        throw filesystemError(error);
      }
    }
    return this.resolveDirectory(path);
  }

  async openFile(
    path: string,
    afterInitialResolution?: (resolved: ResolvedWorkspacePath) => Promise<void>,
    afterFileOpen?: (resolved: ResolvedWorkspacePath) => Promise<void>,
  ): Promise<OpenedWorkspaceFile> {
    const initial = await this.resolveFile(path);
    await afterInitialResolution?.(initial);
    let handle: FileHandle | undefined;
    try {
      handle = await open(initial.absolutePath, "r");
      const openedStat = await handle.stat({ bigint: true });
      if (!openedStat.isFile()) {
        throw new WorkspaceGuardError("path_changed");
      }
      await afterFileOpen?.(initial);
      const revalidated = await this.resolveFile(path);
      const pathStat = await stat(revalidated.absolutePath, { bigint: true });
      if (!sameStableIdentity(openedStat, pathStat)) {
        throw new WorkspaceGuardError("path_changed");
      }
      return { handle, resolved: revalidated };
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (error instanceof WorkspaceGuardError) {
        throw error;
      }
      throw filesystemError(error);
    }
  }

  async openListingDirectory(
    path: string,
    afterInitialResolution?: (resolved: ResolvedWorkspacePath) => Promise<void>,
    afterDirectoryOpen?: (resolved: ResolvedWorkspacePath) => Promise<void>,
  ): Promise<OpenedWorkspaceDirectory> {
    const initial = await this.resolveListingDirectory(path);
    await afterInitialResolution?.(initial);
    let identityHandle: FileHandle | undefined;
    let directory: Dir | undefined;
    try {
      identityHandle = await open(initial.absolutePath, "r");
      const openedStat = await identityHandle.stat({ bigint: true });
      if (!openedStat.isDirectory()) {
        throw new WorkspaceGuardError("path_changed");
      }
      directory = await opendir(initial.absolutePath);
      await afterDirectoryOpen?.(initial);
      const opened = { directory, identityHandle, requestedPath: path, resolved: initial };
      opened.resolved = await this.revalidateOpenedDirectory(opened);
      return opened;
    } catch (error) {
      if (directory !== undefined) {
        await directory.close().catch(() => undefined);
      }
      if (identityHandle !== undefined) {
        await identityHandle.close().catch(() => undefined);
      }
      if (error instanceof WorkspaceGuardError) {
        throw error;
      }
      throw filesystemError(error);
    }
  }

  async revalidateOpenedDirectory(opened: OpenedWorkspaceDirectory): Promise<ResolvedWorkspacePath> {
    const revalidated = await this.resolveListingDirectory(opened.requestedPath);
    let openedStat: BigIntStats;
    let pathStat: BigIntStats;
    try {
      [openedStat, pathStat] = await Promise.all([
        opened.identityHandle.stat({ bigint: true }),
        stat(revalidated.absolutePath, { bigint: true }),
      ]);
    } catch (error) {
      throw filesystemError(error);
    }
    if (!openedStat.isDirectory() || !pathStat.isDirectory() || !sameStableIdentity(openedStat, pathStat)) {
      throw new WorkspaceGuardError("path_changed");
    }
    return revalidated;
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
