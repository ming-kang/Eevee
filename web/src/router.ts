import type { QuestionId } from "../../src/contracts/index.ts";

const SETTINGS_SECTIONS = ["general", "models", "roles", "mcp", "engine"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The item a settings page opens on its own: a provider on the models page, a server on the MCP page. */
export const NEW_ITEM = "+";
const ITEM_SECTIONS: readonly SettingsSection[] = ["models", "mcp"];

export type Route =
  | { name: "chat"; pid: string; qid?: QuestionId }
  | { name: "worker"; pid: string; tid: string }
  | { name: "memory"; pid: string }
  | { name: "usage"; pid: string }
  | { name: "settings"; section: SettingsSection; item?: string }
  | { name: "connect" }
  | { name: "home" };

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export function extractAuthCode(hash: string): string | undefined {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "" || raw.startsWith("/")) return undefined;
  const query = raw.startsWith("?") ? raw.slice(1) : raw;
  const code = new URLSearchParams(query).get("code");
  return code && code !== "" ? code : undefined;
}

function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export function parseRoute(hash: string): Route | undefined {
  if (extractAuthCode(hash) !== undefined) return undefined;
  const trimmed = hash.replace(/^#\/?/, "");
  if (trimmed === "") return undefined;
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length === 0) return undefined;

  if (parts[0] === "connect" && parts.length === 1) {
    return { name: "connect" };
  }
  if (parts[0] === "settings") {
    const raw = parts[1] ? decode(parts[1]) : undefined;
    const section: SettingsSection = raw && isSettingsSection(raw) ? raw : "general";
    const item = parts[2] && ITEM_SECTIONS.includes(section) ? decode(parts[2]) : undefined;
    return item ? { name: "settings", section, item } : { name: "settings", section };
  }
  if (parts[0] === "p" && parts[1]) {
    const pid = decode(parts[1]);
    if (!pid) return undefined;
    if (parts.length === 2) return { name: "chat", pid };
    if (parts[2] === "q" && parts[3] && parts.length === 4) {
      const qid = decode(parts[3]);
      return qid && /^q\d+$/.test(qid) ? { name: "chat", pid, qid: qid as QuestionId } : undefined;
    }
    if (parts[2] === "t" && parts[3] && parts.length === 4) {
      const tid = decode(parts[3]);
      return tid ? { name: "worker", pid, tid } : undefined;
    }
    if (parts[2] === "memory" && parts.length === 3) return { name: "memory", pid };
    if (parts[2] === "usage" && parts.length === 3) return { name: "usage", pid };
  }
  return undefined;
}

export function resolveRoute(hash: string, fallbackPid?: string): Route {
  const parsed = parseRoute(hash);
  if (parsed !== undefined) return parsed;
  // An empty hash is the Home page; only a non-empty unknown path falls back to the last project.
  if (hash.replace(/^#\/?/, "") === "") return { name: "home" };
  return fallbackPid !== undefined ? { name: "chat", pid: fallbackPid } : { name: "home" };
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case "chat":
      return `#/p/${encodeURIComponent(route.pid)}${route.qid === undefined ? "" : `/q/${encodeURIComponent(route.qid)}`}`;
    case "worker":
      return `#/p/${encodeURIComponent(route.pid)}/t/${encodeURIComponent(route.tid)}`;
    case "memory":
      return `#/p/${encodeURIComponent(route.pid)}/memory`;
    case "usage":
      return `#/p/${encodeURIComponent(route.pid)}/usage`;
    case "settings":
      return route.item === undefined
        ? `#/settings/${route.section}`
        : `#/settings/${route.section}/${encodeURIComponent(route.item)}`;
    case "connect":
      return "#/connect";
    case "home":
      return "#/";
  }
}
