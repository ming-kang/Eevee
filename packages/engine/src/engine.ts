import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import type {
  ConversationWatch,
  ConversationWindow,
  EntryId,
  EntryQuery,
  Report,
  Submission,
} from "@earendil-works/pi-durable";
import {
  createMcpHub,
  getConversationTask,
  isTaskTerminalStatus,
  type McpHub,
  type McpHubOptions,
  McpOAuthCredentialStore,
  parseMcpConfig,
  resolveTaskId,
  sliceRetainedOutput,
  TASK_READ_MAX_BYTES,
  validateMcpServerEntry,
  validateOutputReadOptions,
} from "@eevee/agent";
import { MODELS_FILE, ModelRuntime } from "@eevee/agent/models";
import type {
  BoardView,
  ListWorkerTasksOptions as CoreListWorkerTasksOptions,
  QuestionId as CoreQuestionId,
  WorkerId as CoreWorkerId,
  ModelSlots,
  OutputReadOptions,
  OutputSlice,
  ProjectHandle,
  ProjectTarget,
} from "@eevee/core";
import { ProjectError } from "@eevee/core";
import {
  type AnswerQuestionRequest,
  type AnswerQuestionResponse,
  type BackgroundTaskRecordPayload,
  type BackgroundTaskStatus,
  type BuiltinModelMatchRequest,
  type BuiltinModelMatchResponse,
  type ConfigBundle,
  type ConversationRef,
  type CreateProjectRequest,
  type DeleteProjectResponse,
  type EngineSettings,
  EngineSettingsSchema,
  type EntryRecordPayload,
  type GetProjectResponse,
  type ImportProviderModelsRequest,
  type ImportProviderModelsResponse,
  type KillWorkerTaskResponse,
  type ListEntriesResponse,
  type ListModelsResponse,
  type ListProvidersResponse,
  type ListWorkerTasksResponse,
  type LoginInputRequest,
  type McpLogsResponse,
  type McpOAuthEvent,
  type McpOAuthInputRequest,
  type McpStateResponse,
  type ModelProfilesDocument,
  ModelProfilesDocumentSchema,
  type OkResponse,
  type ProbeProviderRequest,
  type ProbeProviderResponse,
  type ProjectMcpStateResponse,
  type ProjectMemoryResponse,
  type ProjectSummary,
  type ProjectUsageResponse,
  type ProviderCatalogResponse,
  type ProviderDetailResponse,
  type PutMcpConfigRequest,
  type PutProjectMemoryRequest,
  type PutSkillsPolicyRequest,
  parseWithSchema,
  type QuestionId,
  type ReadWorkerTaskResponse,
  type ReconnectMcpRequest,
  type ReconnectMcpResponse,
  type RefreshModelsRequest,
  type RefreshModelsResponse,
  type ReloadModelsResponse,
  type ScanOrder,
  type SendMessageRequest,
  type SendMessageResponse,
  type SetApiKeyRequest,
  type SkillsListResponse,
  type SmokeTestModelRequest,
  type SmokeTestModelResponse,
  type StartLoginRequest,
  type StartLoginResponse,
  type StartMcpOAuthResponse,
  type TaskStreamChunkEvent,
  type UpdateProjectRequest,
  type UpsertMcpServerRequest,
  type UpsertProviderModelRequest,
  type UpsertProviderRequest,
  type WorkerId,
} from "@eevee/protocol";
import { type DataDirLayout, dataDirLayout, projectPaths, resolveDataDir } from "./data-dir.ts";
import {
  type EngineKnobs,
  engineKnobs,
  exportEngineConfig,
  getMcpServersRecord,
  importEngineConfig,
  KV_MCP_SERVERS,
  KV_MODEL_PROFILES,
  KV_SETTINGS,
  mergeEngineSettings,
  readEngineSettings,
  readModelProfiles,
} from "./engine-config.ts";
import { EngineError } from "./engine-error.ts";
import {
  deleteMcpServer,
  deleteProjectMcpServer,
  getMcpLogs,
  getMcpState,
  getProjectMcpLogs,
  getProjectMcpState,
  type McpDeps,
  putMcpConfig,
  putProjectMcpConfig,
  reconnectMcp,
  reconnectProjectMcp,
  upsertMcpServer,
  upsertProjectMcpServer,
} from "./engine-mcp.ts";
import {
  decodeCursor,
  encodeCursor,
  listModels,
  listProviders,
  logoutProvider,
  type ProviderDeps,
  refreshModels,
  setProviderApiKey,
  toEngineError,
} from "./engine-providers.ts";
import {
  createProvider,
  createProviderModel,
  deleteProvider,
  deleteProviderModel,
  getProviderCatalog,
  getProviderDetail,
  importProviderModels,
  matchBuiltinModel,
  probeDraftProvider,
  probeProvider,
  reloadModels,
  testProviderModel,
  updateProvider,
  updateProviderModel,
} from "./engine-providers-manage.ts";
import {
  expandMessageSkills,
  listSkills,
  putGlobalSkillsPolicy,
  putProjectSkillsPolicy,
  type SkillsDeps,
} from "./engine-skills.ts";
import { LoginSessionManager, type LoginSseFrame } from "./login-sessions.ts";
import { McpOAuthSessionManager } from "./mcp-oauth-sessions.ts";
import { type OpenProjectStorage, ProjectPool } from "./project-pool.ts";
import { EngineStore } from "./store.ts";

