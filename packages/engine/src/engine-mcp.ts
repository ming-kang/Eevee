import { join } from "node:path";
import {
  type McpHub,
  type McpServerSnapshot,
  parseMcpConfig,
  synthesizeOfflineMcpSnapshots,
  validateMcpServerEntry,
} from "@eevee/agent";
import type {
  McpLogsResponse,
  McpOAuthEvent,
  McpOAuthInputRequest,
  McpServerEntryInput,
  McpServerSnapshotPayload,
  McpStateResponse,
  OkResponse,
  ProjectMcpStateResponse,
  PutGlobalMcpConfigRequest,
  PutMcpConfigRequest,
  ReconnectMcpRequest,
  ReconnectMcpResponse,
  StartMcpOAuthResponse,
  UpsertGlobalMcpServerRequest,
  UpsertMcpServerRequest,
} from "@eevee/protocol";
import { type DataDirLayout, projectPaths } from "./data-dir.ts";
import {
  applyGlobalMcpReplacement,
  cleanupRemovedMcpOAuth,
  findRemovedHttpMcpServers,
  getMcpServersRecord,
  resolveEffectiveProjectMcp,
} from "./engine-config.ts";
import { EngineError, guardAsync, guardSync } from "./engine-error.ts";
import {
  GLOBAL_SCOPE,
  type McpOAuthDeps,
  projectScope,
  scopedMcpOAuth,
} from "./engine-mcp-oauth.ts";
import { projectMcpOAuthScope } from "./mcp-oauth-sessions.ts";
import type { KeyedSerialQueue } from "./serial-queue.ts";

export type McpDeps = McpOAuthDeps & {
  readonly layout: DataDirLayout;
  readonly mutationQueue: KeyedSerialQueue;
  readonly globalLogPath: string;
  readonly cancelOAuthForServers: (
    serverNames: readonly string[],
    scopeKey?: string,
  ) => Promise<void>;
  readonly syncProjects: () => Promise<void>;
  readonly openProjectMcpHub: (projectId: string) => Promise<McpHub>;
  readonly runProjectMcpMutation: <T>(projectId: string, fn: () => Promise<T>) => Promise<T>;
  readonly syncProjectMcpUnlocked: (projectId: string) => Promise<void>;
};

export type ScopedMcpHandle<
  TState extends McpStateResponse | ProjectMcpStateResponse =
    | McpStateResponse
    | ProjectMcpStateResponse,
  TPutInput extends PutMcpConfigRequest = PutMcpConfigRequest,
  TUpsertInput extends UpsertMcpServerRequest = UpsertMcpServerRequest,
> = {
  getState(): TState;
  putConfig(input: TPutInput): Promise<TState>;
  upsertServer(serverName: string, input: TUpsertInput): Promise<TState>;
  deleteServer(serverName: string): Promise<TState>;
  reconnect(input?: ReconnectMcpRequest): Promise<ReconnectMcpResponse>;
  getLogs(serverName: string): McpLogsResponse;
  startOAuth(serverName: string): Promise<StartMcpOAuthResponse>;
  subscribeOAuth(
    serverName: string,
    sessionId: string,
    onEvent: (event: McpOAuthEvent) => void,
  ): () => void;
  submitOAuthInput(serverName: string, sessionId: string, input: McpOAuthInputRequest): OkResponse;
  cancelOAuth(serverName: string, sessionId: string): OkResponse;
  logoutOAuth(serverName: string): Promise<OkResponse>;
};

export type GlobalMcpHandle = ScopedMcpHandle<
  McpStateResponse,
  PutGlobalMcpConfigRequest,
  UpsertGlobalMcpServerRequest
>;

export type ProjectMcpHandle = ScopedMcpHandle<
  ProjectMcpStateResponse,
  PutMcpConfigRequest,
  UpsertMcpServerRequest
>;

export type EngineMcpAccessor = {
  (): GlobalMcpHandle;
  (projectId: string): ProjectMcpHandle;
  (projectId?: string): GlobalMcpHandle | ProjectMcpHandle;
};

