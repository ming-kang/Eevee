import { contentText, type UserMessage } from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  type CompactionSettings,
  DEFAULT_COMPACTION_POLICY,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { type Leaf, sourceOf } from "./leaf.ts";
import {
  canMerge,
  covers,
  endOf,
  labelOf,
  leafSpan,
  mergeDue,
  parentOf,
  parseLabel,
  type Span,
} from "./span.ts";
import { estimateTokens, fitTokens, oneLine } from "./text.ts";

export const LINE_TOKENS = 160;
export const PENDING_LINE = "(not summarized yet: zoom it)";

export type Budget = {
  readonly min: number;
  readonly max: number;
};

export type RecallBudget = {
  readonly compaction: CompactionSettings | null;
  readonly view: Budget;
};

export type MemoryNodeReader = {
  node(span: Span): string | undefined;
  leaf(index: number): Leaf | undefined;
};

export type MemoryViewStore = MemoryNodeReader & {
  leafCount(): number;
  leavesBefore(entry: number): number;
};

export type MemoryView = {
  readonly spans: readonly Span[];
  readonly lines: readonly string[];
  readonly tokens: number;
};

const KEEP_SHARE = 0.25;
const VIEW_SHARE = 0.25;
// Rendered lines pass through `oneLine`, so closing tags only appear on their own line.
const MEMORY_BLOCK = /(?:^|\n)<memory>\n([\s\S]*?)\n<\/memory>(?:\n|$)/;

export const leafPreview = (leaf: Pick<Leaf, "kind" | "text">): string =>
  fitTokens(oneLine(sourceOf(leaf)), LINE_TOKENS);

export function spanText(store: MemoryNodeReader, span: Span): string | undefined {
  const built = store.node(span);
  if (built !== undefined) return oneLine(built);
  if (span.size !== 1) return undefined;
  const leaf = store.leaf(span.start);
  return leaf && `${PENDING_LINE} ${leafPreview(leaf)}`;
}

export const lineOf = (store: MemoryNodeReader, span: Span): string =>
  `${labelOf(span)}|${spanText(store, span) ?? PENDING_LINE}`;

export function parseMemorySpans(entry: EntryRecord | undefined): Span[] | undefined {
  if (entry === undefined || !CompactionEntry.is(entry)) return undefined;
  const text = (entry.model ?? [])
    .filter((message): message is UserMessage => message.role === "user")
    .map((message) => contentText(message.content))
    .join("\n");
  const match = MEMORY_BLOCK.exec(text);
  const body = match?.[1];
  if (!body) return undefined;
  const spans: Span[] = [];
  for (const line of body.split("\n")) {
    const bar = line.indexOf("|");
    if (bar === -1) return undefined;
    const span = parseLabel(line.slice(0, bar));
    if (span === undefined) return undefined;
    spans.push(span);
  }
  return spans.length > 0 ? spans : undefined;
}

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

/**
 * Merge adjacent built sibling pairs, highest `mergeDue` first, once total size passes
 * `budget.max`, until it fits `budget.min`. High-size older prefix lines score low and stay put,
 * preserving the provider prompt-cache prefix.
 */
export function fold(
  view: readonly Span[],
  totalLeaves: number,
  budget: Budget,
  sizeOf: (span: Span) => number,
  built: (span: Span) => boolean,
): Span[] {
  const spans = [...view];
  const sizes = spans.map(sizeOf);
  let totalSize = sizes.reduce((sum, value) => sum + value, 0);
  if (totalSize <= budget.max) return spans;
  while (totalSize > budget.min) {
    const pair = mostDuePair(spans, totalLeaves, built);
    if (pair === undefined) break;
    const parent = parentOf(spans[pair] as Span);
    const parentSize = sizeOf(parent);
    totalSize += parentSize - (sizes[pair] ?? 0) - (sizes[pair + 1] ?? 0);
    spans.splice(pair, 2, parent);
    sizes.splice(pair, 2, parentSize);
  }
  return spans;
}

function mostDuePair(
  spans: readonly Span[],
  totalLeaves: number,
  built: (span: Span) => boolean,
): number | undefined {
  let best: number | undefined;
  let bestDue = Number.NEGATIVE_INFINITY;
  for (let at = 0; at + 1 < spans.length; at++) {
    const left = spans[at] as Span;
    const right = spans[at + 1] as Span;
    if (!canMerge(left, right)) continue;
    const parent = parentOf(left);
    if (!built(parent)) continue;
    const due = mergeDue(parent, totalLeaves);
    if (due > bestDue) {
      bestDue = due;
      best = at;
    }
  }
  return best;
}

export function composeView(
  store: MemoryViewStore,
  firstKept: number,
  previousSpans: readonly Span[] | undefined,
  budget: Budget,
): MemoryView {
  const covered = store.leavesBefore(firstKept);
  const previousEnd = previousSpans?.length ? endOf(previousSpans.at(-1) as Span) : 0;
  const kept =
    previousSpans !== undefined &&
    previousSpans.length > 0 &&
    previousEnd <= covered &&
    covers(previousSpans, previousEnd)
      ? previousSpans
      : [];
  const grown = [...kept];
  for (let index = kept.length === 0 ? 0 : previousEnd; index < covered; index++) {
    grown.push(leafSpan(index));
  }
  const lines = new Map<string, string>();
  const line = (span: Span) => {
    const label = labelOf(span);
    let text = lines.get(label);
    if (text === undefined) {
      text = lineOf(store, span);
      lines.set(label, text);
    }
    return text;
  };
  const spans = fold(
    grown,
    store.leafCount(),
    budget,
    (span) => estimateTokens(line(span)),
    (span) => store.node(span) !== undefined,
  );
  const rendered = spans.map(line);
  return {
    spans,
    lines: rendered,
    tokens: rendered.reduce((sum, text) => sum + estimateTokens(text), 0),
  };
}
