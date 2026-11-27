import type {
  McpLogsResponse,
  McpServerRoles,
  McpServerSnapshotPayload,
  McpStateResponse,
  ProjectMcpStateResponse,
} from "@eevee/protocol";

export type FormatMcpStatusOptions = {
  readonly showLogs?: boolean;
  readonly logs?: ReadonlyMap<string, McpLogsResponse>;
};

function formatMcpRoles(roles: McpServerRoles): string {
  const active: string[] = [];
  if (roles.router) active.push("router");
  if (roles.worker) active.push("worker");
  return `roles=${active.length > 0 ? active.join(",") : "none"}`;
}

export function formatMcpStatus(
  status: readonly McpServerSnapshotPayload[],
  options?: FormatMcpStatusOptions,
): string {
  if (status.length === 0) return "No MCP servers configured.";
  const includeLogs = options?.showLogs === true || options?.logs !== undefined;
  const lines: string[] = [];

  for (const server of status) {
    const state = server.enabled
      ? server.status
      : server.status === "disabled"
        ? "disabled"
        : `${server.status} (disabled)`;
    const parts = [server.name, state, `tools=${server.toolCount}`];
    if (server.transport !== undefined) parts.push(`transport=${server.transport}`);
    if (server.exposure !== undefined) parts.push(`exposure=${server.exposure}`);
    if (server.roles !== undefined) parts.push(formatMcpRoles(server.roles));
    if (server.hasResources === true) parts.push("resources");
    if (server.authRequired === true && server.status !== "auth_required") {
      parts.push("auth_required");
    }
    if (server.scope !== undefined) parts.push(`scope=${server.scope}`);
    if (server.error !== undefined) parts.push(`error=${server.error}`);
    lines.push(parts.join("\t"));

    if (includeLogs) {
      const fetched = options?.logs?.get(server.name);
      const logLines = fetched?.lines ?? server.recentLogs ?? [];
      const logPathSuffix = fetched?.logPath === undefined ? "" : ` (${fetched.logPath})`;
      if (logLines.length > 0) {
        lines.push(`  logs${logPathSuffix}:`);
        for (const logLine of logLines) {
          lines.push(`    ${logLine}`);
        }
      } else if (options?.showLogs === true) {
        lines.push(`  logs${logPathSuffix}: (none)`);
      }
    }
  }

  return lines.join("\n");
}

export function formatMcpState(state: McpStateResponse, options?: FormatMcpStatusOptions): string {
  return formatMcpStatus(state.status, options);
}

export function formatProjectMcpState(
  state: ProjectMcpStateResponse,
  options?: FormatMcpStatusOptions,
): string {
  const enriched = state.status.map((snapshot) => {
    if (snapshot.scope !== undefined) return snapshot;
    const inProject = Object.hasOwn(state.projectServers, snapshot.name);
    const inGlobal = Object.hasOwn(state.globalServers, snapshot.name);
    const scope: "global" | "project" | "override" = inProject
      ? inGlobal
        ? "override"
        : "project"
      : "global";
    return { ...snapshot, scope };
  });
  return formatMcpStatus(enriched, options);
}

export function formatScopedMcpState(
  state: McpStateResponse | ProjectMcpStateResponse,
  options?: FormatMcpStatusOptions,
): string {
  return "projectServers" in state
    ? formatProjectMcpState(state, options)
    : formatMcpState(state, options);
}

export function formatMcpLogs(logs: McpLogsResponse): string {
  const header = `MCP logs for ${logs.server}${logs.logPath === undefined ? "" : ` (${logs.logPath})`}:`;
  if (logs.lines.length === 0) {
    return `${header}\nNo log entries.`;
  }
  return [header, ...logs.lines].join("\n");
}