export { formatModelProfiles } from "./engine-config.ts";
export { EngineError } from "./engine-error.ts";
export type { LoginSseFrame } from "./login-sessions.ts";
export type { OpenProjectStorage } from "./project-pool.ts";

export type ListEntriesParams = {
  readonly order?: ScanOrder;
  readonly limit?: number;
  readonly minEntryId?: number;
  readonly maxEntryId?: number;
  readonly cursor?: string;
};

export type WorkerTaskStreamCallbacks = {
  readonly onChunk: (chunk: TaskStreamChunkEvent) => void;
  readonly onStatus: (task: BackgroundTaskRecordPayload) => void;
  readonly onEnd: (reason: "completed" | "terminal") => void;
};

export type WorkerTaskStream = {
  readonly snapshot: ReadWorkerTaskResponse;
  readonly terminal: boolean;
  start(callbacks: WorkerTaskStreamCallbacks): void;
  close(): void;
};

function taskStatusPhase(status: BackgroundTaskStatus): number {
  switch (status) {
    case "queued":
      return 0;
    case "running":
      return 1;
    case "stopping":
      return 2;
    default:
      return 3;
  }
}

export type EngineOptions = {
  readonly dataDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly userHomeDir?: string | null;
  readonly models?: Models | (() => Models);
  readonly credentials?: CredentialStore;
  readonly openProjectStorage?: OpenProjectStorage;
  readonly createMcpTransport?: McpHubOptions["createTransport"];
  readonly defaultModelSlots?: ModelSlots;
  readonly maxActiveWorkers?: number;
  readonly backgroundAfterMs?: number;
  readonly routerContextTokens?: number;
  readonly idleHibernateMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly onReport?: (projectId: string, report: Report) => void;
  readonly onPumpError?: (projectId: string, error: unknown) => void;
};

function conversationTarget(ref: ConversationRef): ProjectTarget {
  return ref === "router" ? "router" : (ref as CoreWorkerId);
}

async function submissionResponse(submission: Submission): Promise<SendMessageResponse> {
  const { status } = await submission.status(BACKGROUND_CONTEXT);
  return { submissionId: submission.id, status };
}

export class Engine {
  readonly layout: DataDirLayout;
  readonly store: EngineStore;
  readonly modelRuntime: ModelRuntime;
  readonly mcpHub: McpHub;
  readonly oauthStore: McpOAuthCredentialStore;

