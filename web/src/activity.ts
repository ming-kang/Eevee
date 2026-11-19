import { t } from "./i18n.ts";
import type { ToolStepItem, TranscriptDisplayItem } from "./transcript-map.ts";

/**
 * What a stretch of work added up to. The folded header reads "Worked for 3m · Read 5 files ·
 * Ran 2 commands"; a live step reads "Reading · src/app.ts". Both come from the same categories.
 */
export type ActivityKind =
  | "read"
  | "edit"
  | "commands"
  | "memory"
  | "search"
  | "scripts"
  | "handoff"
  | "tools";
export type ActivityCount = { kind: ActivityKind; count: number };

export function toolActivity(name: string): ActivityKind {
  const n = name.toLowerCase();
  if (n === "read") return "read";
  if (n === "edit" || n === "write") return "edit";
  if (n === "bash") return "commands";
  if (n === "memory") return "memory";
  if (n === "tool_search") return "search";
  if (n === "codemode") return "scripts";
  if (n === "handoff") return "handoff";
  return "tools";
}

/**
 * The argument a reader recognizes an unknown tool's call by: the first meaningful field among
 * the usual ones. Whitespace collapses, string lists join with ", ", the result caps at eighty.
 */
const DETAIL_FIELDS = [
  "title",
  "description",
  "summary",
  "objective",
  "task",
  "name",
  "question",
  "prompt",
  "message",
  "command",
  "cmd",
  "query",
  "pattern",
  "url",
  "uri",
  "file_path",
  "path",
  "target",
  "action",
];

const MAX_DETAIL = 80;

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const shorten = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const field = (args: Record<string, unknown>, name: string): string | undefined => {
  const v = args[name];
  if (typeof v === "string") return collapse(v);
  if (Array.isArray(v)) {
    const list = v
      .filter((x): x is string => typeof x === "string")
      .map(collapse)
      .filter((x) => x !== "");
    if (list.length > 0) return list.join(", ");
  }
  return undefined;
};

/** What a call did, in a few words — the step's label and a running step's detail. */
export function formatToolLabel(name: string, args: Record<string, unknown>): string {
  if (name === "read") {
    const path = typeof args.path === "string" ? args.path : "";
    const query = typeof args.query === "string" ? `?query=${args.query}` : "";
    const offset = typeof args.offset === "number" ? `:${args.offset}` : "";
    return `${path}${offset}${query}` || "read";
  }
  if (name === "bash") return typeof args.command === "string" ? args.command : "bash";
  if (name === "edit" || name === "write") return typeof args.path === "string" ? args.path : name;
  if (name === "memory") {
    const action = typeof args.action === "string" ? args.action : "";
    const scope = typeof args.scope === "string" ? args.scope : "";
    const target =
      typeof args.file === "string"
        ? `/${args.file}`
        : typeof args.change === "number"
          ? ` #${args.change}`
          : "";
    return `${action} ${scope}${target}`.trim() || "memory";
  }
  if (name === "handoff") {
    const summary = typeof args.summary === "string" ? args.summary : "";
    return summary.length > 60 ? `${summary.slice(0, 60)}…` : summary || "handoff";
  }
  for (const f of DETAIL_FIELDS) {
    const v = field(args, f);
    if (v) return shorten(v, MAX_DETAIL);
  }
  return name;
}

/** One category in words: "Read 5 files", "Ran 2 commands", "Handed off". */
function kindLabel(c: ActivityCount): string {
  const n = c.count;
  switch (c.kind) {
    case "read":
      return t("Read {n} file|Read {n} files", { n });
    case "edit":
      return t("Edited {n} file|Edited {n} files", { n });
    case "commands":
      return t("Ran {n} command|Ran {n} commands", { n });
    case "memory":
      return t("Used memory once|Used memory {n} times", { n });
    case "search":
      return t("Searched tools once|Searched tools {n} times", { n });
    case "scripts":
      return t("Ran a script|Ran {n} scripts", { n });
    case "handoff":
      return t("Handed off");
    case "tools":
      return t("Called a tool once|Called tools {n} times", { n });
  }
}

/** The "Worked …" tail: the three busiest categories first, an ellipsis when more remain. */
export function activityLabel(counts: readonly ActivityCount[]): string {
  const sorted = [...counts].sort((a, b) => b.count - a.count);
  const parts = sorted.slice(0, 3).map(kindLabel);
  return parts.join(" · ") + (sorted.length > 3 ? ` · ${t("…")}` : "");
}

/** The label of a step that is still running: "Reading · src/a.ts". */
export function runningLabel(tool: string, detail?: string): string {
  let base: string;
  switch (toolActivity(tool)) {
    case "read":
      base = t("Reading");
      break;
    case "edit":
      base = t("Editing");
      break;
    case "commands":
      base = t("Running command");
      break;
    case "memory":
      base = t("Using memory");
      break;
    case "search":
      base = t("Searching");
      break;
    case "scripts":
      base = t("Running script");
      break;
    default:
      base = t("Calling tool");
  }
  return detail ? `${base} · ${detail}` : base;
}

const tally = (counts: Map<ActivityKind, number>, kind: ActivityKind, n: number): void => {
  counts.set(kind, (counts.get(kind) ?? 0) + n);
};

/** The categories a step list worked through, in first-appearance order. */
export function countSteps(steps: readonly ToolStepItem[]): ActivityCount[] {
  const counts = new Map<ActivityKind, number>();
  for (const step of steps) tally(counts, toolActivity(step.tool), 1);
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

/**
 * The categories a folded turn worked through, in first-appearance order. Replies, dispatches
 * and thinking stay out of the count: the first two remain visible anyway, the last is deliberation.
 */
export function countWork(items: readonly TranscriptDisplayItem[]): ActivityCount[] {
  const counts = new Map<ActivityKind, number>();
  for (const item of items) {
    if (item.kind === "tools") {
      for (const step of item.steps) tally(counts, toolActivity(step.tool), 1);
    } else if (item.kind === "edit") tally(counts, "edit", 1);
    else if (item.kind === "bash") tally(counts, "commands", 1);
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

export type EditSummary = {
  files: number;
  added: number;
  removed: number;
  paths: { key: string; path: string; added: number; removed: number }[];
};

/**
 * The folded worker-turn tail "Edited 3 files +42 −7": the distinct files a successful edit
 * touched, and the lines those edits added and removed. Failed or still-running edits leave
 * no trace in the count.
 */
export function editSummary(items: readonly TranscriptDisplayItem[]): EditSummary | undefined {
  const merged = new Map<string, { key: string; added: number; removed: number }>();
  for (const item of items) {
    if (item.kind !== "edit" || item.status !== "ok") continue;
    const cur = merged.get(item.path) ?? { key: item.key, added: 0, removed: 0 };
    cur.added += item.added;
    cur.removed += item.removed;
    merged.set(item.path, cur);
  }
  if (merged.size === 0) return undefined;
  let added = 0;
  let removed = 0;
  for (const v of merged.values()) {
    added += v.added;
    removed += v.removed;
  }
  const paths = [...merged.entries()].map(([path, v]) => ({ path, ...v }));
  return { files: merged.size, added, removed, paths };
}
