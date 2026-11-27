import { validateWithSchema } from "./schemas/common.ts";
import { type McpExposure, McpExposureSchema } from "./schemas/mcp.ts";

export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;
export const DEFAULT_MCP_EXPOSURE: McpExposure = "codemode";

const CONNECTION_IDENTITY_FIELDS = [
  "type",
  "command",
  "args",
  "cwd",
  "env",
  "url",
  "headers",
  "oauth",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqualJsonValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqualJsonValue(item, b[index]))
    );
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const keysA = Object.keys(a).filter((key) => a[key] !== undefined);
    const keysB = Object.keys(b).filter((key) => b[key] !== undefined);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (key) => Object.hasOwn(b, key) && b[key] !== undefined && deepEqualJsonValue(a[key], b[key]),
    );
  }
  return false;
}

export function normalizeMcpExposure(value: unknown): McpExposure {
  if (value === "codemode-deferred") return "codemode";
  const parsed = validateWithSchema(McpExposureSchema, value);
  return parsed.ok ? parsed.value : DEFAULT_MCP_EXPOSURE;
}

export function isMcpOverrideEntry(config: Readonly<Record<string, unknown>> | undefined): boolean {
  if (config === undefined) return false;
  return config.command === undefined && config.url === undefined && config.type === undefined;
}

export function isMcpHttpConfig(config: Readonly<Record<string, unknown>> | undefined): boolean {
  if (config === undefined) return false;
  if (config.type === "http" || config.type === "streamable-http") {
    return config.command === undefined;
  }
  return (
    config.type === undefined && typeof config.url === "string" && config.command === undefined
  );
}

export function isMcpStdioConfig(config: Readonly<Record<string, unknown>> | undefined): boolean {
  if (config === undefined) return false;
  if (config.type === "stdio") {
    return config.url === undefined;
  }
  return (
    config.type === undefined && typeof config.command === "string" && config.url === undefined
  );
}

export function mcpConnectionFieldsMatch(
  candidate: Readonly<Record<string, unknown>>,
  baseline: Readonly<Record<string, unknown>>,
): boolean {
  const candidateIsHttp = isMcpHttpConfig(candidate);
  const baselineIsHttp = isMcpHttpConfig(baseline);
  const candidateIsStdio = isMcpStdioConfig(candidate);
  const baselineIsStdio = isMcpStdioConfig(baseline);
  if (candidateIsHttp !== baselineIsHttp || candidateIsStdio !== baselineIsStdio) {
    return false;
  }
  if (!candidateIsHttp && !candidateIsStdio) {
    return false;
  }
  return CONNECTION_IDENTITY_FIELDS.every((key) =>
    deepEqualJsonValue(candidate[key], baseline[key]),
  );
}
