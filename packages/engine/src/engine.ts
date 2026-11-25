import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import {
  type CommitObservation,
  ConversationBusy,
  type ConversationWatch,
  type ConversationWindow,
  type Cursor,
  type EntryId,
  type EntryQuery,
  type Report,
  type Storage,
  StorageRequestError,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  createMcpHub,
  type McpHub,
  type McpHubOptions,
  parseMcpConfig,
  validateMcpServerEntry,
} from "@eevee/agent";
import {
  composeProviders,
  ModelRuntime,
  ModelsConfigError,
  parseModelsConfig,
} from "@eevee/agent/models";
import {
  type BoardView,
  type QuestionId as CoreQuestionId,
  type WorkerId as CoreWorkerId,
  type ModelSlots,
  type OutputReadOptions,
  openProject as openCoreProject,
  type ProjectHandle,
} from "@eevee/core";
import {
  type AnswerQuestionRequest,
  type AnswerQuestionResponse,
  type ConfigBundle,
  ConfigBundleSchema,
  type ConversationRef,
  type CreateProjectRequest,
  type DeleteProjectResponse,
  type EngineSettings,
  EngineSettingsSchema,
  type EntryRecordPayload,
  type GetProjectResponse,
  type KillWorkerTaskResponse,
  type ListEntriesResponse,
  type ListModelsResponse,
  type ListProvidersResponse,
  type LoginInputRequest,
  type McpStateResponse,
  type ModelInfo,
  type ModelProfilesDocument,
  ModelProfilesDocumentSchema,
  type OkResponse,
  type ProjectMemoryResponse,
  type ProjectSummary,
  type ProjectUsageResponse,
  type PutMcpConfigRequest,
  type PutProjectMemoryRequest,
  parseWithSchema,
  type QuestionId,
  type ReadWorkerTaskResponse,
  type ReconnectMcpRequest,
  type ReconnectMcpResponse,
  type RefreshModelsRequest,
  type RefreshModelsResponse,
  type ScanOrder,
  type SendMessageRequest,
  type SendMessageResponse,
  type SetApiKeyRequest,
  type StartLoginRequest,
  type StartLoginResponse,
  type UpdateProjectRequest,
  type UpsertMcpServerRequest,
  type WorkerId,
} from "@eevee/protocol";
import { type DataDirLayout, dataDirLayout, projectPaths, resolveDataDir } from "./data-dir.ts";
import { EngineError } from "./engine-error.ts";
import { LoginSessionManager, type LoginSseFrame } from "./login-sessions.ts";
import { EngineStore } from "./store.ts";

export { EngineError } from "./engine-error.ts";
export type { LoginSseFrame } from "./login-sessions.ts";

const KV_SETTINGS = "settings";
const KV_MODEL_PROFILES = "model_profiles";
const KV_MCP_SERVERS = "mcp_servers";

const DEFAULT_MAX_ACTIVE_WORKERS = 3;
const DEFAULT_BACKGROUND_AFTER_MS = 30_000;
const DEFAULT_ROUTER_CONTEXT_TOKENS = 80_000;
const DEFAULT_IDLE_HIBERNATE_MS = 10 * 60_000;
const MAX_HIBERNATE_SWEEP_MS = 30_000;
const MIN_HIBERNATE_SWEEP_MS = 25;

export type ListEntriesParams = {
  readonly order?: ScanOrder;
  readonly limit?: number;
  readonly minEntryId?: number;
  readonly maxEntryId?: number;
  readonly cursor?: string;
};

export type OpenProjectStorage = (
  sessionDbPath: string,
  project: ProjectSummary,
) => Promise<Storage>;

export type EngineOptions = {
  readonly dataDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly models?: Models | (() => Models);
  readonly credentials?: CredentialStore;
  readonly openProjectStorage?: OpenProjectStorage;
  readonly createMcpTransport?: McpHubOptions["createTransport"];
  readonly defaultModelSlots?: ModelSlots;
  readonly maxActiveWorkers?: number;
  readonly backgroundAfterMs?: number;
  readonly routerContextTokens?: number;
  readonly idleHibernateMs?: number;
  readonly onReport?: (projectId: string, report: Report) => void;
  readonly onPumpError?: (projectId: string, error: unknown) => void;
};

type OpenProjectEntry = {
  readonly handle: ProjectHandle;
  readonly observation: CommitObservation;
  lastActivityAt: number;
};

