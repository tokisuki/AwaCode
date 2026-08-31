import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { normalize } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type ProjectIdentityKind = "remote" | "root" | "path";

export interface ProjectIdentity {
  id: string;
  kind: ProjectIdentityKind;
  value: string;
  remote?: string;
  rootPath: string;
}

export interface ProjectIdentityOptions {
  platform?: NodeJS.Platform;
  gitExecutable?: string;
  env?: NodeJS.ProcessEnv;
}

export class WorkspaceNotFoundError extends Error {
  readonly workspace: string;

  constructor(workspace: string, cause?: unknown) {
    super(`workspace must be an existing directory: ${workspace}`, cause === undefined ? undefined : { cause });
    this.name = "WorkspaceNotFoundError";
    this.workspace = workspace;
  }
}

export class LocalGitRemoteError extends TypeError {
  readonly remote: string;

  constructor(remote: string) {
    super("local Git remotes do not define a stable remote identity");
    this.name = "LocalGitRemoteError";
    this.remote = remote;
  }
}

function identityId(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizedRemotePath(pathname: string): string {
  let path = pathname.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (path.toLowerCase().endsWith(".git")) {
    path = path.slice(0, -4).replace(/\/+$/g, "");
  }
  return path.toLowerCase();
}

export function normalizeGitRemote(value: string): string {
  const remote = value.trim();
  if (/^[a-z]:[\\/]/i.test(remote) || /^(?:\\\\|\/\/)/.test(remote) || /^file:/i.test(remote)) {
    throw new LocalGitRemoteError(remote);
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) {
    const url = new URL(remote);
    const protocol = url.protocol.slice(0, -1).toLowerCase();
    const defaultPorts: Readonly<Record<string, string>> = {
      ftp: "21",
      ftps: "990",
      git: "9418",
      http: "80",
      https: "443",
      ssh: "22",
    };
    const port = url.port.length > 0 && url.port !== defaultPorts[protocol] ? `:${url.port}` : "";
    const host = `${url.hostname.toLowerCase()}${port}`;
    const path = normalizedRemotePath(url.pathname);
    if (host.length === 0 || path.length === 0) {
      throw new TypeError("Git remote must contain a host and path");
    }
    return `${host}/${path}`;
  }

  const scp = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(remote);
  if (scp !== null) {
    const host = (scp[1] as string).toLowerCase();
    const path = normalizedRemotePath((scp[2] as string).split(/[?#]/, 1)[0] as string);
    if (path.length === 0) {
      throw new TypeError("Git remote must contain a path");
    }
    return `${host}/${path}`;
  }

  throw new TypeError("Git remote must use an scp or URL form");
}

async function gitOutput(
  rootPath: string,
  args: readonly string[],
  options: ProjectIdentityOptions,
): Promise<string | undefined> {
  try {
    const result = await execFile(options.gitExecutable ?? "git", args, {
      cwd: rootPath,
      env: options.env ?? process.env,
      encoding: "utf8",
      windowsHide: true,
    });
    const output = result.stdout.trim();
    return output.length === 0 ? undefined : output;
  } catch {
    return undefined;
  }
}

export async function resolveProjectIdentity(
  workspace: string,
  options: ProjectIdentityOptions = {},
): Promise<ProjectIdentity> {
  let rootPath: string;
  try {
    const details = await stat(workspace);
    if (!details.isDirectory()) {
      throw new WorkspaceNotFoundError(workspace);
    }
    rootPath = normalize(await realpath(workspace));
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) {
      throw error;
    }
    throw new WorkspaceNotFoundError(workspace, error);
  }

  const remoteOutput = await gitOutput(rootPath, ["config", "--get", "remote.origin.url"], options);
  if (remoteOutput !== undefined) {
    try {
      const remote = normalizeGitRemote(remoteOutput);
      return {
        id: identityId(`remote:${remote}`),
        kind: "remote",
        value: remote,
        remote,
        rootPath,
      };
    } catch (error) {
      if (!(error instanceof LocalGitRemoteError)) {
        throw error;
      }
    }
  }

  const rootOutput = await gitOutput(rootPath, ["rev-list", "--max-parents=0", "HEAD"], options);
  const root = rootOutput?.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).sort()[0];
  if (root !== undefined) {
    return {
      id: identityId(`root:${root}`),
      kind: "root",
      value: root,
      rootPath,
    };
  }

  const pathIdentity = (options.platform ?? process.platform) === "win32"
    ? rootPath.toLowerCase()
    : rootPath;
  return {
    id: identityId(`path:${pathIdentity}`),
    kind: "path",
    value: pathIdentity,
    rootPath,
  };
}