function toSnapshotPayload(
  snap: McpServerSnapshot,
  scope: "global" | "project" | "override",
): McpServerSnapshotPayload {
  return {
    name: snap.name,
    status: snap.status,
    enabled: snap.enabled,
    ...(snap.description === undefined ? {} : { description: snap.description }),
    ...(snap.instructions === undefined ? {} : { instructions: snap.instructions }),
    toolCount: snap.toolCount,
    ...(snap.error === undefined ? {} : { error: snap.error }),
    transport: snap.transport,
    roles: { router: snap.roles.router, worker: snap.roles.worker },
    exposure: snap.exposure,
    hasResources: snap.hasResources,
    ...(snap.authRequired === undefined ? {} : { authRequired: snap.authRequired }),
    ...(snap.tools === undefined
      ? {}
      : {
          tools: snap.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            exposure: tool.exposure,
          })),
        }),
    ...(snap.recentLogs === undefined ? {} : { recentLogs: [...snap.recentLogs] }),
    scope,
  };
}

function projectScopeOf(
  name: string,
  globalServers: Readonly<Record<string, unknown>>,
  projectServers: Readonly<Record<string, unknown>>,
): "global" | "project" | "override" {
  if (Object.hasOwn(projectServers, name)) {
    return Object.hasOwn(globalServers, name) ? "override" : "project";
  }
  return "global";
}

function getMcpState(deps: McpDeps): McpStateResponse {
  return {
    servers: getMcpServersRecord(deps.store),
    status: deps.mcpHub.status().map((snap) => toSnapshotPayload(snap, "global")),
  };
}

function getMcpLogs(deps: McpDeps, serverName: string): McpLogsResponse {
  const configured = getMcpServersRecord(deps.store);
  const hasStatus = deps.mcpHub.status().some((snap) => snap.name === serverName);
  if (!Object.hasOwn(configured, serverName) && !hasStatus) {
    throw new EngineError(404, "mcp_server_not_found", `Unknown MCP server "${serverName}"`);
  }
  return {
    server: serverName,
    lines: [...deps.mcpHub.getServerLogs(serverName)],
    logPath: deps.globalLogPath,
  };
}

async function replaceMcpServersUnlocked(
  deps: McpDeps,
  servers: Record<string, unknown>,
): Promise<McpStateResponse> {
  const parsed = parseMcpConfig({ mcpServers: servers });
  if (parsed.errors.length > 0) {
    throw new EngineError(400, "invalid_mcp_config", parsed.errors.join("; "));
  }
  await applyGlobalMcpReplacement(deps, { servers: parsed.servers });
  return getMcpState(deps);
}

async function putMcpConfig(
  deps: McpDeps,
  input: PutGlobalMcpConfigRequest,
): Promise<McpStateResponse> {
  const parsed = parseMcpConfig({ mcpServers: input.servers });
  if (parsed.errors.length > 0) {
    throw new EngineError(400, "invalid_mcp_config", parsed.errors.join("; "));
  }
  return deps.mutationQueue.enqueue("global", async () => {
    deps.assertOpen();
    await applyGlobalMcpReplacement(deps, { servers: parsed.servers });
    return getMcpState(deps);
  });
}

async function upsertMcpServer(
  deps: McpDeps,
  name: string,
  input: UpsertGlobalMcpServerRequest,
): Promise<McpStateResponse> {
  const validated = validateMcpServerEntry(name, input.config);
  if (typeof validated === "string") {
    throw new EngineError(400, "invalid_mcp_config", validated);
  }
  return deps.mutationQueue.enqueue("global", async () => {
    deps.assertOpen();
    return replaceMcpServersUnlocked(deps, {
      ...getMcpServersRecord(deps.store),
      [name]: { ...validated },
    });
  });
}

async function deleteMcpServer(deps: McpDeps, name: string): Promise<McpStateResponse> {
  return deps.mutationQueue.enqueue("global", async () => {
    deps.assertOpen();
    const current = { ...getMcpServersRecord(deps.store) };
    if (!Object.hasOwn(current, name)) {
      throw new EngineError(404, "mcp_server_not_found", `Unknown MCP server "${name}"`);
    }
    delete current[name];
    return replaceMcpServersUnlocked(deps, current);
  });
}

async function reconnectMcp(
  deps: McpDeps,
  input: ReconnectMcpRequest = {},
): Promise<ReconnectMcpResponse> {
  if (input.server !== undefined) {
    const server = deps.mcpHub.status().find((snapshot) => snapshot.name === input.server);
    if (server === undefined) {
      throw new EngineError(404, "mcp_server_not_found", `Unknown MCP server "${input.server}"`);
    }
    if (!server.enabled) {
      throw new EngineError(409, "mcp_server_disabled", `MCP server "${input.server}" is disabled`);
    }
  }
  const status = await deps.mcpHub.reconnect(input.server);
  await deps.syncMcpExtensions();
  return { status: status.map((snap) => toSnapshotPayload(snap, "global")) };
}

