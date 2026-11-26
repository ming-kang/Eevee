import { type McpHub, parseMcpConfig, validateMcpServerEntry } from "@eevee/agent";
import type {
  McpStateResponse,
  PutMcpConfigRequest,
  ReconnectMcpRequest,
  ReconnectMcpResponse,
  UpsertMcpServerRequest,
} from "@eevee/protocol";
import { getMcpServersRecord, KV_MCP_SERVERS, normalizeMcpMap } from "./engine-config.ts";
import { EngineError } from "./engine-error.ts";
import type { EngineStore } from "./store.ts";

export type McpDeps = {
  readonly store: EngineStore;
  readonly mcpHub: McpHub;
  readonly syncProjects: () => Promise<void>;
};

export function getMcpState(deps: McpDeps): McpStateResponse {
  return {
    servers: getMcpServersRecord(deps.store),
    status: deps.mcpHub.status(),
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
  await deps.syncProjects();
  return { status };
}