  readonly #mcpLogPath: string;
  readonly #options: EngineOptions;
  readonly #knobs: EngineKnobs;
  readonly #pool: ProjectPool;
  readonly #loginSessions = new LoginSessionManager();
  readonly #mcpOAuthSessions = new McpOAuthSessionManager();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  private constructor(
    layout: DataDirLayout,
    store: EngineStore,
    modelRuntime: ModelRuntime,
    mcpHub: McpHub,
    oauthStore: McpOAuthCredentialStore,
    mcpLogPath: string,
    options: EngineOptions,
  ) {
    this.layout = layout;
    this.store = store;
    this.modelRuntime = modelRuntime;
    this.mcpHub = mcpHub;
    this.oauthStore = oauthStore;
    this.#mcpLogPath = mcpLogPath;
    this.#options = options;
    this.#knobs = engineKnobs(store, {
      defaultModelSlots: options.defaultModelSlots,
      maxActiveWorkers: options.maxActiveWorkers,
      backgroundAfterMs: options.backgroundAfterMs,
      routerContextTokens: options.routerContextTokens,
      idleHibernateMs: options.idleHibernateMs,
    });
    this.#pool = new ProjectPool({
      layout,
      store,
      mcpHub,
      oauthStore,
      models: () => this.models(),
      knobs: this.#knobs,
      env: options.env,
      userHomeDir: options.userHomeDir,
      createMcpTransport: options.createMcpTransport,
      openProjectStorage: options.openProjectStorage,
      onReport: options.onReport,
      onPumpError: options.onPumpError,
    });
  }

  static async open(options: EngineOptions = {}): Promise<Engine> {
    const root = options.dataDir ?? resolveDataDir(options.env);
    const layout = dataDirLayout(root);
    await mkdir(layout.root, { recursive: true });
    await mkdir(layout.projectsDir, { recursive: true });

    const store = EngineStore.open(layout.engineDb);
    let mcpHub: McpHub | undefined;
    try {
      const modelRuntime = await ModelRuntime.open({
        dir: layout.root,
        env: options.env,
      });
      const oauthStore = new McpOAuthCredentialStore(layout.root);
      const mcpLogPath = join(layout.root, "logs", "mcp.log");
      const storedMcp = store.getKv<Record<string, unknown>>(KV_MCP_SERVERS) ?? {};
      const parsedMcp = parseMcpConfig({ mcpServers: storedMcp });
      mcpHub = createMcpHub({
        servers: parsedMcp.servers,
        env: options.env,
        oauthStore,
        logPath: mcpLogPath,
        ...(options.createMcpTransport === undefined
          ? {}
          : { createTransport: options.createMcpTransport }),
      });
      mcpHub.startBackground();
      return new Engine(layout, store, modelRuntime, mcpHub, oauthStore, mcpLogPath, options);
    } catch (error) {
      await mcpHub?.close().catch(() => undefined);
      store.close();
      throw error;
    }
  }

  models(): Models {
    const override = this.#options.models;
    if (override !== undefined) {
      return typeof override === "function" ? override() : override;
    }
    return this.modelRuntime.models();
  }

  async reloadModels(): Promise<ReloadModelsResponse> {
    this.#assertOpen();
    return reloadModels(this.#providerDeps());
  }

  async getProviderCatalog(): Promise<ProviderCatalogResponse> {
    this.#assertOpen();
    return getProviderCatalog(this.#providerDeps());
  }

  async getProviderDetail(providerId: string): Promise<ProviderDetailResponse> {
    this.#assertOpen();
    return getProviderDetail(this.#providerDeps(), providerId);
  }

  async createProvider(input: UpsertProviderRequest): Promise<ProviderDetailResponse> {
    this.#assertOpen();
    return createProvider(this.#providerDeps(), input);
  }

  async updateProvider(
    providerId: string,
    input: UpsertProviderRequest,
  ): Promise<ProviderDetailResponse> {
    this.#assertOpen();
    return updateProvider(this.#providerDeps(), providerId, input);
  }

  async deleteProvider(providerId: string): Promise<OkResponse> {
    this.#assertOpen();
    return deleteProvider(this.#providerDeps(), providerId);
  }

  async createProviderModel(
    providerId: string,
    input: UpsertProviderModelRequest,
  ): Promise<ProviderDetailResponse> {
    this.#assertOpen();
    return createProviderModel(this.#providerDeps(), providerId, input);
  }

  async updateProviderModel(
    providerId: string,
    modelId: string,
    input: UpsertProviderModelRequest,
  ): Promise<ProviderDetailResponse> {
    this.#assertOpen();
    return updateProviderModel(this.#providerDeps(), providerId, modelId, input);
  }

  async deleteProviderModel(providerId: string, modelId: string): Promise<ProviderDetailResponse> {
    this.#assertOpen();
    return deleteProviderModel(this.#providerDeps(), providerId, modelId);
  }

  async probeDraftProvider(
    input: ProbeProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProbeProviderResponse> {
    this.#assertOpen();
    return probeDraftProvider(this.#providerDeps(), input, signal);
  }

  async probeProvider(
    providerId: string,
    input: ProbeProviderRequest = {},
    signal?: AbortSignal,
  ): Promise<ProbeProviderResponse> {
    this.#assertOpen();
    return probeProvider(this.#providerDeps(), providerId, input, signal);
  }

  async importProviderModels(
    providerId: string,
    input: ImportProviderModelsRequest,
  ): Promise<ImportProviderModelsResponse> {
    this.#assertOpen();
    return importProviderModels(this.#providerDeps(), providerId, input);
  }

  async matchBuiltinModel(
    providerId: string,
    modelId: string,
    input: BuiltinModelMatchRequest = {},
  ): Promise<BuiltinModelMatchResponse> {
    this.#assertOpen();
    return matchBuiltinModel(this.#providerDeps(), providerId, modelId, input);
  }

  async testProviderModel(
    providerId: string,
    modelId: string,
    input: SmokeTestModelRequest = {},
    signal?: AbortSignal,
  ): Promise<SmokeTestModelResponse> {
    this.#assertOpen();
    return testProviderModel(this.#providerDeps(), providerId, modelId, input, signal);
  }

  async listProviders(): Promise<ListProvidersResponse> {
    this.#assertOpen();
    return listProviders(this.#providerDeps());
  }

  async setProviderApiKey(providerId: string, input: SetApiKeyRequest): Promise<OkResponse> {
    this.#assertOpen();
    return setProviderApiKey(this.#providerDeps(), providerId, input);
  }

  async logoutProvider(providerId: string): Promise<OkResponse> {
    this.#assertOpen();
    return logoutProvider(this.#providerDeps(), providerId);
  }

  startProviderLogin(providerId: string, input: StartLoginRequest): StartLoginResponse {
    this.#assertOpen();
    return this.#loginSessions.start(this.models(), providerId, input.type);
  }

  subscribeLoginSession(
    providerId: string,
    sessionId: string,
    onFrame: (frame: LoginSseFrame) => void,
  ): () => void {
    this.#assertOpen();
    return this.#loginSessions.subscribe(providerId, sessionId, onFrame);
  }

  submitLoginInput(providerId: string, sessionId: string, input: LoginInputRequest): OkResponse {
    this.#assertOpen();
    this.#loginSessions.submitInput(providerId, sessionId, input);
    return { ok: true };
  }

  cancelLoginSession(providerId: string, sessionId: string): OkResponse {
    this.#assertOpen();
    this.#loginSessions.cancel(providerId, sessionId);
    return { ok: true };
  }

  async listModels(opts?: {
    readonly provider?: string;
    readonly available?: boolean;
  }): Promise<ListModelsResponse> {
    this.#assertOpen();
    return listModels(this.#providerDeps(), opts);
  }

  async refreshModels(input: RefreshModelsRequest = {}): Promise<RefreshModelsResponse> {
    this.#assertOpen();
    return refreshModels(this.#providerDeps(), input);
  }

  getModelProfiles(): ModelProfilesDocument {
    this.#assertOpen();
    return readModelProfiles(this.store);
  }

  putModelProfiles(doc: ModelProfilesDocument): ModelProfilesDocument {
    this.#assertOpen();
    const validated = parseWithSchema(ModelProfilesDocumentSchema, doc, "ModelProfilesDocument");
    this.store.setKv(KV_MODEL_PROFILES, validated);
    return validated;
  }

  async listSkills(): Promise<SkillsListResponse> {
    this.#assertOpen();
    return listSkills(this.#skillsDeps());
  }

  async putSkillsPolicy(input: PutSkillsPolicyRequest): Promise<SkillsListResponse> {
    this.#assertOpen();
    return putGlobalSkillsPolicy(this.#skillsDeps(), input);
  }

  async listProjectSkills(projectId: string): Promise<SkillsListResponse> {
    this.#assertOpen();
    return listSkills(this.#skillsDeps(), projectId);
  }

  async putProjectSkillsPolicy(
    projectId: string,
    input: PutSkillsPolicyRequest,
  ): Promise<SkillsListResponse> {
    this.#assertOpen();
    return putProjectSkillsPolicy(this.#skillsDeps(), projectId, input);
  }

  getMcpState(): McpStateResponse {
    this.#assertOpen();
    return getMcpState(this.#mcpDeps());
  }

  async putMcpConfig(input: PutMcpConfigRequest): Promise<McpStateResponse> {
    this.#assertOpen();
    return putMcpConfig(this.#mcpDeps(), input);
  }

  async upsertMcpServer(name: string, input: UpsertMcpServerRequest): Promise<McpStateResponse> {
    this.#assertOpen();
    return upsertMcpServer(this.#mcpDeps(), name, input);
  }

  async deleteMcpServer(name: string): Promise<McpStateResponse> {
    this.#assertOpen();
    return deleteMcpServer(this.#mcpDeps(), name);
  }

  async reconnectMcp(input: ReconnectMcpRequest = {}): Promise<ReconnectMcpResponse> {
    this.#assertOpen();
    return reconnectMcp(this.#mcpDeps(), input);
  }

  getMcpLogs(serverName: string): McpLogsResponse {
    this.#assertOpen();
    return getMcpLogs(this.#mcpDeps(), serverName);
  }

  startMcpOAuth(serverName: string): StartMcpOAuthResponse {
    this.#assertOpen();
    const servers = getMcpServersRecord(this.store);
    if (!Object.hasOwn(servers, serverName)) {
      throw new EngineError(404, "mcp_server_not_found", `Unknown MCP server "${serverName}"`);
    }
    const config = validateMcpServerEntry(serverName, servers[serverName]);
    if (typeof config === "string") {
      throw new EngineError(400, "invalid_mcp_config", config);
    }
    if (!("url" in config)) {
      throw new EngineError(
        400,
        "mcp_oauth_unsupported",
        `MCP server "${serverName}" does not use HTTP transport`,
      );
    }
    if (config.enabled === false) {
      throw new EngineError(409, "mcp_server_disabled", `MCP server "${serverName}" is disabled`);
    }
    return this.#mcpOAuthSessions.start({
      serverName,
      serverUrl: config.url,
      store: this.oauthStore,
      ...(config.oauth === undefined ? {} : { settings: config.oauth }),
      env: this.#options.env,
      challenge: this.mcpHub.getAuthChallenge(serverName),
      onComplete: async (name) => {
        await this.mcpHub.reconnect(name).catch(() => undefined);
        await this.#pool.reconnectServerOnProjectHubs(name);
        await this.#pool.syncMcpExtensions();
      },
    });
  }

  subscribeMcpOAuthSession(
    serverName: string,
    sessionId: string,
    onEvent: (event: McpOAuthEvent) => void,
  ): () => void {
    this.#assertOpen();
    return this.#mcpOAuthSessions.subscribe(serverName, sessionId, onEvent);
  }

  submitMcpOAuthInput(
    serverName: string,
    sessionId: string,
    input: McpOAuthInputRequest,
  ): OkResponse {
    this.#assertOpen();
    this.#mcpOAuthSessions.submitInput(serverName, sessionId, input.redirectUrl);
    return { ok: true };
  }

  cancelMcpOAuth(serverName: string, sessionId: string): OkResponse {
    this.#assertOpen();
    this.#mcpOAuthSessions.cancel(serverName, sessionId);
    return { ok: true };
  }

  async logoutMcpOAuth(serverName: string): Promise<OkResponse> {
    this.#assertOpen();
    const servers = getMcpServersRecord(this.store);
    if (!Object.hasOwn(servers, serverName)) {
      throw new EngineError(404, "mcp_server_not_found", `Unknown MCP server "${serverName}"`);
    }
    const config = validateMcpServerEntry(serverName, servers[serverName]);
    if (typeof config === "string") {
      throw new EngineError(400, "invalid_mcp_config", config);
    }
    if (!("url" in config)) {
      throw new EngineError(
        400,
        "mcp_oauth_unsupported",
        `MCP server "${serverName}" does not use HTTP transport`,
      );
    }
    this.#mcpOAuthSessions.cancelForServer(serverName);
    await this.oauthStore.remove(serverName, config.url);
    if (config.enabled !== false) {
      await this.mcpHub.reconnect(serverName).catch(() => undefined);
      await this.#pool.reconnectServerOnProjectHubs(serverName);
      await this.#pool.syncMcpExtensions();
    }
    return { ok: true };
  }

  getProjectMcpState(projectId: string): ProjectMcpStateResponse {
    this.#assertOpen();
    return getProjectMcpState(this.#mcpDeps(), projectId);
  }

  async putProjectMcpConfig(
    projectId: string,
    input: PutMcpConfigRequest,
  ): Promise<ProjectMcpStateResponse> {
    this.#assertOpen();
    return putProjectMcpConfig(this.#mcpDeps(), projectId, input);
  }

  async upsertProjectMcpServer(
    projectId: string,
    serverName: string,
    input: UpsertMcpServerRequest,
  ): Promise<ProjectMcpStateResponse> {
    this.#assertOpen();
    return upsertProjectMcpServer(this.#mcpDeps(), projectId, serverName, input);
  }

  async deleteProjectMcpServer(
    projectId: string,
    serverName: string,
  ): Promise<ProjectMcpStateResponse> {
    this.#assertOpen();
    return deleteProjectMcpServer(this.#mcpDeps(), projectId, serverName);
  }

  async reconnectProjectMcp(
    projectId: string,
    input: ReconnectMcpRequest = {},
  ): Promise<ReconnectMcpResponse> {
    this.#assertOpen();
    return reconnectProjectMcp(this.#mcpDeps(), projectId, input);
  }

  getProjectMcpLogs(projectId: string, serverName: string): McpLogsResponse {
    this.#assertOpen();
    return getProjectMcpLogs(this.#mcpDeps(), projectId, serverName);
  }

  getSettings(): EngineSettings {
    this.#assertOpen();
    return readEngineSettings(this.store);
  }

  async patchSettings(patch: EngineSettings): Promise<EngineSettings> {
    this.#assertOpen();
    const validated = parseWithSchema(EngineSettingsSchema, patch, "EngineSettings");
    const next = mergeEngineSettings(this.getSettings(), validated);
    this.store.setKv(KV_SETTINGS, next);
    await this.#pool.applySettingsLive();
    return next;
  }

  async putSettings(next: EngineSettings): Promise<EngineSettings> {
    this.#assertOpen();
    const validated = parseWithSchema(EngineSettingsSchema, next, "EngineSettings");
    this.store.setKv(KV_SETTINGS, validated);
    await this.#pool.applySettingsLive();
    return validated;
  }

  async exportConfig(): Promise<ConfigBundle> {
    this.#assertOpen();
    return exportEngineConfig({ layout: this.layout, store: this.store });
  }

  async importConfig(input: ConfigBundle): Promise<ConfigBundle> {
    this.#assertOpen();
    return importEngineConfig(
      {
        layout: this.layout,
        store: this.store,
        modelRuntime: this.modelRuntime,
        mcpHub: this.mcpHub,
        env: this.#options.env,
        syncProjects: () => this.#pool.reloadGlobalMcpChanges(),
        applySettings: () => this.#pool.applySettingsLive(),
      },
      input,
    );
  }

  createProject(input: CreateProjectRequest): ProjectSummary {
    this.#assertOpen();
    if (input.workspaces.length === 0) {
      throw new EngineError(
        400,
        "invalid_request",
        "workspaces must contain at least one directory",
      );
    }
    try {
      return this.store.createProject(input);
    } catch (error) {
      if (error instanceof Error) {
        throw new EngineError(400, "invalid_request", error.message);
      }
      throw error;
    }
  }

  listProjects(): ProjectSummary[] {
    this.#assertOpen();
    return this.store.listProjects();
  }

  getProject(projectId: string): ProjectSummary {
    this.#assertOpen();
    if (this.#pool.isDeleting(projectId)) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    const project = this.store.getProject(projectId);
    if (project === undefined) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    return project;
  }

  async updateProject(projectId: string, patch: UpdateProjectRequest): Promise<GetProjectResponse> {
    this.#assertOpen();
    this.getProject(projectId);
    let updated: ProjectSummary | undefined;
    try {
      updated = this.store.updateProject(projectId, patch);
    } catch (error) {
      if (error instanceof Error) {
        throw new EngineError(400, "invalid_request", error.message);
      }
      throw error;
    }
    if (updated === undefined) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    const openHandle = this.#pool.getOpenHandle(projectId);
    if (openHandle !== undefined) {
      this.#pool.touch(projectId);
      if (patch.models !== undefined) {
        await openHandle.reconfigureRouterModel(this.#knobs.modelSlots(projectId).router);
      }
      if (patch.workspaces !== undefined) {
        await openHandle.reconfigureWorkspaces(updated.workspaces);
        await this.#pool.updateProjectMcpRoots(projectId, updated.workspaces);
      }
      if (patch.tools !== undefined) {
        await openHandle.reconfigureTools();
      }
    }
    return { project: updated };
  }

  async deleteProject(projectId: string): Promise<DeleteProjectResponse> {
    this.#assertOpen();
    this.getProject(projectId);
    await this.#pool.deleteOpenProject(projectId, async () => {
      this.store.deleteProject(projectId);
      const paths = projectPaths(this.layout, projectId);
      await rm(paths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    return { ok: true, id: projectId };
  }

  getProjectMemory(projectId: string): ProjectMemoryResponse {
    const project = this.getProject(projectId);
    return { projectId: project.id, memory: project.memory ?? null };
  }

  putProjectMemory(projectId: string, input: PutProjectMemoryRequest): ProjectMemoryResponse {
    this.#assertOpen();
    this.getProject(projectId);
    const updated = this.store.updateProject(projectId, { memory: input.memory });
    if (updated === undefined) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    this.#pool.touch(projectId);
    return { projectId: updated.id, memory: updated.memory ?? null };
  }

  async getProjectUsage(projectId: string): Promise<ProjectUsageResponse> {
    const handle = await this.openProject(projectId);
    const usage = await handle.usage(BACKGROUND_CONTEXT);
    return { projectId, usage };
  }

  async recoverProjects(): Promise<void> {
    this.#assertOpen();
    await this.#pool.recoverProjects();
  }

  isProjectOpen(projectId: string): boolean {
    return this.#pool.isProjectOpen(projectId);
  }

  acquireStream(projectId: string): () => void {
    return this.#pool.acquireStream(projectId);
  }

  async hibernateIdleProjects(now = Date.now()): Promise<string[]> {
    return this.#pool.hibernateIdleProjects(now);
  }

  async openProject(projectId: string): Promise<ProjectHandle> {
    this.#assertOpen();
    return this.#pool.openProject(projectId);
  }

  async sendMessage(
    projectId: string,
    ref: ConversationRef,
    input: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    this.#assertOpen();
    const expandedText = await expandMessageSkills(this.#skillsDeps(), projectId, input.text);
    const options = input.whenBusy === undefined ? undefined : { whenBusy: input.whenBusy };
    return this.#inProject(projectId, async (handle) =>
      submissionResponse(await handle.send(conversationTarget(ref), expandedText, options)),
    );
  }

  async listEntries(
    projectId: string,
    ref: ConversationRef,
    params: ListEntriesParams = {},
  ): Promise<ListEntriesResponse> {
    const limit = params.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new EngineError(400, "invalid_query", "limit must be an integer between 1 and 500");
    }
    const cursor = params.cursor === undefined ? undefined : decodeCursor(params.cursor);
    const query: Omit<EntryQuery, "conversationId"> = {
      ...(params.order === undefined ? {} : { order: params.order }),
      ...(params.minEntryId === undefined ? {} : { minEntryId: params.minEntryId as EntryId }),
      ...(params.maxEntryId === undefined ? {} : { maxEntryId: params.maxEntryId as EntryId }),
    };
    return this.#inProject(projectId, async (handle) => {
      const page = await handle.listEntries(
        conversationTarget(ref),
        query,
        limit,
        cursor,
        BACKGROUND_CONTEXT,
      );
      return {
        entries: page.items as unknown as EntryRecordPayload[],
        ...(page.next === undefined ? {} : { nextCursor: encodeCursor(page.next) }),
      };
    });
  }

  async interrupt(projectId: string, ref: ConversationRef): Promise<OkResponse> {
    return this.#inProject(projectId, async (handle) => {
      await handle.interrupt(conversationTarget(ref), BACKGROUND_CONTEXT);
      return { ok: true };
    });
  }

  async retry(projectId: string, ref: ConversationRef): Promise<SendMessageResponse> {
    return this.#inProject(projectId, async (handle) =>
      submissionResponse(await handle.retry(conversationTarget(ref), BACKGROUND_CONTEXT)),
    );
  }

  async answerQuestion(
    projectId: string,
    questionId: QuestionId,
    input: AnswerQuestionRequest,
  ): Promise<AnswerQuestionResponse> {
    return this.#inProject(projectId, async (handle) => ({
      question: await handle.answerQuestion(
        questionId as CoreQuestionId,
        input.answers,
        BACKGROUND_CONTEXT,
      ),
    }));
  }

  async listWorkerTasks(
    projectId: string,
    workerId: WorkerId,
    options?: CoreListWorkerTasksOptions,
  ): Promise<ListWorkerTasksResponse> {
    if (
      options?.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
    ) {
      throw new EngineError(400, "invalid_query", "limit must be an integer between 1 and 100");
    }
    return this.#inProject(projectId, async (handle) => ({
      tasks: [
        ...(await handle.listWorkerTasks(workerId as CoreWorkerId, options, BACKGROUND_CONTEXT)),
      ],
    }));
  }

  async readWorkerTask(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
    options?: OutputReadOptions,
  ): Promise<ReadWorkerTaskResponse> {
    if (options !== undefined) {
      try {
        validateOutputReadOptions(options);
      } catch (error) {
        throw new EngineError(
          400,
          "invalid_query",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return this.#inProject(projectId, (handle) =>
      handle.readWorkerTaskOutput(workerId as CoreWorkerId, taskId, options, BACKGROUND_CONTEXT),
    );
  }

  async subscribeWorkerTaskStream(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
    options?: OutputReadOptions,
  ): Promise<WorkerTaskStream> {
    if (options !== undefined) {
      try {
        validateOutputReadOptions(options);
      } catch (error) {
        throw new EngineError(
          400,
          "invalid_query",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return this.#inProject(projectId, async (handle) => {
      const workers = await handle.workers(BACKGROUND_CONTEXT);
      const worker = workers.find((candidate) => candidate.id === workerId);
      if (worker === undefined) {
        throw new ProjectError("worker_not_found", `Unknown worker ${workerId}`);
      }

      const tasks = await handle.listWorkerTasks(
        workerId as CoreWorkerId,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const resolution = resolveTaskId(tasks, taskId);
      if (resolution.kind === "not_found") {
        throw new ProjectError("task_not_found", `Unknown task ${taskId} on worker ${workerId}`);
      }
      if (resolution.kind === "ambiguous") {
        throw new EngineError(
          400,
          "task_ambiguous",
          `Ambiguous task id "${taskId}" on worker ${workerId}`,
        );
      }
      const resolvedId = resolution.record.id;

      if (isTaskTerminalStatus(resolution.record.status)) {
        const snapshot = await handle.readWorkerTaskOutput(
          workerId as CoreWorkerId,
          resolvedId,
          options,
          BACKGROUND_CONTEXT,
        );
        return {
          snapshot,
          terminal: true,
          start: () => {},
          close: () => {},
        };
      }

      let closed = false;
      let started = false;
      let callbacks: WorkerTaskStreamCallbacks | undefined;
      const bufferedChunks: string[] = [];
      const bufferedBoards: BoardView[] = [];
      let unsubOutput: (() => void) | undefined;
      let unsubBoard: (() => void) | undefined;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubOutput?.();
        unsubOutput = undefined;
        unsubBoard?.();
        unsubBoard = undefined;
        bufferedChunks.length = 0;
        bufferedBoards.length = 0;
      };

      let handleBoard = (_board: BoardView) => {};

      unsubBoard = handle.subscribeBoard((board) => {
        if (closed) return;
        if (!started) {
          bufferedBoards.push(board);
          return;
        }
        handleBoard(board);
      });

      const running = handle.tasks.get(worker.conversationId, resolvedId);
      let snapshot: ReadWorkerTaskResponse;
      if (running !== undefined) {
        unsubOutput = running.onOutput((chunk) => {
          if (closed) return;
          if (!started) {
            bufferedChunks.push(chunk);
            return;
          }
          emitChunkText(chunk);
        });
        const live = running.output();
        const initialOutput = sliceRetainedOutput(
          Buffer.from(live.text, "utf8"),
          live.droppedBytes,
          live.totalBytes,
          options,
        );
        const freshTask = await getConversationTask(
          handle.harness,
          worker.conversationId,
          resolvedId,
          BACKGROUND_CONTEXT,
        );
        const task = freshTask ?? resolution.record;
        if (isTaskTerminalStatus(task.status)) {
          cleanup();
          const finalSnapshot = await handle.readWorkerTaskOutput(
            workerId as CoreWorkerId,
            resolvedId,
            options,
            BACKGROUND_CONTEXT,
          );
          return {
            snapshot: finalSnapshot,
            terminal: true,
            start: () => {},
            close: () => {},
          };
        }
        snapshot = { task, output: initialOutput };
      } else {
        snapshot = await handle.readWorkerTaskOutput(
          workerId as CoreWorkerId,
          resolvedId,
          options,
          BACKGROUND_CONTEXT,
        );
        if (isTaskTerminalStatus(snapshot.task.status)) {
          cleanup();
          return {
            snapshot,
            terminal: true,
            start: () => {},
            close: () => {},
          };
        }
      }

      let cursorByte = snapshot.output.totalBytes;
      let lastTask = snapshot.task;
      let lastTaskJson = JSON.stringify(lastTask);
      let pendingBoard = Promise.resolve();

      const emitChunkText = (text: string) => {
        if (closed) return;
        const byteLen = Buffer.byteLength(text, "utf8");
        if (byteLen === 0) return;
        const fromByte = cursorByte;
        const endByte = fromByte + byteLen;
        cursorByte = endByte;
        callbacks?.onChunk({ text, fromByte, endByte, totalBytes: endByte });
      };

      const emitChunkSlice = (slice: OutputSlice) => {
        if (closed) return;
        if (slice.fromByte < cursorByte || slice.endByte <= cursorByte || slice.text.length === 0) {
          return;
        }
        cursorByte = slice.endByte;
        callbacks?.onChunk({
          text: slice.text,
          fromByte: slice.fromByte,
          endByte: slice.endByte,
          totalBytes: slice.totalBytes,
        });
      };

      const processBoard = async (board: BoardView): Promise<void> => {
        if (closed) return;
        const boardWorker = board.workers.find((candidate) => candidate.id === workerId);
        let candidate = boardWorker?.tasks.find((task) => task.id === resolvedId);
        if (candidate === undefined) {
          candidate = await getConversationTask(
            handle.harness,
            worker.conversationId,
            resolvedId,
            BACKGROUND_CONTEXT,
          );
          if (candidate === undefined || closed) return;
        }
        if (taskStatusPhase(candidate.status) < taskStatusPhase(lastTask.status)) {
          return;
        }
        const candidateJson = JSON.stringify(candidate);
        if (isTaskTerminalStatus(candidate.status)) {
          unsubOutput?.();
          unsubOutput = undefined;
          for (;;) {
            if (closed) return;
            const read = await handle.readWorkerTaskOutput(
              workerId as CoreWorkerId,
              resolvedId,
              { mode: "head", sinceBytes: cursorByte, bytes: TASK_READ_MAX_BYTES },
              BACKGROUND_CONTEXT,
            );
            const slice = read.output;
            if (
              slice.fromByte >= cursorByte &&
              slice.endByte > cursorByte &&
              slice.text.length > 0
            ) {
              emitChunkSlice(slice);
              if (slice.endByte < slice.totalBytes) continue;
            }
            break;
          }
          if (closed) return;
          lastTask = candidate;
          lastTaskJson = candidateJson;
          callbacks?.onStatus(candidate);
          const onEnd = callbacks?.onEnd;
          cleanup();
          onEnd?.("completed");
          return;
        }
        if (candidateJson !== lastTaskJson) {
          lastTask = candidate;
          lastTaskJson = candidateJson;
          callbacks?.onStatus(candidate);
        }
      };

      handleBoard = (board: BoardView) => {
        pendingBoard = pendingBoard.then(() => processBoard(board)).catch(() => undefined);
      };

      return {
        snapshot,
        terminal: false,
        start: (nextCallbacks) => {
          if (closed || started) return;
          started = true;
          callbacks = nextCallbacks;
          const queuedChunks = bufferedChunks.splice(0, bufferedChunks.length);
          for (const chunk of queuedChunks) {
            emitChunkText(chunk);
          }
          const queuedBoards = bufferedBoards.splice(0, bufferedBoards.length);
          for (const board of queuedBoards) {
            handleBoard(board);
          }
        },
        close: cleanup,
      };
    });
  }

  async killWorkerTask(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
  ): Promise<KillWorkerTaskResponse> {
    return this.#inProject(projectId, async (handle) => ({
      task: await handle.killWorkerTask(workerId as CoreWorkerId, taskId, BACKGROUND_CONTEXT),
    }));
  }

  async getBoard(projectId: string): Promise<BoardView> {
    const handle = await this.openProject(projectId);
    return handle.board(BACKGROUND_CONTEXT);
  }

  async watchConversation(
    projectId: string,
    ref: ConversationRef,
    context: Context = BACKGROUND_CONTEXT,
    window?: ConversationWindow,
  ): Promise<ConversationWatch> {
    return this.#inProject(projectId, (handle) =>
      handle.watchConversation(conversationTarget(ref), context, window),
    );
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#dispose();
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new EngineError(503, "engine_closed", "Engine is closing");
    }
  }

  #providerDeps(): ProviderDeps {
    return {
      models: () => this.models(),
      ...(this.#options.models === undefined
        ? {
            runtime: () => this.modelRuntime,
            modelsFile: () => join(this.layout.root, MODELS_FILE),
          }
        : {}),
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      credentials: () => {
        if (this.#options.credentials !== undefined) return this.#options.credentials;
        if (this.#options.models === undefined) return this.modelRuntime.credentials;
        return undefined;
      },
    };
  }

  #skillsDeps(): SkillsDeps {
    return {
      store: this.store,
      ...(this.#options.userHomeDir === undefined
        ? {}
        : { userHomeDir: this.#options.userHomeDir }),
      requireProject: (projectId) => this.getProject(projectId),
    };
  }

  #mcpDeps(): McpDeps {
    return {
      layout: this.layout,
      store: this.store,
      mcpHub: this.mcpHub,
      globalLogPath: this.#mcpLogPath,
      requireProject: (projectId) => this.getProject(projectId),
      syncProjects: () => this.#pool.reloadGlobalMcpChanges(),
      syncExtensions: () => this.#pool.syncMcpExtensions(),
      getProjectMcpHub: (projectId) => this.#pool.getProjectMcpHub(projectId),
      openProjectMcpHub: (projectId) => this.#pool.openProjectMcpHub(projectId),
      syncProjectMcp: (projectId) => this.#pool.syncProjectMcp(projectId),
    };
  }

  async #inProject<T>(projectId: string, run: (handle: ProjectHandle) => Promise<T>): Promise<T> {
    const handle = await this.openProject(projectId);
    try {
      return await run(handle);
    } catch (error) {
      throw toEngineError(error);
    } finally {
      this.#pool.touch(projectId);
    }
  }

  async #dispose(): Promise<void> {
    this.#closed = true;
    await this.#loginSessions.close().catch(() => undefined);
    await this.#mcpOAuthSessions.close().catch(() => undefined);
    await this.#pool.closeAll();
    await this.mcpHub.close().catch(() => undefined);
    this.store.close();
  }
}
