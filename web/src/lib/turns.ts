import { countWork } from "./activity.ts";
import type { TranscriptDisplayItem } from "./transcript-map.ts";

/**
 * Turn folding: a turn opens on an inbound line (something you sent or that arrived for you) and
 * holds everything that answers it — work and replies alike. When the turn is finished and it did
 * real work, the whole turn folds into one "Worked for …" line whose closed view still shows every
 * reply and dispatch. A turn that is still running, that never produced a reply, or that did
 * nothing but talk keeps every line out in the open.
 */

/** Lines that open a turn — the agent works in answer to them. */
const INBOUND: ReadonlySet<TranscriptDisplayItem["kind"]> = new Set(["user", "qa", "event"]);

/** Lines that close a turn and always stand alone; `idle`/`failure` also forbid folding it. */
const STANDALONE: ReadonlySet<TranscriptDisplayItem["kind"]> = new Set([
  "more",
  "gap",
  "reset",
  "opening",
  "idle",
  "failure",
  "report",
  "worked",
]);

/** A turn that ends in one of these was interrupted or failed: it stays fully expanded. */
const BROKEN_END: ReadonlySet<TranscriptDisplayItem["kind"]> = new Set(["idle", "failure"]);

/**
 * The lines that are not work: replies the turn wrote and the Router's dispatch lines. A folded
 * group keeps them visible while closed; a turn needs at least one other kind to fold at all.
 */
const VISIBLE_WHEN_CLOSED: ReadonlySet<TranscriptDisplayItem["kind"]> = new Set([
  "assistant",
  "dispatch",
]);

const isTurnBody = (item: TranscriptDisplayItem): boolean =>
  !INBOUND.has(item.kind) && !STANDALONE.has(item.kind);

const isWork = (item: TranscriptDisplayItem): boolean => !VISIBLE_WHEN_CLOSED.has(item.kind);

/** A line that is still being written or run right now keeps its turn expanded. */
const isLive = (item: TranscriptDisplayItem): boolean => {
  switch (item.kind) {
    case "assistant":
      return item.streaming === true;
    case "thinking":
      return item.streaming === true;
    case "tools":
    case "dispatch":
      return item.live;
    case "bash":
      return item.status === "run";
    case "edit":
      return item.status === "run";
    default:
      return false;
  }
};

const atOf = (item: TranscriptDisplayItem): number | undefined => {
  switch (item.kind) {
    case "user":
    case "assistant":
    case "event":
    case "qa":
    case "reset":
    case "bash":
      return item.at;
    case "report":
      return item.report.at;
    default:
      return undefined;
  }
};

type Worked = Extract<TranscriptDisplayItem, { kind: "worked" }>;

/** The children a folded group shows while closed: the turn's replies and dispatches, in order. */
export function closedItems(item: Worked): TranscriptDisplayItem[] {
  return item.items.filter((child) => !isWork(child));
}

/**
 * Folds the finished turns in a mapped transcript. `live` means the conversation is still running:
 * the last turn then always stays expanded, whatever its lines look like. All other turns fold
 * when they contain work — tools, edits, commands, thinking — and at least one reply.
 */
export function foldTurns(
  items: readonly TranscriptDisplayItem[],
  live: boolean,
): TranscriptDisplayItem[] {
  const out: TranscriptDisplayItem[] = [];
  let turn: TranscriptDisplayItem[] = [];
  let boundaryAt: number | undefined;

  const flush = (mayFold: boolean) => {
    if (turn.length === 0) return;
    const hasWork = turn.some(isWork);
    const hasReply = turn.some((i) => i.kind === "assistant" && i.text.trim() !== "");
    if (mayFold && hasWork && hasReply && !turn.some(isLive)) {
      let latestAt: number | undefined;
      for (const i of turn) {
        const at = atOf(i);
        if (at !== undefined && (latestAt === undefined || at > latestAt)) latestAt = at;
      }
      const ms =
        boundaryAt !== undefined && latestAt !== undefined && latestAt > boundaryAt
          ? latestAt - boundaryAt
          : undefined;
      out.push({
        kind: "worked",
        key: `worked:${(turn[0] as TranscriptDisplayItem).key}`,
        items: turn,
        ...(ms === undefined ? {} : { ms }),
        activity: countWork(turn),
      });
      turn = [];
      return;
    }
    out.push(...turn);
    turn = [];
  };

  for (const item of items) {
    if (isTurnBody(item)) {
      turn.push(item);
      continue;
    }
    flush(!BROKEN_END.has(item.kind));
    out.push(item);
    // The next turn times itself from the line that opened it, when that line carries a time.
    boundaryAt = atOf(item);
  }
  flush(!live);
  return out;
}

/**
 * Keys of the last assistant message of every turn — the ones a message-action row belongs to.
 * Descends into folded groups, where the last assistant child is that turn's final reply.
 */
export function finalAssistantKeys(items: readonly TranscriptDisplayItem[]): Set<string> {
  const keys = new Set<string>();
  for (const [i, item] of items.entries()) {
    if (item.kind === "worked") {
      const last = item.items.findLast((child) => child.kind === "assistant");
      if (last) keys.add(last.key);
      continue;
    }
    if (item.kind !== "assistant") continue;
    // Final within its turn: the next boundary line, or another assistant, decides.
    let final = true;
    for (let j = i + 1; j < items.length; j += 1) {
      const next = items[j] as TranscriptDisplayItem;
      if (next.kind === "assistant") {
        final = false;
        break;
      }
      if (isTurnBody(next)) continue;
      break;
    }
    if (final) keys.add(item.key);
  }
  return keys;
}
