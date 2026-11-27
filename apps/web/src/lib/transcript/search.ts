import type { BoardViewPayload } from "@eevee/protocol";
import type { DisplayItem, FindMatch, OutlineEntry, VisualStage } from "./types.ts";

export function outlineEntries(items: readonly DisplayItem[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  let current: { key: string; text: string; reply?: string; at?: number } | undefined;
  for (const item of items) {
    if (item.kind === "user") {
      const first = item.text.trim().split("\n", 1)[0]?.trim() ?? "";
      const text = first.length > 72 ? `${first.slice(0, 71)}…` : first;
      current = { key: item.key, text, ...(item.at ? { at: item.at } : {}) };
      out.push(current);
      continue;
    }
    const reply =
      item.kind === "assistant"
        ? item.text
        : item.kind === "worked"
          ? item.items.findLast((c) => c.kind === "assistant")?.text
          : undefined;
    if (reply && current) {
      const flat = reply.replace(/\s+/g, " ").trim();
      if (flat) current.reply = flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
    }
  }
  return out;
}

export function itemSearchText(item: DisplayItem): string {
  switch (item.kind) {
    case "user":
    case "notice":
    case "thinking":
    case "assistant":
    case "reset":
      return item.text;
    case "compaction":
      return item.summary;
    case "bash":
      return `${item.command}\n${item.output}`;
    case "edit":
      return `${item.path}\n${item.diff.map((d) => d.text).join("\n")}`;
    case "dispatch":
      return item.actions.map((a) => `${a.verb} ${a.target ?? ""} ${a.detail ?? ""}`).join("\n");
    case "tools":
      return item.steps.map((s) => `${s.name} ${s.label} ${s.outputText ?? ""}`).join("\n");
    case "worked":
      return item.items.map(itemSearchText).join("\n");
  }
}

export function findMatches(items: readonly DisplayItem[], query: string): FindMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: FindMatch[] = [];
  for (const item of items) {
    const text = itemSearchText(item).toLowerCase();
    let hits = 0;
    let idx = text.indexOf(needle);
    while (idx !== -1) {
      hits += 1;
      idx = text.indexOf(needle, idx + needle.length);
    }
    if (hits > 0) matches.push({ key: item.key, hits });
  }
  return matches;
}

export function deriveBoardSummary(board: BoardViewPayload | undefined): {
  readonly stage: VisualStage;
  readonly pendingQuestions: number;
  readonly activeWorkers: number;
  readonly runningTasks: number;
  readonly openTickets: number;
} {
  if (!board) {
    return {
      stage: "idle",
      pendingQuestions: 0,
      activeWorkers: 0,
      runningTasks: 0,
      openTickets: 0,
    };
  }
  const pendingQuestions = board.questions.filter(
    (q) => q.answeredAt === undefined && q.withdrawnAt === undefined,
  ).length;
  const activeWorkers = board.workers.filter(
    (w) => w.status === "running" || w.status === "queued",
  ).length;
  const runningTasks = board.workers.reduce((sum, w) => sum + w.activeTaskCount, 0);
  const openTickets = board.tickets.filter((t) => t.status === "open").length;
  const stage: VisualStage =
    pendingQuestions > 0 ? "answer" : activeWorkers > 0 || runningTasks > 0 ? "working" : "idle";
  return { stage, pendingQuestions, activeWorkers, runningTasks, openTickets };
}
