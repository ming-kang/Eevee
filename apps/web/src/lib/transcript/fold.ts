import { toolActivity } from "./tools.ts";
import type { ActivityCount, ActivityKind, DisplayItem, EditSummary } from "./types.ts";

const INBOUND = new Set<DisplayItem["kind"]>(["user", "notice"]);
const STANDALONE = new Set<DisplayItem["kind"]>(["compaction", "reset", "worked"]);
const VISIBLE_CLOSED = new Set<DisplayItem["kind"]>(["assistant", "dispatch"]);

const isTurnBody = (item: DisplayItem): boolean =>
  !INBOUND.has(item.kind) && !STANDALONE.has(item.kind);

const isWork = (item: DisplayItem): boolean => !VISIBLE_CLOSED.has(item.kind);

const isLiveItem = (item: DisplayItem): boolean => {
  if (item.kind === "assistant" || item.kind === "thinking") return item.streaming === true;
  if (item.kind === "tools" || item.kind === "dispatch") return item.live;
  if (item.kind === "bash" || item.kind === "edit") return item.status === "run";
  return false;
};

export function countWork(items: readonly DisplayItem[]): ActivityCount[] {
  const counts = new Map<ActivityKind, number>();
  const bump = (k: ActivityKind) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const item of items) {
    if (item.kind === "tools") {
      for (const s of item.steps) bump(toolActivity(s.name));
    } else if (item.kind === "edit") {
      bump("edit");
    } else if (item.kind === "bash") {
      bump("commands");
    }
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

export function editSummary(items: readonly DisplayItem[]): EditSummary | undefined {
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
  return {
    files: merged.size,
    added,
    removed,
    paths: [...merged.entries()].map(([path, v]) => ({ path, ...v })),
  };
}

export function closedWorkedItems(worked: Extract<DisplayItem, { kind: "worked" }>): DisplayItem[] {
  return worked.items.filter((child) => !isWork(child));
}

function flushTurnBuffer(
  out: DisplayItem[],
  turn: DisplayItem[],
  boundaryAt: number | undefined,
  mayFold: boolean,
): void {
  if (turn.length === 0) return;
  const hasWork = turn.some(isWork);
  const hasReply = turn.some((i) => i.kind === "assistant" && i.text.trim().length > 0);
  if (mayFold && hasWork && hasReply && !turn.some(isLiveItem)) {
    let latestAt: number | undefined;
    for (const i of turn) {
      if ("at" in i && typeof i.at === "number" && (latestAt === undefined || i.at > latestAt)) {
        latestAt = i.at;
      }
    }
    const ms =
      boundaryAt !== undefined && latestAt !== undefined && latestAt > boundaryAt
        ? latestAt - boundaryAt
        : undefined;
    out.push({
      kind: "worked",
      key: `worked:${turn[0]?.key ?? out.length}`,
      items: turn,
      ...(ms !== undefined ? { ms } : {}),
      activity: countWork(turn),
    });
    return;
  }
  out.push(...turn);
}

export function foldTurns(items: readonly DisplayItem[], liveBusy: boolean): DisplayItem[] {
  const out: DisplayItem[] = [];
  let turn: DisplayItem[] = [];
  let boundaryAt: number | undefined;

  for (const item of items) {
    if (isTurnBody(item)) {
      turn.push(item);
      continue;
    }
    flushTurnBuffer(out, turn, boundaryAt, true);
    turn = [];
    out.push(item);
    boundaryAt = "at" in item && typeof item.at === "number" ? item.at : undefined;
  }
  flushTurnBuffer(out, turn, boundaryAt, !liveBusy);
  return out;
}
