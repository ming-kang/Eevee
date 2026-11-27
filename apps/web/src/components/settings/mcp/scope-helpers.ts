import type {
  McpServerSnapshotPayload,
  McpStateResponse,
  ProjectMcpStateResponse,
} from "@eevee/protocol";
import { mergeProjectOverridePatch } from "../mcp-helpers.ts";
import {
  buildConfigFromForm,
  connectionFieldsMatch,
  getExplicitToolExposure,
  isOverrideEntry,
  normalizeExposure,
  normalizeServerMap,
  type ServerFormState,
} from "./codec.ts";

export type NormalizedMcpState = {
  readonly statuses: readonly McpServerSnapshotPayload[];
  readonly globalServers: Record<string, Record<string, unknown>>;
  readonly projectServers: Record<string, Record<string, unknown>>;
  readonly effectiveServers: Record<string, Record<string, unknown>>;
};

export type ToolExposureUpdateResult =
  | { readonly action: "upsert"; readonly config: Record<string, unknown> }
  | { readonly action: "delete" }
  | { readonly action: "noop" };

export function normalizeMcpState(
  res: McpStateResponse | ProjectMcpStateResponse | undefined,
): NormalizedMcpState {
  if (!res) {
    return {
      statuses: [],
      globalServers: {},
      projectServers: {},
      effectiveServers: {},
    };
  }
  if ("servers" in res) {
    const servers = normalizeServerMap(res.servers);
    return {
      statuses: res.status,
      globalServers: servers,
      projectServers: {},
      effectiveServers: servers,
    };
  }
  return {
    statuses: res.status,
    globalServers: normalizeServerMap(res.globalServers),
    projectServers: normalizeServerMap(res.projectServers),
    effectiveServers: normalizeServerMap(res.effectiveServers),
  };
}

export function buildScopedServerPayload(opts: {
  readonly isProject: boolean;
  readonly serverName: string;
  readonly form: ServerFormState;
  readonly globalServers: Readonly<Record<string, Record<string, unknown>>>;
  readonly projectServers: Readonly<Record<string, Record<string, unknown>>>;
  readonly effectiveServers: Readonly<Record<string, Record<string, unknown>>>;
}): Record<string, unknown> {
  const { isProject, serverName, form, globalServers, projectServers, effectiveServers } = opts;
  const existingConfig =
    form.mode === "edit" ? (effectiveServers[serverName] ?? globalServers[serverName]) : undefined;
  const fullConfig = buildConfigFromForm(form, existingConfig);

  if (isProject && form.mode === "edit" && Object.hasOwn(globalServers, serverName)) {
    const globalEntry = globalServers[serverName];
    const existingProject = projectServers[serverName];
    if (
      globalEntry &&
      (existingProject === undefined || isOverrideEntry(existingProject)) &&
      connectionFieldsMatch(fullConfig, globalEntry)
    ) {
      const overrideToolExposure = getExplicitToolExposure(existingProject);
      return {
        enabled: form.enabled,
        exposure: form.exposure,
        roles: {
          router: form.roleRouter,
          worker: form.roleWorker,
        },
        ...(Object.keys(overrideToolExposure).length > 0
          ? { toolExposure: overrideToolExposure }
          : {}),
      };
    }
  }

  return fullConfig;
}

export function buildPatchedServerConfig(opts: {
  readonly isProject: boolean;
  readonly server: McpServerSnapshotPayload;
  readonly globalServers: Readonly<Record<string, Record<string, unknown>>>;
  readonly projectServers: Readonly<Record<string, Record<string, unknown>>>;
  readonly effectiveServers: Readonly<Record<string, Record<string, unknown>>>;
  readonly patch: Record<string, unknown>;
}): Record<string, unknown> {
  const { isProject, server, globalServers, projectServers, effectiveServers, patch } = opts;
  if (!isProject) {
    return { ...(globalServers[server.name] ?? {}), ...patch };
  }
  if (server.scope === "project") {
    const base = projectServers[server.name] ?? effectiveServers[server.name] ?? {};
    return { ...base, ...patch };
  }
  return mergeProjectOverridePatch(projectServers[server.name], patch);
}

export function resolveToolExposureUpdate(opts: {
  readonly isProject: boolean;
  readonly server: McpServerSnapshotPayload;
  readonly globalServers: Readonly<Record<string, Record<string, unknown>>>;
  readonly projectServers: Readonly<Record<string, Record<string, unknown>>>;
  readonly toolName: string;
  readonly nextValue: string;
}): ToolExposureUpdateResult {
  const { isProject, server, globalServers, projectServers, toolName, nextValue } = opts;
  const base = isProject ? (projectServers[server.name] ?? {}) : (globalServers[server.name] ?? {});
  const currentMap = { ...getExplicitToolExposure(base) };
  if (nextValue === "") {
    delete currentMap[toolName];
  } else {
    currentMap[toolName] = normalizeExposure(nextValue);
  }

  const nextConfig = { ...base };
  if (Object.keys(currentMap).length > 0) {
    nextConfig.toolExposure = currentMap;
  } else {
    delete nextConfig.toolExposure;
  }

  if (
    isProject &&
    server.scope !== "project" &&
    isOverrideEntry(nextConfig) &&
    Object.keys(nextConfig).length === 0
  ) {
    return Object.hasOwn(projectServers, server.name) ? { action: "delete" } : { action: "noop" };
  }

  return { action: "upsert", config: nextConfig };
}
