import type { TranscriptDisplayItem, WorkedCounts } from "./transcript-map.ts";

/**
 * Turn folding: a turn opens on an inbound line (something you sent or that arrived for you) and
 * holds the work that answers it. When the turn is finished and its work ends in a visible reply,
 * everything before the reply folds into one "Worked for …" line; the reply stays on the page.
 * A turn that is still running, or that never produced a reply, keeps every line out in the open.
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

/** The reply a finished turn leaves visible: its trailing run of messages and dispatches. */
const TAIL: ReadonlySet<TranscriptDisplayItem["kind"]> = new Set(["assistant", "dispatch"]);

const isWork = (item: TranscriptDisplayItem): boolean =>
  !INBOUND.has(item.kind) && !STANDALONE.has(item.kind);

/** A line that is still being written or run right now keeps its turn expanded. */
const isLive = (item: TranscriptDisplayItem): boolean => {
  switch (item.kind) {
    case "assistant":
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

const countWork = (items: readonly TranscriptDisplayItem[]): WorkedCounts => {
  const counts: WorkedCounts = { tools: 0, commands: 0, files: 0, dispatched: 0 };
  for (const item of items) {
    if (item.kind === "tools") counts.tools += item.steps.length;
    else if (item.kind === "bash") counts.commands += 1;
    else if (item.kind === "edit") counts.files += 1;
    else if (item.kind === "dispatch") {
      counts.dispatched += item.actions.filter((a) => a.kind === "create").length;
    }
  }
  return counts;
};

/**
 * Folds the finished turns in a mapped transcript. `live` means the conversation is still running:
 * the last turn then always stays expanded, whatever its lines look like. All other turns fold when
 * they end in a reply and did something to get there.
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
    if (mayFold && !turn.some(isLive)) {
      // The tail stays on the page: the contiguous run of replies the turn ends with.
      let tailStart = turn.length;
      while (tailStart > 0 && TAIL.has((turn[tailStart - 1] as TranscriptDisplayItem).kind)) {
        tailStart -= 1;
      }
      const folded = turn.slice(0, tailStart);
      const tail = turn.slice(tailStart);
      if (folded.length > 0 && tail.some((i) => i.kind === "assistant" && i.text.trim() !== "")) {
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
          key: `worked:${(folded[0] as TranscriptDisplayItem).key}`,
          items: folded,
          ...(ms === undefined ? {} : { ms }),
          counts: countWork(folded),
        });
        out.push(...tail);
        turn = [];
        return;
      }
    }
    out.push(...turn);
    turn = [];
  };

  for (const item of items) {
    if (isWork(item)) {
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
 * Runs on the folded transcript, so an assistant folded into a group never counts as final.
 */
export function finalAssistantKeys(items: readonly TranscriptDisplayItem[]): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as TranscriptDisplayItem;
    if (item.kind !== "assistant") continue;
    // Final within its turn: the next non-work line, or another assistant, decides.
    let final = true;
    for (let j = i + 1; j < items.length; j += 1) {
      const next = items[j] as TranscriptDisplayItem;
      if (next.kind === "assistant") {
        final = false;
        break;
      }
      if (isWork(next)) continue;
      break;
    }
    if (final) keys.add(item.key);
  }
  return keys;
}
