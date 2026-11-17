/**
 * `~/.eevee/mcp.json`: MCP servers in the `mcpServers` shape other MCP clients share, so configurations can
 * be copied over. Eevee adds `exposure`, how a server's tools reach the model:
 *
 * - `deferred` (default): offered once `tool_search` finds them, which keeps large tool sets out of the prompt;
 * - `direct`: offered like any other tool;
 * - `codemode`: called from `codemode` scripts only;
 * - `hidden`: connected, but no tool is offered.
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "deepwiki": { "url": "https://mcp.deepwiki.com/mcp", "exposure": "direct" },
 *     "github": { "command": "github-mcp", "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } }
 *   }
 * }
 * ```
 *
 * `env` and `headers` values may reference the Engine's environment variables (`${NAME}`); a stdio server
 * inherits only the variables `bash` gets. A server becomes the extension `mcp.<name>`, which roles enable
 * like any other.
 */
import {
  type McpHttpServerConfig,
  type McpStdioServerConfig,
  validateMcpServerConfig,
} from "@earendil-works/pi-mcp";
import { readJson } from "../../shared/fs.ts";

export const MCP_EXPOSURES = ["deferred", "direct", "codemode", "hidden"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

type Common = {
  name: string;
  exposure: McpExposure;
  enabled: boolean;
  description?: string;
  timeoutMs?: number;
};

export type McpServerEntry =
  | (Common & { kind: "stdio"; config: McpStdioServerConfig })
  | (Common & { kind: "http"; config: McpHttpServerConfig });

export const mcpExtensionName = (server: string): string => `mcp.${server}`;

export async function loadMcpConfig(
  path: string,
): Promise<{ servers: McpServerEntry[]; problems: string[] }> {
  const raw = await readJson<unknown>(path);
  if (raw === undefined) return { servers: [], problems: [] };
  const entries = isRecord(raw) ? raw.mcpServers : undefined;
  if (!isRecord(entries)) {
    return { servers: [], problems: ['mcp.json 应为 { "mcpServers": { "<名字>": { ... } } }'] };
  }
  const servers: McpServerEntry[] = [];
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    const result = validateMcpServerConfig(name, entry);
    if (result.kind === "invalid") {
      problems.push(`mcp.json：${result.error}`);
      continue;
    }
    const exposure = result.config.exposure ?? "deferred";
    if (!MCP_EXPOSURES.includes(exposure as McpExposure)) {
      problems.push(`mcp.json：${name} 的 exposure 应为 ${MCP_EXPOSURES.join(" / ")}`);
      continue;
    }
    const common: Common = {
      name,
      exposure: exposure as McpExposure,
      enabled: result.config.enabled !== false,
      ...(result.config.description === undefined
        ? {}
        : { description: result.config.description }),
      ...(result.config.timeout === undefined ? {} : { timeoutMs: result.config.timeout * 1000 }),
    };
    servers.push(
      result.kind === "stdio"
        ? { ...common, kind: "stdio", config: result.config }
        : { ...common, kind: "http", config: result.config },
    );
  }
  return { servers, problems };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
