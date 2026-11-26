import { join } from "node:path";
import { isMcpServerOverride } from "@earendil-works/pi-mcp";
import {
  DEFAULT_MCP_EXPOSURE,
  isMcpServerEnabledForRole,
  type McpHub,
  type McpServerEntry,
  type McpServerSnapshot,
  parseMcpConfig,
  validateMcpServerEntry,
} from "@eevee/agent";
import type {
  McpLogsResponse,
  McpServerSnapshotPayload,
  McpStateResponse,
  ProjectMcpStateResponse,
  ProjectSummary,
  PutMcpConfigRequest,
  ReconnectMcpRequest,
  ReconnectMcpResponse,
  UpsertMcpServerRequest,
} from "@eevee/protocol";
import { type DataDirLayout, projectPaths } from "./data-dir.ts";
import { getMcpServersRecord, KV_MCP_SERVERS, normalizeMcpMap } from "./engine-config.ts";
import { EngineError } from "./engine-error.ts";
import type { EngineStore } from "./store.ts";

export type McpDeps = {
  readonly layout: DataDirLayout;
  readonly store: EngineStore;
  readonly mcpHub: McpHub;
  readonly globalLogPath: string;
  readonly requireProject: (projectId: string) => ProjectSummary;
  readonly syncProjects: () => Promise<void>;
  readonly syncExtensions: () => Promise<void>;
  readonly getProjectMcpHub: (projectId: string) => McpHub | undefined;
  readonly openProjectMcpHub: (projectId: string) => Promise<McpHub>;
  readonly syncProjectMcp: (projectId: string) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  globalServers: Record<string, Record<string, unknown>>,
  projectServers: Record<string, Record<string, unknown>>,
): "global" | "project" | "override" {
  if (Object.hasOwn(projectServers, name)) {
    return Object.hasOwn(globalServers, name) ? "override" : "project";
  }
  return "global";
}

function mergeProjectServerRaw(
  globalEntry: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const roles =
    isRecord(globalEntry.roles) && isRecord(override.roles)
      ? { ...globalEntry.roles, ...override.roles }
      : (override.roles ?? globalEntry.roles);
  const toolExposure =
    isRecord(globalEntry.toolExposure) && isRecord(override.toolExposure)
      ? { ...globalEntry.toolExposure, ...override.toolExposure }
      : (override.toolExposure ?? globalEntry.toolExposure);
  return {
    ...globalEntry,
    ...override,
    ...(roles === undefined ? {} : { roles }),
    ...(toolExposure === undefined ? {} : { toolExposure }),
  };
}

export function resolveEffectiveProjectMcp(
  globalServers: Record<string, Record<string, unknown>>,
  projectServers: Record<string, Record<string, unknown>>,
  strict = false,
): {
  readonly entries: McpServerEntry[];
  readonly effectiveServers: Record<string, Record<string, unknown>>;
  readonly normalizedProjectServers: Record<string, Record<string, unknown>>;
} {
  const mergedRaw: Record<string, Record<string, unknown>> = { ...globalServers };
  const normalizedProjectServers: Record<string, Record<string, unknown>> = {};

  for (const [name, raw] of Object.entries(projectServers)) {
    if (!isRecord(raw)) {
      if (strict) {
        throw new EngineError(400, "invalid_mcp_config", `server "${name}" must be an object`);
      }
      continue;
    }
    if (isMcpServerOverride(raw)) {
      const globalEntry = Object.hasOwn(globalServers, name) ? globalServers[name] : undefined;
      if (globalEntry === undefined) {
        if (strict) {
          throw new EngineError(
            400,
            "invalid_mcp_config",
            `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`,
          );
        }
        continue;
      }
      mergedRaw[name] = mergeProjectServerRaw(globalEntry, raw);
      normalizedProjectServers[name] = { ...raw };
    } else {
      const validated = validateMcpServerEntry(name, raw);
      if (typeof validated === "string") {
        if (strict) {
          throw new EngineError(400, "invalid_mcp_config", validated);
        }
        continue;
      }
      mergedRaw[name] = { ...validated };
      normalizedProjectServers[name] = { ...validated };
    }
  }

  const parsed = parseMcpConfig({ mcpServers: mergedRaw });
  if (parsed.errors.length > 0 && strict) {
    throw new EngineError(400, "invalid_mcp_config", parsed.errors.join("; "));
  }
  return {
    entries: parsed.servers,
    effectiveServers: normalizeMcpMap(parsed.servers),
    normalizedProjectServers,
  };
}

export function resolveEffectiveProjectMcpForStore(
  store: EngineStore,
  projectId: string,
): McpServerEntry[] {
  const globalServers = getMcpServersRecord(store);
  const projectServers = store.getProjectMcpServers(projectId) ?? {};
  return resolveEffectiveProjectMcp(globalServers, projectServers, false).entries;
}

export function hasProjectMcpOverrides(store: EngineStore, projectId: string): boolean {
  const projectServers = store.getProjectMcpServers(projectId);
  return projectServers !== undefined && Object.keys(projectServers).length > 0;
}

function synthesizeOfflineSnapshots(
  entries: readonly McpServerEntry[],
  globalServers: Record<string, Record<string, unknown>>,
  projectServers: Record<string, Record<string, unknown>>,
): McpServerSnapshotPayload[] {
  return entries.map((entry) => {
    const enabled = entry.config.enabled !== false;
    return {
      name: entry.name,
      status: enabled ? "idle" : "disabled",
      enabled,
      ...(entry.config.description === undefined ? {} : { description: entry.config.description }),
      toolCount: 0,
      transport: "url" in entry.config ? "http" : "stdio",
      roles: {
        router: isMcpServerEnabledForRole(entry.config, "router"),
        worker: isMcpServerEnabledForRole(entry.config, "worker"),
      },
      exposure: entry.config.exposure ?? DEFAULT_MCP_EXPOSURE,
      hasResources: false,
      scope: projectScopeOf(entry.name, globalServers, projectServers),
    };
  });
}

