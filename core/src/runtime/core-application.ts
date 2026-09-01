import {
  AgentBusyError,
  AgentOrchestrator,
  type AgentRunInput,
  type AgentRunResult,
} from "../agent/orchestrator.ts";
import {
  ModelConfigOperationError,
  ModelConfigService,
  type EffectiveModelConfig,
} from "../config/model-config.ts";
import { OpenAIChatClient, OpenAIModelConnectionTester } from "../llm/openai-chat-client.ts";
import type { ModelProvider } from "../llm/types.ts";
import { MemoryStore } from "../memory/memory-store.ts";
import { openDatabase, type DatabaseConnection } from "../persistence/database.ts";
import { acquireDataRootLock } from "../persistence/data-root-lock.ts";
import { resolveDataPaths } from "../persistence/data-paths.ts";
import type { DataPathOptions } from "../persistence/data-paths.ts";
import { SessionStore } from "../persistence/session-store.ts";
import type { JsonRpcPeer } from "../protocol/rpc-peer.ts";
import type { ProjectIdentityOptions } from "../project/project-identity.ts";
import { registerCoreHandlers, type AgentControl } from "../rpc/core-handlers.ts";
import { WorkspaceGuard } from "../security/workspace-guard.ts";
import { recoverInterruptedState } from "../session/recovery.ts";
import { editFileTool } from "../tools/edit-file.ts";
import { listFilesTool } from "../tools/list-files.ts";
import { JsonRpcPermissionClient } from "../tools/permission.ts";
import { readFileTool } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { runCommandTool } from "../tools/run-command.ts";
import { searchTextTool } from "../tools/search-text.ts";
import { writeFileTool } from "../tools/write-file.ts";
import { memoryWriteTool } from "../tools/memory-write.ts";

export type ModelProviderFactory = (config: EffectiveModelConfig) => ModelProvider;

export interface CoreApplicationOptions extends DataPathOptions {
  readonly providerFactory?: ModelProviderFactory;
  readonly projectIdentityOptions?: ProjectIdentityOptions;
}

export interface CoreApplication {
  readonly store: SessionStore;
  readonly connection: DatabaseConnection;
  close(): void;
}

class PerSessionAgent implements AgentControl {
  private readonly store: SessionStore;
  private readonly configService: ModelConfigService;
  private readonly peer: JsonRpcPeer;
  private readonly providerFactory: ModelProviderFactory;
  private readonly memoryStore: MemoryStore;
  private active: AgentOrchestrator | undefined;
  private busy = false;

  constructor(
    store: SessionStore,
    configService: ModelConfigService,
    peer: JsonRpcPeer,
    providerFactory: ModelProviderFactory,
    memoryStore: MemoryStore,
  ) {
    this.store = store;
    this.configService = configService;
    this.peer = peer;
    this.providerFactory = providerFactory;
    this.memoryStore = memoryStore;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.busy) {
      throw new AgentBusyError();
    }
    this.busy = true;
    try {
      const project = this.store.loadProjectForSession(input.sessionId);
      const config = await this.configService.loadEffective();
      if (!config.runnable) {
        throw new ModelConfigOperationError("not_configured", "Model configuration is not runnable");
      }
      const workspace = await WorkspaceGuard.create(project.rootPath);
      const tools = new ToolRegistry();
      tools.register(listFilesTool);
      tools.register(readFileTool);
      tools.register(editFileTool);
      tools.register(runCommandTool);
      tools.register(searchTextTool);
      tools.register(writeFileTool);
      tools.register(memoryWriteTool);
      const orchestrator = new AgentOrchestrator({
        store: this.store,
        provider: this.providerFactory(config),
        tools,
        permissionClient: new JsonRpcPermissionClient(this.peer),
        workspace,
        contextLimit: config.contextLimit,
        maxOutputTokens: config.maxOutputTokens,
        notify: (notification) => this.peer.notify(notification.method, notification.params),
        memory: { store: this.memoryStore, projectId: project.id },
      });
      this.active = orchestrator;
      return await orchestrator.run(input);
    } finally {
      this.active = undefined;
      this.busy = false;
    }
  }

  cancel(): boolean {
    return this.active?.cancel() ?? false;
  }
}

export async function createCoreApplication(
  peer: JsonRpcPeer,
  options: CoreApplicationOptions = {},
): Promise<CoreApplication> {
  const pathOptions: DataPathOptions = {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  };
  const rootLock = await acquireDataRootLock(resolveDataPaths(pathOptions).database);
  let connection: DatabaseConnection;
  try {
    connection = await openDatabase(pathOptions);
  } catch (error) {
    rootLock.release();
    throw error;
  }
  try {
    const store = new SessionStore(connection.db);
    const memoryStore = new MemoryStore(pathOptions);
    const recovered = recoverInterruptedState(store);
    const configService = new ModelConfigService({
      ...pathOptions,
      connectionTester: new OpenAIModelConnectionTester(),
    });
    const agent = new PerSessionAgent(
      store,
      configService,
      peer,
      options.providerFactory ?? ((config) => new OpenAIChatClient(config)),
      memoryStore,
    );
    registerCoreHandlers(peer, {
      store,
      configService,
      memoryStore,
      agent,
      startup: { interruptedCount: recovered.interruptedCount },
      ...(options.projectIdentityOptions === undefined
        ? {}
        : { projectIdentityOptions: options.projectIdentityOptions }),
    });
    let closed = false;
    return {
      store,
      connection,
      close: () => {
        if (closed) return;
        closed = true;
        try {
          connection.close();
        } finally {
          rootLock.release();
        }
      },
    };
  } catch (error) {
    connection.close();
    rootLock.release();
    throw error;
  }
}
