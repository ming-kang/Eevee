import { isMcpServerOverride, mcpNamespace } from "@earendil-works/pi-mcp";
import { isRecord } from "../../shared/guards.ts";
import { type McpServerConfig, type McpServerEntry, validateMcpServerEntry } from "./config.ts";
import { buildOfflineMcpSnapshot, type McpServerSnapshot } from "./snapshot.ts";

export { isMcpServerOverride };

export function normalizeMcpServerMap(
  servers: readonly McpServerEntry[],
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    servers.map((entry) => [entry.name, Object.fromEntries(Object.entries(entry.config))]),
  );
}

export function mergeMcpServerOverride(
  globalEntry: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
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

export type ResolveEffectiveMcpServersOptions = {
  readonly fallbackOnInvalidOverride?: boolean;
};

export type ResolvedEffectiveMcpServers = {
  readonly entries: McpServerEntry[];
  readonly effectiveServers: Record<string, Record<string, unknown>>;
  readonly normalizedProjectServers: Record<string, Record<string, unknown>>;
  readonly errors: string[];
};

export function resolveEffectiveMcpServers(
  globalServers: Readonly<Record<string, unknown>>,
  projectServers: Readonly<Record<string, unknown>>,
  options: ResolveEffectiveMcpServersOptions = {},
): ResolvedEffectiveMcpServers {
  const resolvedConfigs = new Map<string, McpServerConfig | undefined>();
  for (const name of Object.keys(globalServers)) {
    resolvedConfigs.set(name, undefined);
  }
  const normalizedProjectServers: Record<string, Record<string, unknown>> = {};
  const errors: string[] = [];

  for (const [name, raw] of Object.entries(projectServers)) {
    if (!isRecord(raw)) {
      errors.push(`server "${name}" must be an object`);
      continue;
    }
    if (isMcpServerOverride(raw)) {
      const globalEntry = Object.hasOwn(globalServers, name) ? globalServers[name] : undefined;
      if (!isRecord(globalEntry)) {
        errors.push(`server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`);
        continue;
      }
      const merged = mergeMcpServerOverride(globalEntry, raw);
      const validated = validateMcpServerEntry(name, merged);
      if (typeof validated === "string") {
        errors.push(validated);
        if (!options.fallbackOnInvalidOverride) {
          resolvedConfigs.delete(name);
        }
        continue;
      }
      resolvedConfigs.set(name, validated);
      normalizedProjectServers[name] = { ...raw };
      continue;
    }
    const validated = validateMcpServerEntry(name, raw);
    if (typeof validated === "string") {
      errors.push(validated);
      continue;
    }
    resolvedConfigs.set(name, validated);
    normalizedProjectServers[name] = { ...validated };
  }

  const entries: McpServerEntry[] = [];
  const namespaces = new Map<string, string>();
  for (const [name, prevalidated] of resolvedConfigs) {
    let config = prevalidated;
    if (config === undefined) {
      const validated = validateMcpServerEntry(name, globalServers[name]);
      if (typeof validated === "string") {
        errors.push(validated);
        continue;
      }
      config = validated;
    }
    const namespace = mcpNamespace(name);
    const conflicting = namespaces.get(namespace);
    if (conflicting !== undefined && conflicting !== name) {
      errors.push(
        `server "${name}" conflicts with "${conflicting}": both use namespace "${namespace}"`,
      );
      continue;
    }
    namespaces.set(namespace, name);
    entries.push({ name, config });
  }

  return {
    entries,
    effectiveServers: normalizeMcpServerMap(entries),
    normalizedProjectServers,
    errors,
  };
}

export function synthesizeOfflineMcpSnapshots(
  entries: readonly McpServerEntry[],
): McpServerSnapshot[] {
  return entries.map((entry) => buildOfflineMcpSnapshot(entry));
}
