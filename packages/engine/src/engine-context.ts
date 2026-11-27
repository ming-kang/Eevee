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
import { type DataDirLayout, dataDirLayout, resolveDataDir } from "./data-dir.ts";
import {
  type EngineKnobs,
  engineKnobs,
  getMcpServersRecord,
  type ImportConfigDeps,
} from "./engine-config.ts";
import { EngineError } from "./engine-error.ts";
import type { McpDeps } from "./engine-mcp.ts";
import {
  GLOBAL_SCOPE,
  type McpOAuthDeps,
  projectScope,
  type ScopedMcpOAuth,
  scopedMcpOAuth,
} from "./engine-mcp-oauth.ts";
import { getProject, type ProjectOpsDeps } from "./engine-projects.ts";
import type { ProviderDeps } from "./engine-providers.ts";
import type { SkillsDeps } from "./engine-skills.ts";
import { LoginSessionManager } from "./login-sessions.ts";
import { McpOAuthSessionManager, projectMcpOAuthScope } from "./mcp-oauth-sessions.ts";
import { type OpenProjectStorage, ProjectPool } from "./project-pool.ts";
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

export type EngineContext = {
  readonly layout: DataDirLayout;
  readonly store: EngineStore;
  readonly modelRuntime: ModelRuntime;
  readonly mcpHub: McpHub;
  readonly oauthStore: McpOAuthCredentialStore;
  readonly knobs: EngineKnobs;
  readonly pool: ProjectPool;
  readonly loginSessions: LoginSessionManager;
  readonly mcpOAuthSessions: McpOAuthSessionManager;
  readonly providers: ProviderDeps;
  readonly skills: SkillsDeps;
  readonly mcp: McpDeps;
  readonly mcpOAuth: McpOAuthDeps;
  readonly globalOAuth: ScopedMcpOAuth;
  readonly projectOAuth: (projectId: string) => ScopedMcpOAuth;
  readonly projects: ProjectOpsDeps;
  readonly configImport: ImportConfigDeps;
  readonly models: () => Models;
};

export async function disposeEngineContext(ctx: EngineContext): Promise<void> {
  await ctx.loginSessions.close().catch(() => undefined);
  await ctx.mcpOAuthSessions.close().catch(() => undefined);
  await ctx.pool.closeAll();
  await ctx.mcpHub.close().catch(() => undefined);
  ctx.store.close();
}

export type EngineLifecycleState = {
  closed: boolean;
};

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

    const loginSessions = new LoginSessionManager();
    const mcpOAuthSessions = new McpOAuthSessionManager();
    const cancelOAuthForServers = (serverNames: readonly string[], scopeKey?: string) =>
      mcpOAuthSessions.cancelAllForServers(serverNames, scopeKey);

    let projectDeps!: ProjectOpsDeps;
    const requireProject = (projectId: string) => getProject(projectDeps, projectId);

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

    projectDeps = {
      layout,
      store,
      pool,
      knobs,
      skills: skillsDeps,
      cancelProjectOAuth: (projectId) =>
        mcpOAuthSessions.cancelForScope(projectMcpOAuthScope(projectId)),
    };

    const mcpDeps: McpDeps = {
      layout,
      store,
      mcpHub,
      oauthStore,
      cancelOAuthForServers,
      globalLogPath: mcpLogPath,
      requireProject,
      syncProjects: () => pool.reloadGlobalMcpChanges(),
      syncExtensions: () => pool.syncMcpExtensions(),
      getProjectMcpHub: (projectId) => pool.getProjectMcpHub(projectId),
      openProjectMcpHub: (projectId) => pool.openProjectMcpHub(projectId),
      syncProjectMcp: (projectId) => pool.syncProjectMcp(projectId),
    };

    const mcpOAuthDeps: McpOAuthDeps = {
      store,
      mcpHub,
      oauthStore,
      sessions: mcpOAuthSessions,
      env: options.env,
      isClosed: () => state.closed,
      assertOpen: () => {
        if (state.closed) {
          throw new EngineError(503, "engine_closed", "Engine is closing");
        }
      },
      requireProject,
      isDeletingProject: (projectId) => pool.isDeleting(projectId),
      getProjectMcpHub: (projectId) => pool.getProjectMcpHub(projectId),
      reconnectServerOnProject: (projectId, serverName) =>
        pool.reconnectServerOnProject(projectId, serverName),
      reconnectServerOnProjectHubs: (serverName, storeKey, excludeProjectId) =>
        pool.reconnectServerOnProjectHubs(serverName, storeKey, excludeProjectId),
      syncMcpExtensions: () => pool.syncMcpExtensions(),
    };

    const configImportDeps: ImportConfigDeps = {
      layout,
      store,
      modelRuntime,
      mcpHub,
      oauthStore,
      cancelOAuthForServers,
      env: options.env,
      syncProjects: () => pool.reloadGlobalMcpChanges(),
      applySettings: () => pool.applySettingsLive(),
    };

    return {
      layout,
      store,
      modelRuntime,
      mcpHub,
      oauthStore,
      knobs,
      pool,
      loginSessions,
      mcpOAuthSessions,
      providers: providerDeps,
      skills: skillsDeps,
      mcp: mcpDeps,
      mcpOAuth: mcpOAuthDeps,
      globalOAuth: scopedMcpOAuth(mcpOAuthDeps, GLOBAL_SCOPE),
      projectOAuth: (projectId) => scopedMcpOAuth(mcpOAuthDeps, projectScope(projectId)),
      projects: projectDeps,
      configImport: configImportDeps,
      models,
    };
  } catch (error) {
    await mcpHub?.close().catch(() => undefined);
    store.close();
    throw error;
  }
}