export function formatModelProfiles(doc: ModelProfilesDocument): string | undefined {
  const notes = doc.notes?.trim();
  if (doc.profiles.length === 0 && !notes) return undefined;
  const lines: string[] = [];
  if (doc.profiles.length > 0) {
    lines.push(
      "Configured model profiles (pass `provider/modelId` and optional `thinkingLevel` to `spawn_worker` or `message_worker`):",
    );
    for (const profile of doc.profiles) {
      const thinking =
        profile.model.thinkingLevel === undefined
          ? ""
          : ` (thinking: ${profile.model.thinkingLevel})`;
      lines.push(
        `- ${profile.id}: ${profile.model.provider}/${profile.model.modelId}${thinking} — ${profile.description}`,
      );
    }
  }
  if (notes) {
    if (lines.length > 0) lines.push("");
    lines.push(notes);
  }
  return lines.join("\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, content, "utf8");
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function normalizeMcpMap(
  servers: readonly { readonly name: string; readonly config: object }[],
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    servers.map((entry) => [entry.name, { ...entry.config } as Record<string, unknown>]),
  );
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  if (raw.length === 0 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new EngineError(400, "invalid_query", "Invalid pagination cursor");
  }
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (!isPlainObject(parsed)) {
      throw new EngineError(400, "invalid_query", "Invalid pagination cursor");
    }
    return parsed as Cursor;
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError(400, "invalid_query", "Invalid pagination cursor");
  }
}

function mapCoreError(error: unknown): never {
  if (error instanceof ConversationBusy) {
    throw new EngineError(409, "conversation_busy", error.message);
  }
  if (error instanceof StorageRequestError) {
    throw new EngineError(400, "invalid_query", error.message);
  }
  if (error instanceof RangeError) {
    throw new EngineError(400, "invalid_request", error.message);
  }
  if (error instanceof Error) {
    if (
      /^Unknown worker /i.test(error.message) ||
      /^Worker .+ has no conversation$/i.test(error.message)
    ) {
      throw new EngineError(404, "worker_not_found", error.message);
    }
    if (/^Worker .+ is closed$/i.test(error.message)) {
      throw new EngineError(409, "worker_closed", error.message);
    }
    if (/^Worker .+ is queued$/i.test(error.message)) {
      throw new EngineError(409, "worker_queued", error.message);
    }
    if (/^Unknown question /i.test(error.message)) {
      throw new EngineError(404, "question_not_found", error.message);
    }
    if (/^Question .+ (?:is already answered|was withdrawn)$/i.test(error.message)) {
      throw new EngineError(409, "question_closed", error.message);
    }
    if (/^Question .+ expects .+ answer\(s\)/i.test(error.message)) {
      throw new EngineError(400, "invalid_request", error.message);
    }
    if (/^Unknown task /i.test(error.message)) {
      throw new EngineError(404, "task_not_found", error.message);
    }
    if (/^Task .+ is not running(?:\s|$)/i.test(error.message)) {
      throw new EngineError(409, "task_not_running", error.message);
    }
  }
  throw error;
}

export class Engine {
  readonly layout: DataDirLayout;
  readonly store: EngineStore;
  readonly modelRuntime: ModelRuntime;
  readonly mcpHub: McpHub;

