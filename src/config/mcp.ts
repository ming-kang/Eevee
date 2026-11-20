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
import type { ConfigIssue, ConfigProblem } from "../domain/index.ts";
import { readJson, writeJsonAtomic } from "../shared/fs.ts";
import { ConfigError, configIssue } from "./load.ts";

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

export const MCP_FILE = "mcp.json";
const SHAPE = '{ "mcpServers": { "<name>": { ... } } }';

/** The `mcpServers` entries as written, unchecked; refuses a file that is not that shape. */
export async function readMcpEntries(path: string): Promise<Record<string, unknown>> {
  const raw = await readJson<unknown>(path);
  if (raw === undefined) return {};
  const entries = isRecord(raw) ? raw.mcpServers : undefined;
  if (!isRecord(entries)) {
    throw new ConfigError([{ file: MCP_FILE, code: "shape", expected: SHAPE }]);
  }
  return entries;
}

export async function loadMcpConfig(
  path: string,
): Promise<{ servers: McpServerEntry[]; problems: ConfigProblem[] }> {
  let entries: Record<string, unknown>;
  try {
    entries = await readMcpEntries(path);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { servers: [], problems: [...error.problems] };
  }
  const servers: McpServerEntry[] = [];
  const problems: ConfigProblem[] = [];
  for (const [name, raw] of Object.entries(entries)) {
    const parsed = parseMcpEntry(name, raw);
    if ("code" in parsed) problems.push({ ...parsed, file: MCP_FILE, entry: name });
    else servers.push(parsed);
  }
  return { servers, problems };
}

export function parseMcpEntry(name: string, raw: unknown): McpServerEntry | ConfigIssue {
  const result = validateMcpServerConfig(name, raw);
  if (result.kind === "invalid") return { code: "failed", detail: result.error };
  const exposure = result.config.exposure ?? "deferred";
  if (!MCP_EXPOSURES.includes(exposure as McpExposure)) {
    return { code: "invalid", field: "exposure", allowed: MCP_EXPOSURES };
  }
  const common: Common = {
    name,
    exposure: exposure as McpExposure,
    enabled: result.config.enabled !== false,
    ...(result.config.description === undefined ? {} : { description: result.config.description }),
    ...(result.config.timeout === undefined ? {} : { timeoutMs: result.config.timeout * 1000 }),
  };
  return result.kind === "stdio"
    ? { ...common, kind: "stdio", config: result.config }
    : { ...common, kind: "http", config: result.config };
}

/**
 * mcp.json's single writer: replaces one server's entry, or removes it (`undefined`), keeping the rest of the
 * file as it is. Refuses an entry that does not check out, and a file it cannot read.
 */
export async function writeMcpEntry(
  path: string,
  name: string,
  entry: Record<string, unknown> | undefined,
): Promise<void> {
  if (entry !== undefined) {
    const parsed = parseMcpEntry(name, entry);
    if ("code" in parsed) throw new ConfigError([{ ...parsed, file: MCP_FILE, entry: name }]);
  }
  let raw: unknown;
  try {
    raw = (await readJson<unknown>(path)) ?? {};
  } catch (error) {
    throw new ConfigError([{ ...configIssue(error), file: MCP_FILE }]);
  }
  const existing = isRecord(raw) ? (raw.mcpServers ?? {}) : undefined;
  if (!isRecord(raw) || !isRecord(existing)) {
    throw new ConfigError([{ file: MCP_FILE, code: "shape", expected: SHAPE }]);
  }
  const servers = { ...existing };
  if (entry === undefined) delete servers[name];
  else servers[name] = entry;
  await writeJsonAtomic(path, { ...raw, mcpServers: servers }, { mode: 0o600 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
