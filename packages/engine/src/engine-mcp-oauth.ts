import {
  type McpHttpServerConfig,
  type McpHub,
  type McpOAuthCredentialStore,
  type McpServerConfig,
  mcpOAuthStoreKey,
  validateMcpServerEntry,
} from "@eevee/agent";
import type {
  McpOAuthEvent,
  McpOAuthInputRequest,
  OkResponse,
  ProjectSummary,
  StartMcpOAuthResponse,
} from "@eevee/protocol";
import { getMcpServersRecord } from "./engine-config.ts";
import { EngineError } from "./engine-error.ts";
import { resolveEffectiveProjectMcp } from "./engine-mcp.ts";
import {
  GLOBAL_MCP_OAUTH_SCOPE,
  type McpOAuthSessionManager,
  projectMcpOAuthScope,
} from "./mcp-oauth-sessions.ts";
import type { EngineStore } from "./store.ts";

export type McpScope =
  | { readonly kind: "global" }
  | { readonly kind: "project"; readonly projectId: string };

export type ScopedMcpOAuth = {
  start(serverName: string): Promise<StartMcpOAuthResponse>;
  subscribe(
    serverName: string,
    sessionId: string,
    onEvent: (event: McpOAuthEvent) => void,
  ): () => void;
  submitInput(serverName: string, sessionId: string, input: McpOAuthInputRequest): OkResponse;
  cancel(serverName: string, sessionId: string): OkResponse;
  logout(serverName: string): Promise<OkResponse>;
};

export const GLOBAL_SCOPE: McpScope = { kind: "global" };

export function projectScope(projectId: string): McpScope {
  return { kind: "project", projectId };
}

export type McpOAuthDeps = {
  readonly store: EngineStore;
  readonly mcpHub: McpHub;
  readonly oauthStore: McpOAuthCredentialStore;
  readonly sessions: McpOAuthSessionManager;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isClosed: () => boolean;
  readonly assertOpen: () => void;
  readonly requireProject: (projectId: string) => ProjectSummary;
  readonly isDeletingProject: (projectId: string) => boolean;
  readonly getProjectMcpHub: (projectId: string) => McpHub | undefined;
  readonly reconnectServerOnProject: (projectId: string, serverName: string) => Promise<void>;
  readonly reconnectServerOnProjectHubs: (
    serverName: string,
    storeKey?: string,
    excludeProjectId?: string,
  ) => Promise<void>;
  readonly syncMcpExtensions: () => Promise<void>;
};

function scopeKeyOf(scope: McpScope): string {
  return scope.kind === "global" ? GLOBAL_MCP_OAUTH_SCOPE : projectMcpOAuthScope(scope.projectId);
}

function assertScopeExists(deps: McpOAuthDeps, scope: McpScope): void {
  if (scope.kind === "project") {
    deps.requireProject(scope.projectId);
  }
}

function requireHttpMcpServer(
  deps: McpOAuthDeps,
  scope: McpScope,
  serverName: string,
  requireEnabled: boolean,
): McpHttpServerConfig {
  let config: McpServerConfig;
  if (scope.kind === "global") {
    const servers = getMcpServersRecord(deps.store);
    if (!Object.hasOwn(servers, serverName)) {
      throw new EngineError(404, "mcp_server_not_found", `Unknown MCP server "${serverName}"`);
    }
    const validated = validateMcpServerEntry(serverName, servers[serverName]);
    if (typeof validated === "string") {
      throw new EngineError(400, "invalid_mcp_config", validated);
    }
    config = validated;
  } else {
    deps.requireProject(scope.projectId);
    const globalServers = getMcpServersRecord(deps.store);
    const projectServers = deps.store.getProjectMcpServers(scope.projectId) ?? {};
    const { entries } = resolveEffectiveProjectMcp(globalServers, projectServers, false);
    const entry = entries.find((item) => item.name === serverName);
    if (entry === undefined) {
      throw new EngineError(404, "mcp_server_not_found", `Unknown MCP server "${serverName}"`);
    }
    config = entry.config;
  }

  if (!("url" in config)) {
    throw new EngineError(
      400,
      "mcp_oauth_unsupported",
      `MCP server "${serverName}" does not use HTTP transport`,
    );
  }
  if (requireEnabled && config.enabled === false) {
    throw new EngineError(409, "mcp_server_disabled", `MCP server "${serverName}" is disabled`);
  }
  return config;
}

