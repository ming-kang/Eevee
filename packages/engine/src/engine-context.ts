import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import type { Report } from "@earendil-works/pi-durable";
import {
  createMcpHub,
  type McpHub,
  type McpHubOptions,
  McpOAuthCredentialStore,
  parseMcpConfig,
} from "@eevee/agent";
import { MODELS_FILE, ModelRuntime } from "@eevee/agent/models";
import type { ModelSlots } from "@eevee/core";
import type { ProjectSummary } from "@eevee/protocol";
import { type DataDirLayout, dataDirLayout, resolveDataDir } from "./data-dir.ts";
import {
  createSettingsHandle,
  engineKnobs,
  getMcpServersRecord,
  type SettingsHandle,
} from "./engine-config.ts";
import { EngineError } from "./engine-error.ts";
import { createEngineMcpAccessor, type EngineMcpAccessor } from "./engine-mcp.ts";
import { createProjectsHandle, type ProjectsHandle } from "./engine-projects.ts";
import type { ProviderDeps } from "./engine-providers.ts";
import { createProvidersHandle, type ProvidersHandle } from "./engine-providers-manage.ts";
import { createSkillsHandle, type SkillsDeps, type SkillsHandle } from "./engine-skills.ts";
import { LoginSessionManager } from "./login-sessions.ts";
import { McpOAuthSessionManager, projectMcpOAuthScope } from "./mcp-oauth-sessions.ts";
import { type OpenProjectStorage, ProjectPool } from "./project-pool.ts";
import { KeyedSerialQueue } from "./serial-queue.ts";
import { EngineStore } from "./store.ts";

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

export type EngineLifecycleState = {
  closed: boolean;
};

export type EngineContext = {
  readonly layout: DataDirLayout;
  readonly store: EngineStore;
  readonly modelRuntime: ModelRuntime;
  readonly mcpHub: McpHub;
  readonly oauthStore: McpOAuthCredentialStore;
  readonly pool: ProjectPool;
  readonly loginSessions: LoginSessionManager;
  readonly mcpOAuthSessions: McpOAuthSessionManager;
  readonly mutationQueue: KeyedSerialQueue;
  readonly models: () => Models;
  readonly assertOpen: () => void;
  readonly providers: ProvidersHandle;
  readonly settings: SettingsHandle;
  readonly skills: SkillsHandle;
  readonly mcp: EngineMcpAccessor;
  readonly projects: ProjectsHandle;
};

export async function disposeEngineContext(ctx: EngineContext): Promise<void> {
  await ctx.loginSessions.close().catch(() => undefined);
  await ctx.mcpOAuthSessions.close().catch(() => undefined);
  await ctx.mutationQueue.drainAll().catch(() => undefined);
  await ctx.pool.closeAll();
  await ctx.mcpHub.close().catch(() => undefined);
  ctx.store.close();
}

