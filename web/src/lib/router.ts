import type { QuestionId } from "../../../src/domain/index.ts";

const SETTINGS_SECTIONS = ["general", "models", "roles", "mcp", "engine"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type ControlSection = SettingsSection | "memory" | "usage";

/** The item a settings page opens on its own: a provider on the models page, a server on the MCP page. */
export const NEW_ITEM = "+";
const ITEM_SECTIONS: readonly SettingsSection[] = ["models", "mcp"];

export type Route =
  | { name: "chat"; pid: string; qid?: QuestionId }
  | { name: "worker"; pid: string; tid: string; qid?: QuestionId }
  | { name: "control"; section: ControlSection; item?: string; pid?: string }
  | { name: "connect" }
  | { name: "overview" };

export type BackgroundRoute = Exclude<Route, { name: "control" }>;

export function routerProjectId(route: BackgroundRoute): string | undefined {
  return route.name === "chat" || route.name === "worker" ? route.pid : undefined;
}

export function retainBackgroundRoute(next: Route, previous: BackgroundRoute): BackgroundRoute {
  return next.name === "control" ? previous : next;
}

export function controlProjectId(
  next: Route,
  background: BackgroundRoute,
  fallbackPid?: string,
): string | undefined {
  if (next.name === "control" && next.pid !== undefined) return next.pid;
  return "pid" in background ? background.pid : fallbackPid;
}

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
  const [path, query] = trimmed.split("?");
  const parts = (path ?? "").split("/").filter(Boolean);
  if (parts.length === 0) return undefined;
  if ((parts[0] === "overview" || parts[0] === "home") && parts.length === 1) {
    return { name: "overview" };
  }

  if (parts[0] === "connect" && parts.length === 1) {
    return { name: "connect" };
  }
  if (parts[0] === "settings" || parts[0] === "control") {
    const raw = parts[1] ? decode(parts[1]) : undefined;
    const section: ControlSection =
      raw && isSettingsSection(raw)
        ? raw
        : parts[0] === "control" && (raw === "memory" || raw === "usage")
          ? raw
          : "general";
    const item =
      parts[2] && ITEM_SECTIONS.some((value) => value === section) ? decode(parts[2]) : undefined;
    const pid = new URLSearchParams(query).get("project") || undefined;
    return { name: "control", section, ...(item ? { item } : {}), ...(pid ? { pid } : {}) };
  }
  if (parts[0] === "p" && parts[1]) {
    const pid = decode(parts[1]);
    if (!pid) return undefined;
    if (parts.length === 2) return { name: "chat", pid };
    if (parts[2] === "q" && parts[3] && parts.length === 4) {
      const qid = decode(parts[3]);
      return qid && /^q\d+$/.test(qid) ? { name: "chat", pid, qid: qid as QuestionId } : undefined;
    }
    if (parts[2] === "t" && parts[3]) {
      const tid = decode(parts[3]);
      if (!tid) return undefined;
      if (parts.length === 4) return { name: "worker", pid, tid };
      if (parts[4] === "q" && parts[5] && parts.length === 6) {
        const qid = decode(parts[5]);
        return qid && /^q\d+$/.test(qid)
          ? { name: "worker", pid, tid, qid: qid as QuestionId }
          : undefined;
      }
      return undefined;
    }
    if ((parts[2] === "memory" || parts[2] === "usage") && parts.length === 3) {
      return { name: "control", section: parts[2], pid };
    }
  }
  return undefined;
}

export function resolveRoute(hash: string, fallbackPid?: string): Route {
  const parsed = parseRoute(hash);
  if (parsed !== undefined) return parsed;
  // An empty hash is Overview; only a non-empty unknown path falls back to the last project.
  if (hash.replace(/^#\/?/, "") === "") return { name: "overview" };
  return fallbackPid !== undefined ? { name: "chat", pid: fallbackPid } : { name: "overview" };
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case "chat":
      return `#/p/${encodeURIComponent(route.pid)}${route.qid === undefined ? "" : `/q/${encodeURIComponent(route.qid)}`}`;
    case "worker":
      return `#/p/${encodeURIComponent(route.pid)}/t/${encodeURIComponent(route.tid)}${route.qid === undefined ? "" : `/q/${encodeURIComponent(route.qid)}`}`;
    case "control":
      return `#/control/${route.section}${route.item === undefined ? "" : `/${encodeURIComponent(route.item)}`}${route.pid === undefined ? "" : `?project=${encodeURIComponent(route.pid)}`}`;
    case "connect":
      return "#/connect";
    case "overview":
      return "#/overview";
  }
}