async function reconnectAfterMcpOAuth(
  deps: McpOAuthDeps,
  scope: McpScope,
  serverName: string,
  serverUrl: string,
  reconnectProject = true,
): Promise<void> {
  const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
  if (scope.kind === "global") {
    await deps.mcpHub.reconnect(serverName).catch(() => undefined);
    await deps.reconnectServerOnProjectHubs(serverName, storeKey);
    await deps.syncMcpExtensions();
    return;
  }

  if (reconnectProject) {
    await deps.reconnectServerOnProject(scope.projectId, serverName);
  }
  const globalServers = getMcpServersRecord(deps.store);
  const globalRaw = Object.hasOwn(globalServers, serverName)
    ? globalServers[serverName]
    : undefined;
  const globalConfig =
    globalRaw === undefined ? undefined : validateMcpServerEntry(serverName, globalRaw);
  const sharesGlobal =
    globalConfig !== undefined &&
    typeof globalConfig !== "string" &&
    "url" in globalConfig &&
    globalConfig.enabled !== false &&
    mcpOAuthStoreKey(serverName, globalConfig.url) === storeKey;

  if (sharesGlobal) {
    await deps.mcpHub.reconnect(serverName).catch(() => undefined);
  }
  await deps.reconnectServerOnProjectHubs(serverName, storeKey, scope.projectId);
  if (sharesGlobal) {
    await deps.syncMcpExtensions();
  }
}

export function startMcpOAuth(
  deps: McpOAuthDeps,
  scope: McpScope,
  serverName: string,
): Promise<StartMcpOAuthResponse> {
  const config = requireHttpMcpServer(deps, scope, serverName, true);
  const expectedStoreKey = mcpOAuthStoreKey(serverName, config.url);
  const challenge =
    scope.kind === "global"
      ? deps.mcpHub.getAuthChallenge(serverName)
      : deps.getProjectMcpHub(scope.projectId)?.getAuthChallenge(serverName);

  return deps.sessions.start({
    scopeKey: scopeKeyOf(scope),
    serverName,
    serverUrl: config.url,
    store: deps.oauthStore,
    ...(config.oauth === undefined ? {} : { settings: config.oauth }),
    env: deps.env,
    challenge,
    beforeStart: () => {
      deps.assertOpen();
      const current = requireHttpMcpServer(deps, scope, serverName, true);
      if (mcpOAuthStoreKey(serverName, current.url) !== expectedStoreKey) {
        throw new EngineError(
          409,
          "mcp_server_changed",
          `MCP server "${serverName}" configuration changed before sign-in started`,
        );
      }
    },
    onComplete: async (name) => {
      if (scope.kind === "project") {
        if (deps.isClosed() || deps.isDeletingProject(scope.projectId)) return;
        if (deps.store.getProject(scope.projectId) === undefined) return;
        const { entries } = resolveEffectiveProjectMcp(
          getMcpServersRecord(deps.store),
          deps.store.getProjectMcpServers(scope.projectId) ?? {},
          false,
        );
        const current = entries.find((item) => item.name === name);
        if (
          current === undefined ||
          !("url" in current.config) ||
          current.config.enabled === false ||
          mcpOAuthStoreKey(name, current.config.url) !== expectedStoreKey
        ) {
          return;
        }
      }
      await reconnectAfterMcpOAuth(deps, scope, name, config.url);
    },
  });
}

export function subscribeMcpOAuthSession(
  deps: McpOAuthDeps,
  scope: McpScope,
  serverName: string,
  sessionId: string,
  onEvent: (event: McpOAuthEvent) => void,
): () => void {
  assertScopeExists(deps, scope);
  return deps.sessions.subscribe(serverName, sessionId, onEvent, scopeKeyOf(scope));
}

export function submitMcpOAuthInput(
  deps: McpOAuthDeps,
  scope: McpScope,
  serverName: string,
  sessionId: string,
  input: McpOAuthInputRequest,
): OkResponse {
  assertScopeExists(deps, scope);
  deps.sessions.submitInput(serverName, sessionId, input.redirectUrl, scopeKeyOf(scope));
  return { ok: true };
}

export function cancelMcpOAuth(
  deps: McpOAuthDeps,
  scope: McpScope,
  serverName: string,
  sessionId: string,
): OkResponse {
  assertScopeExists(deps, scope);
  deps.sessions.cancel(serverName, sessionId, scopeKeyOf(scope));
  return { ok: true };
}

export async function logoutMcpOAuth(
  deps: McpOAuthDeps,
  scope: McpScope,
  serverName: string,
): Promise<OkResponse> {
  const config = requireHttpMcpServer(deps, scope, serverName, false);
  await deps.sessions.cancelForServer(serverName, scopeKeyOf(scope));
  await deps.oauthStore.remove(serverName, config.url);
  if (scope.kind === "global") {
    if (config.enabled !== false) {
      await reconnectAfterMcpOAuth(deps, scope, serverName, config.url);
    }
  } else {
    await reconnectAfterMcpOAuth(deps, scope, serverName, config.url, config.enabled !== false);
  }
  return { ok: true };
}

export function scopedMcpOAuth(deps: McpOAuthDeps, scope: McpScope): ScopedMcpOAuth {
  return {
    start: (serverName) => startMcpOAuth(deps, scope, serverName),
    subscribe: (serverName, sessionId, onEvent) =>
      subscribeMcpOAuthSession(deps, scope, serverName, sessionId, onEvent),
    submitInput: (serverName, sessionId, input) =>
      submitMcpOAuthInput(deps, scope, serverName, sessionId, input),
    cancel: (serverName, sessionId) => cancelMcpOAuth(deps, scope, serverName, sessionId),
    logout: (serverName) => logoutMcpOAuth(deps, scope, serverName),
  };
}
