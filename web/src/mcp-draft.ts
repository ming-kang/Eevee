/**
 * The MCP server editor's form, and how it maps to an `mcpServers` entry. Fields the form does not show, such
 * as `oauth`, travel through untouched; switching transport drops the other transport's fields.
 */
import { fromRows, type KeyValueRow, parseAmount, toRows } from "./fields.ts";

export const MCP_EXPOSURES = ["deferred", "direct", "codemode", "hidden"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

export type McpDraft = {
  transport: "stdio" | "http";
  command: string;
  /** One argument per line, so an argument may hold spaces. */
  args: string;
  cwd: string;
  env: KeyValueRow[];
  url: string;
  headers: KeyValueRow[];
  exposure: McpExposure;
  enabled: boolean;
  description: string;
  timeout: string;
};

export type McpDraftError = { code: "required"; field: "command" | "url" } | { code: "timeout" };

const STDIO_FIELDS = ["command", "args", "cwd", "env"] as const;
const HTTP_FIELDS = ["url", "headers", "oauth"] as const;

const str = (value: unknown) => (typeof value === "string" ? value : "");
const strings = (value: unknown): Record<string, string> | undefined =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"),
      )
    : undefined;

export function toMcpDraft(entry: Record<string, unknown> | undefined): McpDraft {
  const http =
    entry !== undefined &&
    (entry.type === "http" || (entry.url !== undefined && entry.command === undefined));
  const exposure = MCP_EXPOSURES.find((e) => e === entry?.exposure) ?? "deferred";
  return {
    transport: http ? "http" : "stdio",
    command: str(entry?.command),
    args: Array.isArray(entry?.args)
      ? entry.args.filter((a) => typeof a === "string").join("\n")
      : "",
    cwd: str(entry?.cwd),
    env: toRows(strings(entry?.env)),
    url: str(entry?.url),
    headers: toRows(strings(entry?.headers)),
    exposure,
    enabled: entry?.enabled !== false,
    description: str(entry?.description),
    timeout: typeof entry?.timeout === "number" ? String(entry.timeout) : "",
  };
}

function setOrDrop(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

const trimmed = (value: string) => (value.trim() === "" ? undefined : value.trim());

/** The entry the form makes, keeping what the form does not show; or the first value that cannot be written. */
export function fromMcpDraft(
  draft: McpDraft,
  original: Record<string, unknown> | undefined,
): { config: Record<string, unknown> } | { error: McpDraftError } {
  const config: Record<string, unknown> = { ...original };
  if (config.type !== undefined && config.type !== draft.transport) delete config.type;
  for (const field of draft.transport === "stdio" ? HTTP_FIELDS : STDIO_FIELDS)
    delete config[field];
  if (draft.transport === "stdio") {
    const command = trimmed(draft.command);
    if (command === undefined) return { error: { code: "required", field: "command" } };
    config.command = command;
    const args = draft.args.split(/\r?\n/).filter((line) => line.trim() !== "");
    setOrDrop(config, "args", args.length === 0 ? undefined : args);
    setOrDrop(config, "cwd", trimmed(draft.cwd));
    setOrDrop(config, "env", fromRows(draft.env));
  } else {
    const url = trimmed(draft.url);
    if (url === undefined) return { error: { code: "required", field: "url" } };
    config.url = url;
    setOrDrop(config, "headers", fromRows(draft.headers));
  }
  setOrDrop(config, "exposure", draft.exposure === "deferred" ? undefined : draft.exposure);
  setOrDrop(config, "enabled", draft.enabled ? undefined : false);
  setOrDrop(config, "description", trimmed(draft.description));
  const timeout = parseAmount(draft.timeout);
  if (Number.isNaN(timeout) || timeout === 0) return { error: { code: "timeout" } };
  setOrDrop(config, "timeout", timeout);
  return { config };
}

/**
 * A server entry pasted from another client's config: the whole file (`{ "mcpServers": { … } }`), one named
 * entry (`{ "name": { … } }` or `"name": { … }`), or a bare entry. The first server wins when there are several.
 */
export function parsePastedServer(
  text: string,
): { name?: string; config: Record<string, unknown> } | undefined {
  const value = parseLoose(text.trim());
  if (!isRecord(value)) return undefined;
  if (isEntry(value)) return { config: value };
  const servers = isRecord(value.mcpServers) ? value.mcpServers : value;
  const first = Object.entries(servers).find(([, entry]) => isRecord(entry) && isEntry(entry));
  return first === undefined
    ? undefined
    : { name: first[0], config: first[1] as Record<string, unknown> };
}

function parseLoose(text: string): unknown {
  for (const candidate of [text, `{${text}}`, `{${text.replace(/,\s*$/, "")}}`]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next way of reading it
    }
  }
  return undefined;
}

const isEntry = (value: Record<string, unknown>) =>
  typeof value.command === "string" || typeof value.url === "string";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Server names become tool names: letters, digits, `_` and `-`. */
export function isServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}
