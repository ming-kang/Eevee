import {
  mcpNamespace,
  type McpHttpServerConfig as PiMcpHttpServerConfig,
  type McpOAuthConfig as PiMcpOAuthConfig,
  type McpStdioServerConfig as PiMcpStdioServerConfig,
  validateMcpServerConfig as validateSharedMcpServerConfig,
} from "@earendil-works/pi-mcp";
import {
  getConfigValueEnvVarNames,
  isCommandConfigValue,
  resolveConfigValue,
  resolveHeaders,
} from "../../shared/config-value.ts";
import { errorMessage, isRecord } from "../../shared/guards.ts";
import { stripBom, stripJsonComments } from "../../shared/json.ts";

export type McpExposure = "deferred" | "direct" | "codemode" | "hidden";
export type McpOAuthConfig = PiMcpOAuthConfig;

export const DEFAULT_MCP_EXPOSURE = "codemode" as const;

export type McpServerRoles = {
  readonly router?: boolean;
  readonly worker?: boolean;
};

export type ResolvedMcpServerRoles = {
  readonly router: boolean;
  readonly worker: boolean;
};

export interface McpStdioServerConfig extends PiMcpStdioServerConfig {
  exposure?: McpExposure;
  toolExposure?: Record<string, McpExposure>;
  roles?: McpServerRoles;
}

export interface McpHttpServerConfig extends PiMcpHttpServerConfig {
  exposure?: McpExposure;
  toolExposure?: Record<string, McpExposure>;
  roles?: McpServerRoles;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export function isMcpServerEnabledForRole(
  config: McpServerConfig,
  role: "router" | "worker",
): boolean {
  return config.roles?.[role] !== false;
}

export function resolveMcpServerRoles(config: McpServerConfig): ResolvedMcpServerRoles {
  return {
    router: isMcpServerEnabledForRole(config, "router"),
    worker: isMcpServerEnabledForRole(config, "worker"),
  };
}

export type McpServerEntry = {
  readonly name: string;
  readonly config: McpServerConfig;
};

export type ParsedMcpConfig = {
  readonly servers: McpServerEntry[];
  readonly errors: string[];
};

const MCP_EXPOSURES: readonly McpExposure[] = ["deferred", "direct", "codemode", "hidden"];
const MCP_EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = {
  "codemode-deferred": "codemode",
};

function isExposure(value: unknown): value is McpExposure {
  return typeof value === "string" && MCP_EXPOSURES.includes(value as McpExposure);
}

function resolveExposureAlias(value: unknown): unknown {
  return typeof value === "string" ? (MCP_EXPOSURE_ALIASES[value] ?? value) : value;
}

function resolveExposureAliases(value: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...value };
  if (resolved.exposure !== undefined) {
    resolved.exposure = resolveExposureAlias(resolved.exposure);
  }
  if (isRecord(resolved.toolExposure)) {
    resolved.toolExposure = Object.fromEntries(
      Object.entries(resolved.toolExposure).map(([tool, exposure]) => [
        tool,
        resolveExposureAlias(exposure),
      ]),
    );
  }
  return resolved;
}

function checkExposures(entry: Record<string, unknown>): string | undefined {
  const exposures = MCP_EXPOSURES.map((exposure) => `"${exposure}"`).join(", ");
  if (entry.exposure !== undefined && !isExposure(entry.exposure)) {
    return `exposure must be one of ${exposures}`;
  }
  if (entry.toolExposure !== undefined) {
    if (!isRecord(entry.toolExposure)) return "toolExposure must map tool names to exposures";
    for (const [tool, exposure] of Object.entries(entry.toolExposure)) {
      if (!isExposure(exposure)) return `toolExposure "${tool}" must be one of ${exposures}`;
    }
  }
  return undefined;
}

function checkRoles(entry: Record<string, unknown>): string | undefined {
  if (entry.roles === undefined) return undefined;
  if (!isRecord(entry.roles)) {
    return 'roles must be an object with optional boolean "router" and "worker" properties';
  }
  for (const [key, value] of Object.entries(entry.roles)) {
    if (key !== "router" && key !== "worker") {
      return `roles has unknown key "${key}" (expected "router" or "worker")`;
    }
    if (value !== undefined && typeof value !== "boolean") {
      return `roles.${key} must be a boolean`;
    }
  }
  return undefined;
}

export function validateMcpServerEntry(name: string, raw: unknown): McpServerConfig | string {
  const prepared = isRecord(raw) ? resolveExposureAliases(raw) : raw;
  const result = validateSharedMcpServerConfig(name, prepared);
  if (result.kind === "invalid") return result.error;
  const exposureError = checkExposures(result.config);
  if (exposureError !== undefined) return `server "${name}": ${exposureError}`;
  const rolesError = checkRoles(result.config);
  if (rolesError !== undefined) return `server "${name}": ${rolesError}`;
  return result.config as McpServerConfig;
}

export function parseMcpConfig(input: string | Record<string, unknown>): ParsedMcpConfig {
  const errors: string[] = [];
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(stripJsonComments(stripBom(input)));
    } catch (error) {
      return {
        servers: [],
        errors: [`invalid MCP config JSON: ${errorMessage(error)}`],
      };
    }
  }

  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    return { servers: [], errors: ['expected an object with an "mcpServers" object'] };
  }

  const servers: McpServerEntry[] = [];
  const namespaces = new Map<string, string>();
  for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) {
    const config = validateMcpServerEntry(name, raw);
    if (typeof config === "string") {
      errors.push(config);
      continue;
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
    servers.push({ name, config });
  }
  return { servers, errors };
}

function toolPatternRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
  const overrides = config.toolExposure ?? {};
  const exact = overrides[toolName];
  if (exact !== undefined) return exact;
  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
  }
  return config.exposure ?? DEFAULT_MCP_EXPOSURE;
}

function missingEnvNames(
  raw: string,
  baseEnv: Readonly<Record<string, string | undefined>> | undefined,
): string[] {
  return getConfigValueEnvVarNames(raw).filter((name) => {
    const explicit = baseEnv?.[name];
    if (explicit !== undefined && explicit !== "") return false;
    const ambient = process.env[name];
    return ambient === undefined || ambient === "";
  });
}

function resolutionError(
  kind: "env" | "header",
  key: string,
  raw: string,
  baseEnv: Readonly<Record<string, string | undefined>> | undefined,
): Error {
  if (isCommandConfigValue(raw)) {
    return new Error(`MCP ${kind} "${key}" command produced no value: ${raw}`);
  }
  const names = missingEnvNames(raw, baseEnv);
  if (names.length > 0) {
    const suffix = names.length === 1 ? "" : "s";
    return new Error(
      `MCP ${kind} "${key}" references unresolved environment variable${suffix}: ${names.join(", ")}`,
    );
  }
  return new Error(`MCP ${kind} "${key}" could not be resolved`);
}

export function resolveServerEnv(
  env: Readonly<Record<string, string>> | undefined,
  baseEnv?: Readonly<Record<string, string | undefined>>,
): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, raw] of Object.entries(env)) {
    const value = resolveConfigValue(raw, baseEnv);
    if (value === undefined) throw resolutionError("env", key, raw, baseEnv);
    resolved[key] = value;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveServerHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  baseEnv?: Readonly<Record<string, string | undefined>>,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const resolved = resolveHeaders(headers, baseEnv);
  for (const [key, raw] of Object.entries(headers)) {
    if (resolved?.[key] === undefined) throw resolutionError("header", key, raw, baseEnv);
  }
  return resolved;
}