  readonly #options: EngineOptions;
  readonly #projects = new Map<string, OpenProjectEntry>();
  readonly #opening = new Map<string, Promise<ProjectHandle>>();
  readonly #closingProjects = new Map<string, Promise<void>>();
  readonly #deletingProjects = new Set<string>();
  readonly #streamCounts = new Map<string, number>();
  readonly #loginSessions = new LoginSessionManager();
  #hibernateTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  private constructor(
    layout: DataDirLayout,
    store: EngineStore,
    modelRuntime: ModelRuntime,
    mcpHub: McpHub,
    options: EngineOptions,
  ) {
    this.layout = layout;
    this.store = store;
    this.modelRuntime = modelRuntime;
    this.mcpHub = mcpHub;
    this.#options = options;
    this.#rescheduleHibernateSweeper();
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
      const storedMcp = store.getKv<Record<string, unknown>>(KV_MCP_SERVERS) ?? {};
      const parsedMcp = parseMcpConfig({ mcpServers: storedMcp });
      mcpHub = createMcpHub({
        servers: parsedMcp.servers,
        env: options.env,
        ...(options.createMcpTransport === undefined
          ? {}
          : { createTransport: options.createMcpTransport }),
      });
      await mcpHub.start();
      return new Engine(layout, store, modelRuntime, mcpHub, options);
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

  async reloadModels(): Promise<void> {
    this.#assertOpen();
    await this.modelRuntime.reload();
  }

  async listProviders(): Promise<ListProvidersResponse> {
    this.#assertOpen();
    const models = this.models();
    const providers = await Promise.all(
      models.getProviders().map(async (provider) => {
        const check = await models.checkAuth(provider.id);
        let modelCount = 0;
        try {
          modelCount = provider.getModels().length;
        } catch {
          modelCount = 0;
        }
        return {
          id: provider.id,
          name: provider.name,
          ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
          authMethods: {
            apiKey: provider.auth.apiKey !== undefined,
            apiKeyLogin: provider.auth.apiKey?.login !== undefined,
            oauth: provider.auth.oauth !== undefined,
            ...(provider.auth.oauth?.name === undefined
              ? {}
              : { oauthName: provider.auth.oauth.name }),
            ...(provider.auth.oauth?.loginLabel === undefined
              ? {}
              : { oauthLabel: provider.auth.oauth.loginLabel }),
          },
          configured: check !== undefined,
          ...(check === undefined ? {} : { authType: check.type }),
          ...(check?.source === undefined ? {} : { authSource: check.source }),
          modelCount,
        };
      }),
    );
    return { providers };
  }

  async setProviderApiKey(providerId: string, input: SetApiKeyRequest): Promise<OkResponse> {
    this.#assertOpen();
    const models = this.models();
    const provider = models.getProvider(providerId);
    if (provider === undefined) {
      throw new EngineError(404, "provider_not_found", `Unknown provider ${providerId}`);
    }
    if (provider.auth.apiKey === undefined) {
      throw new EngineError(
        400,
        "auth_unsupported",
        `Provider ${providerId} does not support API key authentication`,
      );
    }
    if (
      (input.key === undefined && input.env === undefined) ||
      (input.key !== undefined && input.key.length === 0 && input.env === undefined)
    ) {
      throw new EngineError(400, "invalid_request", "API key request must provide key or env");
    }

    const credentials = this.#credentialStore();
    if (credentials !== undefined) {
      await credentials.modify(providerId, async () => ({
        type: "api_key",
        ...(input.key === undefined ? {} : { key: input.key }),
        ...(input.env === undefined ? {} : { env: input.env }),
      }));
      return { ok: true };
    }

    if (provider.auth.apiKey.login !== undefined && input.key !== undefined) {
      await models.login(providerId, "api_key", {
        prompt: async () => input.key ?? "",
        notify: () => {},
      });
      return { ok: true };
    }

    throw new EngineError(
      500,
      "credentials_unavailable",
      `Credential store is unavailable for provider ${providerId}`,
    );
  }

  async logoutProvider(providerId: string): Promise<OkResponse> {
    this.#assertOpen();
    const models = this.models();
    if (models.getProvider(providerId) === undefined) {
      throw new EngineError(404, "provider_not_found", `Unknown provider ${providerId}`);
    }
    await models.logout(providerId);
    return { ok: true };
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
    const models = this.models();
    const [catalog, availableModels] = await Promise.all([
      Promise.resolve(models.getModels(opts?.provider)),
      models.getAvailable(opts?.provider),
    ]);
    const availableKeys = new Set(availableModels.map((model) => `${model.provider}\0${model.id}`));
    const items: ModelInfo[] = [];
    for (const model of catalog) {
      const available = availableKeys.has(`${model.provider}\0${model.id}`);
      if (opts?.available !== undefined && available !== opts.available) continue;
      items.push({
        provider: model.provider,
        id: model.id,
        name: model.name,
        api: model.api,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        cost: model.cost,
        available,
      });
    }
    return { models: items };
  }

  async refreshModels(input: RefreshModelsRequest = {}): Promise<RefreshModelsResponse> {
    this.#assertOpen();
    const result = await this.models().refresh({
      ...(input.providers === undefined ? {} : { providers: input.providers }),
      ...(input.force === undefined ? {} : { force: input.force }),
    });
    const errors: Record<string, string> = {};
    for (const [providerId, error] of result.errors) {
      errors[providerId] = error.message;
    }
    return { refreshed: true, errors };
  }

  getModelProfiles(): ModelProfilesDocument {
    this.#assertOpen();
    const stored = this.store.getKv<unknown>(KV_MODEL_PROFILES);
    if (stored === undefined) return { profiles: [] };
    return parseWithSchema(ModelProfilesDocumentSchema, stored, "stored model_profiles");
  }

  putModelProfiles(doc: ModelProfilesDocument): ModelProfilesDocument {
    this.#assertOpen();
    const validated = parseWithSchema(ModelProfilesDocumentSchema, doc, "ModelProfilesDocument");
    this.store.setKv(KV_MODEL_PROFILES, validated);
    return validated;
  }

  getMcpState(): McpStateResponse {
    this.#assertOpen();
    return {
      servers: this.#getMcpServersRecord(),
      status: this.mcpHub.status(),
    };
  }

  async putMcpConfig(input: PutMcpConfigRequest): Promise<McpStateResponse> {
    this.#assertOpen();
    const parsed = parseMcpConfig({ mcpServers: input.servers });
    if (parsed.errors.length > 0) {
      throw new EngineError(400, "invalid_mcp_config", parsed.errors.join("; "));
    }
    const normalized = normalizeMcpMap(parsed.servers);
    this.store.setKv(KV_MCP_SERVERS, normalized);
    await this.mcpHub.reload(parsed.servers);
    await this.#syncOpenProjectsMcp();
    return this.getMcpState();
  }

  async upsertMcpServer(name: string, input: UpsertMcpServerRequest): Promise<McpStateResponse> {
    this.#assertOpen();
    const validated = validateMcpServerEntry(name, input.config);
    if (typeof validated === "string") {
      throw new EngineError(400, "invalid_mcp_config", validated);
    }
    const candidate = {
      ...this.#getMcpServersRecord(),
      [name]: { ...validated } as Record<string, unknown>,
    };
    const parsed = parseMcpConfig({ mcpServers: candidate });
    if (parsed.errors.length > 0) {
      throw new EngineError(400, "invalid_mcp_config", parsed.errors.join("; "));
    }
    const normalized = normalizeMcpMap(parsed.servers);
    this.store.setKv(KV_MCP_SERVERS, normalized);
    await this.mcpHub.reload(parsed.servers);
    await this.#syncOpenProjectsMcp();
    return this.getMcpState();
  }

  async deleteMcpServer(name: string): Promise<McpStateResponse> {
    this.#assertOpen();
    const current = { ...this.#getMcpServersRecord() };
    if (!Object.hasOwn(current, name)) {
      throw new EngineError(404, "mcp_server_not_found", `Unknown MCP server "${name}"`);
    }
    delete current[name];
    const parsed = parseMcpConfig({ mcpServers: current });
    if (parsed.errors.length > 0) {
      throw new EngineError(400, "invalid_mcp_config", parsed.errors.join("; "));
    }
    const normalized = normalizeMcpMap(parsed.servers);
    this.store.setKv(KV_MCP_SERVERS, normalized);
    await this.mcpHub.reload(parsed.servers);
    await this.#syncOpenProjectsMcp();
    return this.getMcpState();
  }

  async reconnectMcp(input: ReconnectMcpRequest = {}): Promise<ReconnectMcpResponse> {
    this.#assertOpen();
    try {
      const status = await this.mcpHub.reconnect(input.server);
      await this.#syncOpenProjectsMcp();
      return { status };
    } catch (error) {
      if (error instanceof Error) {
        if (/^Unknown MCP server /i.test(error.message)) {
          throw new EngineError(404, "mcp_server_not_found", error.message);
        }
        if (/^MCP server .+ is disabled$/i.test(error.message)) {
          throw new EngineError(409, "mcp_server_disabled", error.message);
        }
      }
      throw error;
    }
  }

  getSettings(): EngineSettings {
    this.#assertOpen();
    const stored = this.store.getKv<unknown>(KV_SETTINGS);
    if (stored === undefined) return {};
    return parseWithSchema(EngineSettingsSchema, stored, "stored settings");
  }

  async patchSettings(patch: EngineSettings): Promise<EngineSettings> {
    this.#assertOpen();
    const validated = parseWithSchema(EngineSettingsSchema, patch, "EngineSettings");
    const current = this.getSettings();
    const mergedModels =
      validated.models === undefined
        ? current.models
        : {
            ...current.models,
            ...validated.models,
          };
    const next: EngineSettings = {
      ...(validated.maxActiveWorkers !== undefined
        ? { maxActiveWorkers: validated.maxActiveWorkers }
        : current.maxActiveWorkers !== undefined
          ? { maxActiveWorkers: current.maxActiveWorkers }
          : {}),
      ...(validated.backgroundAfterMs !== undefined
        ? { backgroundAfterMs: validated.backgroundAfterMs }
        : current.backgroundAfterMs !== undefined
          ? { backgroundAfterMs: current.backgroundAfterMs }
          : {}),
      ...(validated.routerContextTokens !== undefined
        ? { routerContextTokens: validated.routerContextTokens }
        : current.routerContextTokens !== undefined
          ? { routerContextTokens: current.routerContextTokens }
          : {}),
      ...(validated.idleHibernateMs !== undefined
        ? { idleHibernateMs: validated.idleHibernateMs }
        : current.idleHibernateMs !== undefined
          ? { idleHibernateMs: current.idleHibernateMs }
          : {}),
      ...(mergedModels !== undefined ? { models: mergedModels } : {}),
    };
    this.store.setKv(KV_SETTINGS, next);
    await this.#applySettingsLive();
    return next;
  }

  async putSettings(next: EngineSettings): Promise<EngineSettings> {
    this.#assertOpen();
    const validated = parseWithSchema(EngineSettingsSchema, next, "EngineSettings");
    this.store.setKv(KV_SETTINGS, validated);
    await this.#applySettingsLive();
    return validated;
  }

  async exportConfig(): Promise<ConfigBundle> {
    this.#assertOpen();
    let modelsConfig: Record<string, unknown> | undefined;
    try {
      const text = await readFile(this.layout.modelsFile, "utf8");
      modelsConfig = parseModelsConfig(text) as unknown as Record<string, unknown>;
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    return {
      version: 1,
      settings: this.getSettings(),
      modelProfiles: this.getModelProfiles(),
      mcpServers: this.#getMcpServersRecord(),
      ...(modelsConfig === undefined ? {} : { modelsConfig }),
    };
  }

  async importConfig(input: ConfigBundle): Promise<ConfigBundle> {
    this.#assertOpen();
    const bundle = parseWithSchema(ConfigBundleSchema, input, "ConfigBundle");
    const parsedMcp = parseMcpConfig({ mcpServers: bundle.mcpServers });
    if (parsedMcp.errors.length > 0) {
      throw new EngineError(400, "invalid_mcp_config", parsedMcp.errors.join("; "));
    }

    let parsedModelsConfig: ReturnType<typeof parseModelsConfig> | undefined;
    if (bundle.modelsConfig !== undefined) {
      try {
        parsedModelsConfig = parseModelsConfig(JSON.stringify(bundle.modelsConfig));
        composeProviders(parsedModelsConfig, { env: this.#options.env });
      } catch (error) {
        if (error instanceof ModelsConfigError || error instanceof Error) {
          throw new EngineError(400, "invalid_models_config", error.message);
        }
        throw error;
      }
    }

    if (parsedModelsConfig !== undefined) {
      await writeTextAtomic(
        this.layout.modelsFile,
        `${JSON.stringify(parsedModelsConfig, null, 2)}\n`,
      );
      await this.modelRuntime.reload();
    }

    const normalizedMcp = normalizeMcpMap(parsedMcp.servers);
    this.store.setKv(KV_SETTINGS, bundle.settings);
    this.store.setKv(KV_MODEL_PROFILES, bundle.modelProfiles);
    this.store.setKv(KV_MCP_SERVERS, normalizedMcp);

    await this.mcpHub.reload(parsedMcp.servers);
    await this.#syncOpenProjectsMcp();
    await this.#applySettingsLive();
    return this.exportConfig();
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
    if (this.#deletingProjects.has(projectId)) {
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
    const openEntry = this.#projects.get(projectId);
    if (openEntry !== undefined) {
      openEntry.lastActivityAt = Date.now();
      if (patch.models !== undefined) {
        await openEntry.handle.reconfigureRouterModel(this.#effectiveModelSlots(projectId).router);
      }
    }
    return { project: updated };
  }

  async deleteProject(projectId: string): Promise<DeleteProjectResponse> {
    this.#assertOpen();
    this.getProject(projectId);
    if (this.#deletingProjects.has(projectId)) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    this.#deletingProjects.add(projectId);
    try {
      const opening = this.#opening.get(projectId);
      if (opening !== undefined) await opening.catch(() => undefined);
      const closing = this.#closingProjects.get(projectId);
      if (closing !== undefined) await closing.catch(() => undefined);
      if (this.#projects.has(projectId)) {
        await this.#closeOpenProject(projectId);
      }
      this.store.deleteProject(projectId);
      const paths = projectPaths(this.layout, projectId);
      await rm(paths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return { ok: true, id: projectId };
    } finally {
      this.#deletingProjects.delete(projectId);
    }
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
    const openEntry = this.#projects.get(projectId);
    if (openEntry !== undefined) openEntry.lastActivityAt = Date.now();
    return { projectId: updated.id, memory: updated.memory ?? null };
  }

  async getProjectUsage(projectId: string): Promise<ProjectUsageResponse> {
    const handle = await this.openProject(projectId);
    const usage = await handle.usage(BACKGROUND_CONTEXT);
    return { projectId, usage };
  }

  isProjectOpen(projectId: string): boolean {
    return this.#projects.has(projectId);
  }

  acquireStream(projectId: string): () => void {
    this.#streamCounts.set(projectId, (this.#streamCounts.get(projectId) ?? 0) + 1);
    this.#touchProject(projectId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.#streamCounts.get(projectId) ?? 0) - 1;
      if (next <= 0) this.#streamCounts.delete(projectId);
      else this.#streamCounts.set(projectId, next);
      this.#touchProject(projectId);
    };
  }

  async hibernateIdleProjects(now = Date.now()): Promise<string[]> {
    if (this.#closed) return [];
    const idleMs = this.#effectiveIdleHibernateMs();
    if (idleMs <= 0) return [];

    const candidates = [...this.#projects.entries()];
    const hibernated: string[] = [];

    for (const [projectId, entry] of candidates) {
      if (this.#closed) break;
      if ((this.#streamCounts.get(projectId) ?? 0) > 0) continue;
      if (now - entry.lastActivityAt < idleMs) continue;
      if (entry.handle.harness.wake().active) continue;

      let inspection: Awaited<ReturnType<ProjectHandle["harness"]["inspect"]>>;
      try {
        inspection = await entry.handle.harness.inspect(BACKGROUND_CONTEXT);
      } catch {
        continue;
      }
      if (inspection.tasks.length > 0 || inspection.submissions.length > 0) continue;

      if (this.#closed || this.#projects.get(projectId) !== entry) continue;
      if ((this.#streamCounts.get(projectId) ?? 0) > 0) continue;
      if (now - entry.lastActivityAt < idleMs) continue;
      if (entry.handle.harness.wake().active) continue;

      await this.#closeOpenProject(projectId);
      hibernated.push(projectId);
    }

    return hibernated;
  }

  async openProject(projectId: string): Promise<ProjectHandle> {
    this.#assertOpen();
    if (this.#deletingProjects.has(projectId)) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    const existing = this.#projects.get(projectId);
    if (existing !== undefined) {
      existing.lastActivityAt = Date.now();
      return existing.handle;
    }

    const inFlight = this.#opening.get(projectId);
    if (inFlight !== undefined) return inFlight;

    const project = this.getProject(projectId);
    const opening = (async () => {
      const closing = this.#closingProjects.get(projectId);
      if (closing !== undefined) await closing.catch(() => undefined);
      if (this.#closed) {
        throw new EngineError(503, "engine_closed", "Engine is closing");
      }
      if (this.#deletingProjects.has(projectId)) {
        throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
      }
      const existingAfterClose = this.#projects.get(projectId);
      if (existingAfterClose !== undefined) {
        existingAfterClose.lastActivityAt = Date.now();
        return existingAfterClose.handle;
      }
      return this.#openProjectNow(this.getProject(projectId) ?? project);
    })().finally(() => {
      this.#opening.delete(projectId);
    });
    this.#opening.set(projectId, opening);
    return opening;
  }

  async sendMessage(
    projectId: string,
    ref: ConversationRef,
    input: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    const handle = await this.openProject(projectId);
    const sendOptions = input.whenBusy === undefined ? undefined : { whenBusy: input.whenBusy };
    try {
      const submission =
        ref === "router"
          ? await handle.send(input.text, sendOptions)
          : await handle.send(ref as CoreWorkerId, input.text, sendOptions);
      this.#touchProject(projectId);
      const statusRecord = await submission.status(BACKGROUND_CONTEXT);
      return {
        submissionId: submission.id,
        status: statusRecord.status,
      };
    } catch (error) {
      mapCoreError(error);
    }
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
    const handle = await this.openProject(projectId);
    const target = ref === "router" ? "router" : (ref as CoreWorkerId);
    const query: Omit<EntryQuery, "conversationId"> = {
      ...(params.order === undefined ? {} : { order: params.order }),
      ...(params.minEntryId === undefined ? {} : { minEntryId: params.minEntryId as EntryId }),
      ...(params.maxEntryId === undefined ? {} : { maxEntryId: params.maxEntryId as EntryId }),
    };
    try {
      const page = await handle.listEntries(target, query, limit, cursor, BACKGROUND_CONTEXT);
      return {
        entries: page.items as unknown as EntryRecordPayload[],
        ...(page.next === undefined ? {} : { nextCursor: encodeCursor(page.next) }),
      };
    } catch (error) {
      mapCoreError(error);
    }
  }

  async interrupt(projectId: string, ref: ConversationRef): Promise<OkResponse> {
    const handle = await this.openProject(projectId);
    const target = ref === "router" ? "router" : (ref as CoreWorkerId);
    try {
      await handle.interrupt(target, BACKGROUND_CONTEXT);
      this.#touchProject(projectId);
      return { ok: true };
    } catch (error) {
      mapCoreError(error);
    }
  }

  async retry(projectId: string, ref: ConversationRef): Promise<SendMessageResponse> {
    const handle = await this.openProject(projectId);
    const target = ref === "router" ? "router" : (ref as CoreWorkerId);
    try {
      const submission = await handle.retry(target, BACKGROUND_CONTEXT);
      this.#touchProject(projectId);
      const statusRecord = await submission.status(BACKGROUND_CONTEXT);
      return {
        submissionId: submission.id,
        status: statusRecord.status,
      };
    } catch (error) {
      mapCoreError(error);
    }
  }

  async answerQuestion(
    projectId: string,
    questionId: QuestionId,
    input: AnswerQuestionRequest,
  ): Promise<AnswerQuestionResponse> {
    const handle = await this.openProject(projectId);
    try {
      const question = await handle.answerQuestion(
        questionId as CoreQuestionId,
        input.answers,
        BACKGROUND_CONTEXT,
      );
      this.#touchProject(projectId);
      return { question };
    } catch (error) {
      mapCoreError(error);
    }
  }

  async readWorkerTask(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
    options?: OutputReadOptions,
  ): Promise<ReadWorkerTaskResponse> {
    const handle = await this.openProject(projectId);
    try {
      return await handle.readWorkerTaskOutput(
        workerId as CoreWorkerId,
        taskId,
        options,
        BACKGROUND_CONTEXT,
      );
    } catch (error) {
      mapCoreError(error);
    }
  }

  async killWorkerTask(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
  ): Promise<KillWorkerTaskResponse> {
    const handle = await this.openProject(projectId);
    try {
      const task = await handle.killWorkerTask(
        workerId as CoreWorkerId,
        taskId,
        BACKGROUND_CONTEXT,
      );
      this.#touchProject(projectId);
      return { task };
    } catch (error) {
      mapCoreError(error);
    }
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
    const handle = await this.openProject(projectId);
    try {
      const target = ref === "router" ? "router" : (ref as CoreWorkerId);
      return await handle.watchConversation(target, context, window);
    } catch (error) {
      mapCoreError(error);
    }
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

  #credentialStore(): CredentialStore | undefined {
    if (this.#options.credentials !== undefined) return this.#options.credentials;
    if (this.#options.models === undefined) return this.modelRuntime.credentials;
    return undefined;
  }

  #getMcpServersRecord(): Record<string, Record<string, unknown>> {
    return this.store.getKv<Record<string, Record<string, unknown>>>(KV_MCP_SERVERS) ?? {};
  }

  #effectiveSettings(): EngineSettings {
    const stored = this.store.getKv<unknown>(KV_SETTINGS);
    if (stored === undefined) return {};
    const parsed = EngineSettingsSchema;
    try {
      return parseWithSchema(parsed, stored, "stored settings");
    } catch {
      return {};
    }
  }

  #effectiveModelSlots(projectId: string): ModelSlots {
    const project = this.store.getProject(projectId);
    const settingsModels = this.#effectiveSettings().models;
    const defaults = this.#options.defaultModelSlots;
    const router = project?.models?.router ?? settingsModels?.router ?? defaults?.router;
    const worker = project?.models?.worker ?? settingsModels?.worker ?? defaults?.worker;
    const dreamer = project?.models?.dreamer ?? settingsModels?.dreamer ?? defaults?.dreamer;
    return {
      ...(router === undefined ? {} : { router }),
      ...(worker === undefined ? {} : { worker }),
      ...(dreamer === undefined ? {} : { dreamer }),
    };
  }

  #effectiveMaxActiveWorkers(): number {
    return (
      this.#effectiveSettings().maxActiveWorkers ??
      this.#options.maxActiveWorkers ??
      DEFAULT_MAX_ACTIVE_WORKERS
    );
  }

  #effectiveBackgroundAfterMs(): number {
    return (
      this.#effectiveSettings().backgroundAfterMs ??
      this.#options.backgroundAfterMs ??
      DEFAULT_BACKGROUND_AFTER_MS
    );
  }

  #effectiveRouterContextTokens(): number {
    return (
      this.#effectiveSettings().routerContextTokens ??
      this.#options.routerContextTokens ??
      DEFAULT_ROUTER_CONTEXT_TOKENS
    );
  }

  #effectiveIdleHibernateMs(): number {
    return (
      this.#effectiveSettings().idleHibernateMs ??
      this.#options.idleHibernateMs ??
      DEFAULT_IDLE_HIBERNATE_MS
    );
  }

  #touchProject(projectId: string): void {
    const entry = this.#projects.get(projectId);
    if (entry !== undefined) entry.lastActivityAt = Date.now();
  }

  async #syncOpenProjectsMcp(): Promise<void> {
    await Promise.all(
      [...this.#projects.values()].map((entry) => entry.handle.syncMcpExtensions()),
    );
  }

  async #applySettingsLive(): Promise<void> {
    this.#rescheduleHibernateSweeper();
    await Promise.all(
      [...this.#projects.entries()].map(async ([projectId, entry]) => {
        await entry.handle.reconfigureRouterModel(this.#effectiveModelSlots(projectId).router);
        entry.handle.requestPump();
      }),
    );
  }

  #rescheduleHibernateSweeper(): void {
    if (this.#hibernateTimer !== undefined) {
      clearInterval(this.#hibernateTimer);
      this.#hibernateTimer = undefined;
    }
    if (this.#closed) return;
    const idleMs = this.#effectiveIdleHibernateMs();
    if (idleMs <= 0) return;
    const intervalMs = Math.max(MIN_HIBERNATE_SWEEP_MS, Math.min(idleMs, MAX_HIBERNATE_SWEEP_MS));
    this.#hibernateTimer = setInterval(() => {
      void this.hibernateIdleProjects();
    }, intervalMs);
    this.#hibernateTimer.unref?.();
  }

  async #closeOpenProject(projectId: string): Promise<void> {
    const entry = this.#projects.get(projectId);
    if (entry === undefined) {
      const existingClosing = this.#closingProjects.get(projectId);
      if (existingClosing !== undefined) await existingClosing;
      return;
    }
    this.#projects.delete(projectId);
    entry.observation.detach();
    const closing = entry.handle.close().finally(() => {
      if (this.#closingProjects.get(projectId) === closing) {
        this.#closingProjects.delete(projectId);
      }
    });
    this.#closingProjects.set(projectId, closing);
    await closing;
  }

  async #openProjectNow(project: ProjectSummary): Promise<ProjectHandle> {
    const paths = projectPaths(this.layout, project.id);
    await mkdir(paths.dir, { recursive: true });
    await mkdir(paths.logsDir, { recursive: true });

    const openStorage: OpenProjectStorage =
      this.#options.openProjectStorage ?? ((sessionDbPath) => openNodeSqliteStorage(sessionDbPath));

    const storage = await openStorage(paths.sessionDb, project);
    const primaryWorkspace = project.workspaces[0];
    if (primaryWorkspace === undefined) {
      await storage.close(BACKGROUND_CONTEXT).catch(() => undefined);
      throw new EngineError(500, "invalid_project", `Project ${project.id} has no workspaces`);
    }

    try {
      const handle = await openCoreProject(storage, {
        cwd: primaryWorkspace,
        title: project.title,
        workspaces: project.workspaces,
        models: () => this.models(),
        modelSlots: () => this.#effectiveModelSlots(project.id),
        mcpHub: this.mcpHub,
        baseExtensionOptions: {
          globalDir: this.layout.root,
          workspaces: project.workspaces,
        },
        projectMeta: () => {
          const current = this.store.getProject(project.id) ?? project;
          return { title: current.title, workspaces: current.workspaces };
        },
        projectMemory: () => this.store.getProject(project.id)?.memory,
        modelProfiles: () => formatModelProfiles(this.getModelProfiles()),
        maxActiveWorkers: () => this.#effectiveMaxActiveWorkers(),
        backgroundAfterMs: () => this.#effectiveBackgroundAfterMs(),
        routerContextTokens: () => this.#effectiveRouterContextTokens(),
        taskLogPath: (conversationId, taskId) =>
          join(paths.logsDir, `${conversationId}-${taskId}.log`),
        ...(this.#options.onReport === undefined
          ? {}
          : { onReport: (report) => this.#options.onReport?.(project.id, report) }),
        ...(this.#options.onPumpError === undefined
          ? {}
          : { onPumpError: (error) => this.#options.onPumpError?.(project.id, error) }),
      });

      if (this.#closed || this.#deletingProjects.has(project.id)) {
        await handle.close().catch(() => undefined);
        throw new EngineError(
          this.#closed ? 503 : 404,
          this.#closed ? "engine_closed" : "project_not_found",
          this.#closed ? "Engine is closing" : `Unknown project ${project.id}`,
        );
      }

      let entryRef: OpenProjectEntry | undefined;
      const observation = handle.harness.observeCommits({
        advance: () => {
          if (entryRef !== undefined) entryRef.lastActivityAt = Date.now();
        },
        end: () => {},
      });
      const entry: OpenProjectEntry = {
        handle,
        observation,
        lastActivityAt: Date.now(),
      };
      entryRef = entry;
      this.#projects.set(project.id, entry);
      return handle;
    } catch (error) {
      await storage.close(BACKGROUND_CONTEXT).catch(() => undefined);
      throw error;
    }
  }

  async #dispose(): Promise<void> {
    this.#closed = true;
    if (this.#hibernateTimer !== undefined) {
      clearInterval(this.#hibernateTimer);
      this.#hibernateTimer = undefined;
    }
    await this.#loginSessions.close().catch(() => undefined);
    await Promise.allSettled([...this.#opening.values()]);
    await Promise.allSettled([...this.#closingProjects.values()]);
    const entries = [...this.#projects.entries()];
    this.#projects.clear();
    await Promise.allSettled(
      entries.map(async ([, entry]) => {
        entry.observation.detach();
        await entry.handle.close();
      }),
    );
    await this.mcpHub.close().catch(() => undefined);
    this.store.close();
  }
}
