import type { CompactionSettings } from "@earendil-works/pi-durable";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { lineOf, type MemoryNodeReader } from "./lines.ts";
import { type Budget, covers, endOf, fold, keyOf, leafRef, type NodeRef } from "./shape.ts";
import { estimateTokens } from "./text.ts";

export type RecallBudget = {
  readonly compaction: CompactionSettings | null;
  readonly view: Budget;
};

export type MemoryView = {
  readonly nodes: readonly NodeRef[];
  readonly lines: readonly string[];
  readonly tokens: number;
};

export type MemoryViewStore = MemoryNodeReader & {
  leafCount(): number;
  leavesBefore(entry: number): number;
  view(firstKept: number): NodeRef[] | undefined;
};

const KEEP_SHARE = 0.25;
const VIEW_SHARE = 0.25;

export function recallBudget(window: number | undefined, threshold: number): RecallBudget {
  const reserve =
    window === undefined
      ? 0
      : Math.max(DEFAULT_COMPACTION_POLICY.reserveTokens, window - threshold);
  const fits = window !== undefined && window > reserve;
  const usable = fits ? window - reserve : threshold;
  const viewMax = Math.round(usable * VIEW_SHARE);
  return {
    compaction: fits
      ? { reserveTokens: reserve, keepRecentTokens: Math.round(usable * KEEP_SHARE) }
      : null,
    view: { min: Math.round(viewMax / 2), max: viewMax },
  };
}

export function composeView(
  store: MemoryViewStore,
  firstKept: number,
  previousFirstKept: number | undefined,
  budget: Budget,
): MemoryView {
  const covered = store.leavesBefore(firstKept);
  const previous = previousFirstKept === undefined ? undefined : store.view(previousFirstKept);
  const previousEnd = previous?.length ? endOf(previous.at(-1) as NodeRef) : 0;
  const kept =
    previous !== undefined && previousEnd <= covered && covers(previous, previousEnd)
      ? previous
      : [];
  const grown = [...kept];
  for (let index = kept.length === 0 ? 0 : previousEnd; index < covered; index++) {
    grown.push(leafRef(index));
  }
  const lines = new Map<string, string>();
  const line = (node: NodeRef) => {
    const key = keyOf(node);
    let text = lines.get(key);
    if (text === undefined) {
      text = lineOf(store, node);
      lines.set(key, text);
    }
    return text;
  };
  const nodes = fold(
    grown,
    store.leafCount(),
    budget,
    (node) => estimateTokens(line(node)),
    (node) => store.node(node) !== undefined,
  );
  const rendered = nodes.map(line);
  return {
    nodes,
    lines: rendered,
    tokens: rendered.reduce((sum, text) => sum + estimateTokens(text), 0),
  };
}