export async function openEngineContext(
  options: EngineOptions,
  state: EngineLifecycleState,
): Promise<EngineContext> {
  const root = options.dataDir ?? resolveDataDir(options.env);
  const layout = dataDirLayout(root);
  await mkdir(layout.root, { recursive: true });
  await mkdir(layout.projectsDir, { recursive: true });

  const store = EngineStore.open(layout.engineDb);
  let mcpHub: McpHub | undefined;
  try {
    const modelRuntime = await ModelRuntime.open({ dir: layout.root, env: options.env });
    const oauthStore = new McpOAuthCredentialStore(layout.root);
    const mcpLogPath = join(layout.root, "logs", "mcp.log");
    const parsedMcp = parseMcpConfig({ mcpServers: getMcpServersRecord(store) });
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

    const models = (): Models => {
      const override = options.models;
      if (override !== undefined) {
        return typeof override === "function" ? override() : override;
      }
      return modelRuntime.models();
    };

    const knobs = engineKnobs(store, {
      defaultModelSlots: options.defaultModelSlots,
      maxActiveWorkers: options.maxActiveWorkers,
      backgroundAfterMs: options.backgroundAfterMs,
      routerContextTokens: options.routerContextTokens,
      idleHibernateMs: options.idleHibernateMs,
    });

    const pool = new ProjectPool({
      layout,
      store,
      mcpHub,
      oauthStore,
      models,
      knobs,
      env: options.env,
      userHomeDir: options.userHomeDir,
      createMcpTransport: options.createMcpTransport,
      openProjectStorage: options.openProjectStorage,
      onReport: options.onReport,
      onPumpError: options.onPumpError,
    });

    const isClosed = () => state.closed;
    const assertOpen = () => {
      if (state.closed) {
        throw new EngineError(503, "engine_closed", "Engine is closing");
      }
    };
    const requireProject = (projectId: string): ProjectSummary => {
      if (pool.isDeleting(projectId)) {
        throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
      }
      const project = store.getProject(projectId);
      if (project === undefined) {
        throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
      }
      return project;
    };

    const loginSessions = new LoginSessionManager();
    const mcpOAuthSessions = new McpOAuthSessionManager();
    const mutationQueue = new KeyedSerialQueue();
    const cancelOAuthForServers = (serverNames: readonly string[], scopeKey?: string) =>
      mcpOAuthSessions.cancelAllForServers(serverNames, scopeKey);

    const providerDeps: ProviderDeps = {
      models,
      ...(options.models === undefined
        ? { runtime: () => modelRuntime, modelsFile: () => join(layout.root, MODELS_FILE) }
        : {}),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      credentials: () => {
        if (options.credentials !== undefined) return options.credentials;
        return options.models === undefined ? modelRuntime.credentials : undefined;
      },
    };

    const skillsDeps: SkillsDeps = {
      store,
      ...(options.userHomeDir === undefined ? {} : { userHomeDir: options.userHomeDir }),
      requireProject,
    };

    const providers = createProvidersHandle({
      providerDeps,
      store,
      loginSessions,
      assertOpen,
    });

    const settings = createSettingsHandle({
      layout,
      store,
      modelRuntime,
      mcpHub,
      oauthStore,
      mutationQueue,
      assertOpen,
      cancelOAuthForServers,
      env: options.env,
      syncProjects: () => pool.reloadGlobalMcpChanges(),
      applySettings: () => pool.applySettingsLive(),
    });

    const skills = createSkillsHandle({ ...skillsDeps, assertOpen });

    const mcp = createEngineMcpAccessor({
      layout,
      store,
      mcpHub,
      oauthStore,
      sessions: mcpOAuthSessions,
      mutationQueue,
      env: options.env,
      isClosed,
      assertOpen,
      requireProject,
      isDeletingProject: (projectId) => pool.isDeleting(projectId),
      cancelOAuthForServers,
      globalLogPath: mcpLogPath,
      syncProjects: () => pool.reloadGlobalMcpChanges(),
      syncMcpExtensions: () => pool.syncMcpExtensions(),
      getProjectMcpHub: (projectId) => pool.getProjectMcpHub(projectId),
      openProjectMcpHub: (projectId) => pool.openProjectMcpHub(projectId),
      reconnectServerOnProject: (projectId, serverName) =>
        pool.reconnectServerOnProject(projectId, serverName),
      reconnectServerOnProjectHubs: (serverName, storeKey, excludeProjectId) =>
        pool.reconnectServerOnProjectHubs(serverName, storeKey, excludeProjectId),
      runProjectMcpMutation: (projectId, fn) => pool.runProjectMcpMutation(projectId, fn),
      syncProjectMcpUnlocked: (projectId) => pool.syncProjectMcpUnlocked(projectId),
    });

    const projects = createProjectsHandle({
      layout,
      store,
      pool,
      knobs,
      skills: skillsDeps,
      assertOpen,
      requireProject,
      cancelProjectOAuth: (projectId) =>
        mcpOAuthSessions.cancelForScope(projectMcpOAuthScope(projectId)),
    });

    return {
      layout,
      store,
      modelRuntime,
      mcpHub,
      oauthStore,
      pool,
      loginSessions,
      mcpOAuthSessions,
      mutationQueue,
      models,
      assertOpen,
      providers,
      settings,
      skills,
      mcp,
      projects,
    };
  } catch (error) {
    await mcpHub?.close().catch(() => undefined);
    store.close();
    throw error;
  }
}