export function getMcpState(deps: McpDeps): McpStateResponse {
  return {
    servers: getMcpServersRecord(deps.store),
    status: deps.mcpHub.status().map((snap) => toSnapshotPayload(snap, "global")),
  };
}

export function getMcpLogs(deps: McpDeps, serverName: string): McpLogsResponse {
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

async function replaceMcpServers(
  deps: McpDeps,
  servers: Record<string, unknown>,
): Promise<McpStateResponse> {
  const parsed = parseMcpConfig({ mcpServers: servers });
  if (parsed.errors.length > 0) {
    throw new EngineError(400, "invalid_mcp_config", parsed.errors.join("; "));
  }
  deps.store.setKv(KV_MCP_SERVERS, normalizeMcpMap(parsed.servers));
  await deps.mcpHub.reload(parsed.servers);
  await deps.syncProjects();
  return getMcpState(deps);
}

export async function putMcpConfig(
  deps: McpDeps,
  input: PutMcpConfigRequest,
): Promise<McpStateResponse> {
  return replaceMcpServers(deps, input.servers);
}

export async function upsertMcpServer(
  deps: McpDeps,
  name: string,
  input: UpsertMcpServerRequest,
): Promise<McpStateResponse> {
  const validated = validateMcpServerEntry(name, input.config);
  if (typeof validated === "string") {
    throw new EngineError(400, "invalid_mcp_config", validated);
  }
  return replaceMcpServers(deps, {
    ...getMcpServersRecord(deps.store),
    [name]: { ...validated },
  });
}

export async function deleteMcpServer(deps: McpDeps, name: string): Promise<McpStateResponse> {
  const current = { ...getMcpServersRecord(deps.store) };
  if (!Object.hasOwn(current, name)) {
    throw new EngineError(404, "mcp_server_not_found", `Unknown MCP server "${name}"`);
  }
  delete current[name];
  return replaceMcpServers(deps, current);
}

export async function reconnectMcp(
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
  await deps.syncExtensions();
  return { status: status.map((snap) => toSnapshotPayload(snap, "global")) };
}

export function getProjectMcpState(deps: McpDeps, projectId: string): ProjectMcpStateResponse {
  deps.requireProject(projectId);
  const globalServers = getMcpServersRecord(deps.store);
  const projectServers = deps.store.getProjectMcpServers(projectId) ?? {};
  const { entries, effectiveServers } = resolveEffectiveProjectMcp(
    globalServers,
    projectServers,
    false,
  );
  const hub = deps.getProjectMcpHub(projectId);
  const status =
    hub !== undefined
      ? hub
          .status()
          .map((snap) =>
            toSnapshotPayload(snap, projectScopeOf(snap.name, globalServers, projectServers)),
          )
      : synthesizeOfflineSnapshots(entries, globalServers, projectServers);

  return {
    globalServers,
    projectServers,
    effectiveServers,
    status,
  };
}

async function replaceProjectMcpServers(
  deps: McpDeps,
  projectId: string,
  projectServers: Record<string, Record<string, unknown>>,
): Promise<ProjectMcpStateResponse> {
  deps.requireProject(projectId);
  const globalServers = getMcpServersRecord(deps.store);
  const { normalizedProjectServers } = resolveEffectiveProjectMcp(
    globalServers,
    projectServers,
    true,
  );
  deps.store.setProjectMcpServers(
    projectId,
    Object.keys(normalizedProjectServers).length === 0 ? null : normalizedProjectServers,
  );
  await deps.syncProjectMcp(projectId);
  return getProjectMcpState(deps, projectId);
}

export async function putProjectMcpConfig(
  deps: McpDeps,
  projectId: string,
  input: PutMcpConfigRequest,
): Promise<ProjectMcpStateResponse> {
  return replaceProjectMcpServers(
    deps,
    projectId,
    input.servers as Record<string, Record<string, unknown>>,
  );
}

export async function upsertProjectMcpServer(
  deps: McpDeps,
  projectId: string,
  serverName: string,
  input: UpsertMcpServerRequest,
): Promise<ProjectMcpStateResponse> {
  deps.requireProject(projectId);
  const current = deps.store.getProjectMcpServers(projectId) ?? {};
  return replaceProjectMcpServers(deps, projectId, {
    ...current,
    [serverName]: input.config,
  });
}

export async function deleteProjectMcpServer(
  deps: McpDeps,
  projectId: string,
  serverName: string,
): Promise<ProjectMcpStateResponse> {
  deps.requireProject(projectId);
  const current = { ...(deps.store.getProjectMcpServers(projectId) ?? {}) };
  if (!Object.hasOwn(current, serverName)) {
    throw new EngineError(
      404,
      "mcp_server_not_found",
      `Unknown project MCP server "${serverName}"`,
    );
  }
  delete current[serverName];
  return replaceProjectMcpServers(deps, projectId, current);
}

export async function reconnectProjectMcp(
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
  await deps.syncExtensions();
  return {
    status: snapshots.map((snap) =>
      toSnapshotPayload(snap, projectScopeOf(snap.name, globalServers, projectServers)),
    ),
  };
}

export function getProjectMcpLogs(
  deps: McpDeps,
  projectId: string,
  serverName: string,
): McpLogsResponse {
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