function getProjectMcpState(deps: McpDeps, projectId: string): ProjectMcpStateResponse {
  deps.requireProject(projectId);
  const globalServers = getMcpServersRecord(deps.store);
  const projectServers = deps.store.getProjectMcpServers(projectId) ?? {};
  const { entries, effectiveServers } = resolveEffectiveProjectMcp(
    globalServers,
    projectServers,
    false,
  );
  const hub = deps.getProjectMcpHub(projectId);
  const snapshots = hub !== undefined ? hub.status() : synthesizeOfflineMcpSnapshots(entries);
  const status = snapshots.map((snap) =>
    toSnapshotPayload(snap, projectScopeOf(snap.name, globalServers, projectServers)),
  );

  return {
    globalServers,
    projectServers,
    effectiveServers,
    status,
  };
}

async function mutateProjectMcpServers(
  deps: McpDeps,
  projectId: string,
  buildNextServers: (
    current: Readonly<Record<string, McpServerEntryInput>>,
  ) => Readonly<Record<string, unknown>>,
): Promise<ProjectMcpStateResponse> {
  return deps.runProjectMcpMutation(projectId, async () => {
    deps.assertOpen();
    deps.requireProject(projectId);
    const globalServers = getMcpServersRecord(deps.store);
    const previousProjectServers = deps.store.getProjectMcpServers(projectId) ?? {};
    const nextProjectServers = buildNextServers(previousProjectServers);
    const { effectiveServers: previousEffective } = resolveEffectiveProjectMcp(
      globalServers,
      previousProjectServers,
      false,
    );
    const { effectiveServers: nextEffective, normalizedProjectServers } =
      resolveEffectiveProjectMcp(globalServers, nextProjectServers, true);
    const removedHttp = findRemovedHttpMcpServers(previousProjectServers, normalizedProjectServers);
    const effectiveRemovedHttp = findRemovedHttpMcpServers(previousEffective, nextEffective);
    const cancelServerNames = [
      ...new Set([
        ...removedHttp.map((entry) => entry.name),
        ...effectiveRemovedHttp.map((entry) => entry.name),
      ]),
    ];
    deps.store.setProjectMcpServers(
      projectId,
      Object.keys(normalizedProjectServers).length === 0 ? null : normalizedProjectServers,
    );
    await cleanupRemovedMcpOAuth({
      store: deps.store,
      oauthStore: deps.oauthStore,
      cancelOAuthForServers: deps.cancelOAuthForServers,
      removed: removedHttp,
      cancellations:
        cancelServerNames.length === 0
          ? []
          : [{ scopeKey: projectMcpOAuthScope(projectId), serverNames: cancelServerNames }],
    });
    await deps.syncProjectMcpUnlocked(projectId);
    return getProjectMcpState(deps, projectId);
  });
}

async function reconnectProjectMcp(
  deps: McpDeps,
  projectId: string,
  input: ReconnectMcpRequest = {},
): Promise<ReconnectMcpResponse> {
  deps.requireProject(projectId);
  const globalServers = getMcpServersRecord(deps.store);
  const projectServers = deps.store.getProjectMcpServers(projectId) ?? {};
  const { entries } = resolveEffectiveProjectMcp(globalServers, projectServers, false);

  if (input.server !== undefined) {
    const target = entries.find((entry) => entry.name === input.server);
    if (target === undefined) {
      throw new EngineError(404, "mcp_server_not_found", `Unknown MCP server "${input.server}"`);
    }
    if (target.config.enabled === false) {
      throw new EngineError(409, "mcp_server_disabled", `MCP server "${input.server}" is disabled`);
    }
  }

  const hub = deps.getProjectMcpHub(projectId) ?? (await deps.openProjectMcpHub(projectId));
  const snapshots = await hub.reconnect(input.server);
  await deps.syncMcpExtensions();
  return {
    status: snapshots.map((snap) =>
      toSnapshotPayload(snap, projectScopeOf(snap.name, globalServers, projectServers)),
    ),
  };
}

