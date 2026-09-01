import { coreDescriptor } from "../index.ts";
import {
  ModelConfigOperationError,
  ModelConfigService,
  parseSaveModelConfigInput,
} from "../config/model-config.ts";
import { DATABASE_VERSION } from "../persistence/database.ts";
import { SessionStore, StoreNotFoundError } from "../persistence/session-store.ts";
import {
  resolveProjectIdentity,
  type ProjectIdentityOptions,
  WorkspaceNotFoundError,
} from "../project/project-identity.ts";
import { RPC_ERROR_CODES, RpcFault } from "../protocol/json-rpc.ts";
import type { JsonRpcPeer } from "../protocol/rpc-peer.ts";

export interface CoreHandlerDependencies {
  store: SessionStore;
  configService: ModelConfigService;
  projectIdentityOptions?: ProjectIdentityOptions;
}

interface WorkspaceParams {
  workspace: string;
}

interface ProjectParams {
  projectId: string;
}

interface CreateSessionParams extends ProjectParams {
  title?: string;
}

interface SessionParams {
  sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function parseHello(value: unknown): Record<string, never> {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new TypeError("core/hello params must be an empty object");
  }
  return {};
}

function parseConfigStatus(value: unknown): Record<string, never> {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new TypeError("config/status params must be an empty object");
  }
  return {};
}

function parseConfigTest(value: unknown): Record<string, never> {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new TypeError("config/test params must be an empty object");
  }
  return {};
}

function parseWorkspace(value: unknown): WorkspaceParams {
  if (!isRecord(value) || !hasExactKeys(value, ["workspace"]) || typeof value.workspace !== "string") {
    throw new TypeError("workspace/set params must contain only a string workspace");
  }
  return { workspace: value.workspace };
}

function parseProject(value: unknown): ProjectParams {
  if (!isRecord(value) || !hasExactKeys(value, ["projectId"]) || typeof value.projectId !== "string") {
    throw new TypeError("session/list params must contain only a string projectId");
  }
  return { projectId: value.projectId };
}

function parseCreateSession(value: unknown): CreateSessionParams {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["projectId"], ["title"])
    || typeof value.projectId !== "string"
    || (Object.prototype.hasOwnProperty.call(value, "title") && typeof value.title !== "string")
  ) {
    throw new TypeError("session/create params must contain projectId and an optional string title");
  }
  return typeof value.title === "string"
    ? { projectId: value.projectId, title: value.title }
    : { projectId: value.projectId };
}

function parseSession(value: unknown): SessionParams {
  if (!isRecord(value) || !hasExactKeys(value, ["sessionId"]) || typeof value.sessionId !== "string") {
    throw new TypeError("session/load params must contain only a string sessionId");
  }
  return { sessionId: value.sessionId };
}

function storeFault(error: unknown): never {
  if (error instanceof StoreNotFoundError) {
    if (error.entity === "project") {
      throw new RpcFault(RPC_ERROR_CODES.notFound, "Project not found", { projectId: error.id });
    }
    throw new RpcFault(RPC_ERROR_CODES.notFound, "Session not found", { sessionId: error.id });
  }
  throw error;
}

function configFault(error: unknown): never {
  if (error instanceof ModelConfigOperationError) {
    if (error.kind === "not_configured") {
      throw new RpcFault(RPC_ERROR_CODES.notConfigured, "Model configuration is not runnable");
    }
    if (error.kind === "cancelled") {
      throw new RpcFault(RPC_ERROR_CODES.cancelled, "Model connection test cancelled");
    }
  }
  throw new RpcFault(RPC_ERROR_CODES.configurationOperation, "Model configuration operation failed");
}

export function registerCoreHandlers(peer: JsonRpcPeer, dependencies: CoreHandlerDependencies): void {
  peer.register("core/hello", parseHello, () => ({
    coreVersion: coreDescriptor.version,
    databaseVersion: DATABASE_VERSION,
    configured: false,
    interruptedCount: 0,
  }));

  peer.register("workspace/set", parseWorkspace, async ({ workspace }) => {
    try {
      const identity = await resolveProjectIdentity(workspace, dependencies.projectIdentityOptions);
      const project = dependencies.store.upsertProject(identity);
      return { workspace: project.rootPath, projectId: project.id };
    } catch (error) {
      if (error instanceof WorkspaceNotFoundError) {
        throw new RpcFault(RPC_ERROR_CODES.notFound, "Workspace not found", { workspace });
      }
      throw error;
    }
  });

  peer.register("session/list", parseProject, ({ projectId }) => {
    try {
      return dependencies.store.listSessions(projectId);
    } catch (error) {
      return storeFault(error);
    }
  });

  peer.register("session/create", parseCreateSession, ({ projectId, title }) => {
    try {
      return dependencies.store.createSession(projectId, title);
    } catch (error) {
      return storeFault(error);
    }
  });

  peer.register("session/load", parseSession, ({ sessionId }) => {
    try {
      return dependencies.store.loadSession(sessionId);
    } catch (error) {
      return storeFault(error);
    }
  });

  peer.register("config/status", parseConfigStatus, async () => {
    try {
      return await dependencies.configService.status();
    } catch (error) {
      return configFault(error);
    }
  });

  peer.register("config/save", parseSaveModelConfigInput, async (input) => {
    try {
      return await dependencies.configService.save(input);
    } catch (error) {
      return configFault(error);
    }
  });

  peer.register("config/test", parseConfigTest, async () => {
    try {
      return await dependencies.configService.testConnection(new AbortController().signal);
    } catch (error) {
      return configFault(error);
    }
  });
}
