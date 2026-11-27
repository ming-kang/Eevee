import {
  DEFAULT_MCP_EXPOSURE,
  type McpExposure,
  type McpServerEntry,
  type ResolvedMcpServerRoles,
  resolveMcpServerRoles,
} from "./config.ts";

export type McpServerStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "auth_required"
  | "degraded"
  | "disconnected"
  | "failed"
  | "disabled"
  | "closed";

export type McpServerToolSummary = {
  readonly name: string;
  readonly description?: string;
  readonly exposure: McpExposure;
};

export type McpServerSnapshot = {
  readonly name: string;
  readonly status: McpServerStatus;
  readonly enabled: boolean;
  readonly description?: string;
  readonly instructions?: string;
  readonly toolCount: number;
  readonly error?: string;
  readonly transport: "stdio" | "http";
  readonly roles: ResolvedMcpServerRoles;
  readonly exposure: McpExposure;
  readonly hasResources: boolean;
  readonly authRequired?: boolean;
  readonly tools?: readonly McpServerToolSummary[];
  readonly recentLogs?: readonly string[];
};

export function buildOfflineMcpSnapshot(entry: McpServerEntry): McpServerSnapshot {
  const enabled = entry.config.enabled !== false;
  return {
    name: entry.name,
    status: enabled ? "idle" : "disabled",
    enabled,
    ...(entry.config.description === undefined ? {} : { description: entry.config.description }),
    toolCount: 0,
    transport: "url" in entry.config ? "http" : "stdio",
    roles: resolveMcpServerRoles(entry.config),
    exposure: entry.config.exposure ?? DEFAULT_MCP_EXPOSURE,
    hasResources: false,
  };
}