function getProjectMcpLogs(deps: McpDeps, projectId: string, serverName: string): McpLogsResponse {
  deps.requireProject(projectId);
  const globalServers = getMcpServersRecord(deps.store);
  const projectServers = deps.store.getProjectMcpServers(projectId) ?? {};
  const { effectiveServers } = resolveEffectiveProjectMcp(globalServers, projectServers, false);
  const hub = deps.getProjectMcpHub(projectId);
  const inEffective = Object.hasOwn(effectiveServers, serverName);
  const inHub = hub?.status().some((snap) => snap.name === serverName) ?? false;
  if (!inEffective && !inHub) {
    throw new EngineError(404, "mcp_server_not_found", `Unknown MCP server "${serverName}"`);
  }
  const hasOverrides = Object.keys(projectServers).length > 0;
  const logPath = hasOverrides
    ? join(projectPaths(deps.layout, projectId).logsDir, "mcp.log")
    : deps.globalLogPath;
  return {
    server: serverName,
    lines: hub === undefined ? [] : [...hub.getServerLogs(serverName)],
    logPath,
  };
}

function buildGlobalMcpHandle(deps: McpDeps): GlobalMcpHandle {
  const oauth = scopedMcpOAuth(deps, GLOBAL_SCOPE);
  return {
    getState: guardSync(deps.assertOpen, () => getMcpState(deps)),
    putConfig: guardAsync(deps.assertOpen, (input) => putMcpConfig(deps, input)),
    upsertServer: guardAsync(deps.assertOpen, (serverName, input) =>
      upsertMcpServer(deps, serverName, input),
    ),
    deleteServer: guardAsync(deps.assertOpen, (serverName) => deleteMcpServer(deps, serverName)),
    reconnect: guardAsync(deps.assertOpen, (input = {}) => reconnectMcp(deps, input)),
    getLogs: guardSync(deps.assertOpen, (serverName) => getMcpLogs(deps, serverName)),
    startOAuth: guardAsync(deps.assertOpen, oauth.start),
    subscribeOAuth: guardSync(deps.assertOpen, oauth.subscribe),
    submitOAuthInput: guardSync(deps.assertOpen, oauth.submitInput),
    cancelOAuth: guardSync(deps.assertOpen, oauth.cancel),
    logoutOAuth: guardAsync(deps.assertOpen, oauth.logout),
  };
}

function buildProjectMcpHandle(deps: McpDeps, projectId: string): ProjectMcpHandle {
  const oauth = scopedMcpOAuth(deps, projectScope(projectId));
  return {
    getState: guardSync(deps.assertOpen, () => getProjectMcpState(deps, projectId)),
    putConfig: guardAsync(deps.assertOpen, (input) =>
      mutateProjectMcpServers(deps, projectId, () => input.servers),
    ),
    upsertServer: guardAsync(deps.assertOpen, (serverName, input) =>
      mutateProjectMcpServers(deps, projectId, (current) => ({
        ...current,
        [serverName]: input.config,
      })),
    ),
    deleteServer: guardAsync(deps.assertOpen, (serverName) =>
      mutateProjectMcpServers(deps, projectId, (current) => {
        if (!Object.hasOwn(current, serverName)) {
          throw new EngineError(
            404,
            "mcp_server_not_found",
            `Unknown project MCP server "${serverName}"`,
          );
        }
        const next = { ...current };
        delete next[serverName];
        return next;
      }),
    ),
    reconnect: guardAsync(deps.assertOpen, (input = {}) =>
      reconnectProjectMcp(deps, projectId, input),
    ),
    getLogs: guardSync(deps.assertOpen, (serverName) =>
      getProjectMcpLogs(deps, projectId, serverName),
    ),
    startOAuth: guardAsync(deps.assertOpen, oauth.start),
    subscribeOAuth: guardSync(deps.assertOpen, oauth.subscribe),
    submitOAuthInput: guardSync(deps.assertOpen, oauth.submitInput),
    cancelOAuth: guardSync(deps.assertOpen, oauth.cancel),
    logoutOAuth: guardAsync(deps.assertOpen, oauth.logout),
  };
}

export function createEngineMcpAccessor(deps: McpDeps): EngineMcpAccessor {
  const globalHandle = buildGlobalMcpHandle(deps);

  function mcp(): GlobalMcpHandle;
  function mcp(projectId: string): ProjectMcpHandle;
  function mcp(projectId?: string): GlobalMcpHandle | ProjectMcpHandle;
  function mcp(projectId?: string): GlobalMcpHandle | ProjectMcpHandle {
    return projectId === undefined ? globalHandle : buildProjectMcpHandle(deps, projectId);
  }

  return mcp;
}
