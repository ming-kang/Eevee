import type { Context } from "@earendil-works/chord/context";
import type {
  CommitObservation,
  Cursor,
  EntryId,
  EntryRecord,
  Harness,
  Page,
} from "@earendil-works/pi-durable";
import { leafOf, proseOf, sourceOf } from "./leaf.ts";
import { labelOf, leafSpan, mergeDue, parentOf, partnerOf, type Span, splitSpan } from "./span.ts";
import type { MemoryStore, NodeUsage } from "./store.ts";
import type { Summarize, SummaryTask } from "./summarizer.ts";
import { clipMiddle, estimateTokens, fitTokens, oneLine } from "./text.ts";
import { LINE_TOKENS, leafPreview } from "./view.ts";

export type EntryPager = (
  minEntryId: EntryId | undefined,
  cursor: Cursor | undefined,
  context: Context,
) => Promise<Page<EntryRecord, Cursor>>;

export type DreamerErrorInfo = {
  readonly phase: "ingest" | "summarize" | "store";
  readonly span?: Span;
};

export type DreamerDeps = {
  readonly store: MemoryStore;
  readonly pager: EntryPager;
  readonly summarizer: () => Summarize | undefined;
  readonly context: Context;
  readonly label?: string;
  readonly harness?: Pick<Harness, "observeCommits">;
  readonly concurrency?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown, info: DreamerErrorInfo) => void;
};

export const ENTRY_PAGE = 200;

const CONCURRENCY = 4;
const LEAF_CONTEXT_LINES = 2;
const SOURCE_CHARS = 60_000;
const RETRY_MS = 30_000;
const MAX_RETRY_MS = 10 * 60_000;

export async function ingestEntries(
  store: MemoryStore,
  pager: EntryPager,
  context: Context,
): Promise<void> {
  const scanned = store.scannedThrough();
  const from = scanned === undefined ? undefined : ((scanned + 1) as EntryId);
  let cursor: Cursor | undefined;
  do {
    const page = await pager(from, cursor, context);
    const newest = page.items.at(-1)?.id;
    if (newest !== undefined) {
      store.append(
        page.items.flatMap((entry) => leafOf(entry) ?? []),
        newest,
      );
    }
    cursor = page.next;
  } while (cursor !== undefined);
}

type NodePlan =
  | { readonly kind: "drop" }
  | { readonly kind: "free"; readonly text: string }
  | { readonly kind: "model" };

type WorkItem =
  | { readonly kind: "free"; readonly span: Span; readonly text: string }
  | { readonly kind: "model"; readonly span: Span };

function isHigherPriorityMerge(a: Span, aDue: number, b: Span, bDue: number): boolean {
  if (aDue !== bDue) return aDue > bDue;
  if (a.start !== b.start) return a.start < b.start;
  return a.size < b.size;
}

export class Dreamer {
  readonly #deps: DreamerDeps;
  readonly #merges: Span[];
  readonly #leaves: Span[];
  readonly #queued = new Set<string>();
  readonly #inFlight = new Set<string>();
  readonly #needsModel = new Set<string>();
  readonly #retries = new Map<string, { count: number; at: number }>();
  readonly #running = new Set<Promise<void>>();
  readonly #observation: CommitObservation | undefined;
  #nextLeaf: number;
  #ingesting: Promise<void> = Promise.resolve();
  #failing = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(deps: DreamerDeps) {
    this.#deps = deps;
    this.#merges = deps.store.pendingMerges();
    this.#leaves = deps.store.pendingLeaves().map(leafSpan);
    for (const span of [...this.#merges, ...this.#leaves]) {
      this.#queued.add(labelOf(span));
    }
    this.#nextLeaf = deps.store.leafCount();
    this.#observation = deps.harness?.observeCommits({
      advance: (publication) => {
        if (
          publication.changes.some(
            (change) =>
              change.type === "entry" && change.value.conversationId === deps.store.conversationId,
          )
        ) {
          this.wake();
        }
      },
      end: () => {},
    });
  }

  sync(context: Context = this.#deps.context): Promise<void> {
    const next = this.#ingesting.then(() =>
      ingestEntries(this.#deps.store, this.#deps.pager, context),
    );
    this.#ingesting = next.catch(() => {});
    return next;
  }

  wake(): void {
    if (this.#closed) return;
    this.sync().then(
      () => this.#pump(),
      (error) => this.#report(error, { phase: "ingest" }),
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#observation?.detach();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    await Promise.allSettled([this.#ingesting, ...this.#running]);
  }

  async idle(): Promise<void> {
    await this.#ingesting;
    this.#pump();
    while (this.#running.size > 0) {
      await Promise.allSettled([...this.#running]);
    }
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #enqueue(span: Span, front = false): void {
    const label = labelOf(span);
    if (this.#queued.has(label) || this.#inFlight.has(label)) return;
    if (this.#deps.store.node(span) !== undefined) return;
    this.#queued.add(label);
    const queue = span.size === 1 ? this.#leaves : this.#merges;
    if (front) queue.unshift(span);
    else queue.push(span);
  }

  #pump(): void {
    if (this.#closed) return;
    const count = this.#deps.store.leafCount();
    while (this.#nextLeaf < count) {
      this.#enqueue(leafSpan(this.#nextLeaf++));
    }
    const summarize = this.#deps.summarizer();
    const limit = this.#deps.concurrency ?? CONCURRENCY;
    while (this.#running.size < limit) {
      const next = this.#take(summarize !== undefined);
      if (next === undefined) break;
      const label = labelOf(next.span);
      this.#inFlight.add(label);
      if (next.kind === "free") {
        this.#track(
          label,
          this.#settle(next.span, next.text).catch((error) =>
            this.#defer(next.span, error, "store"),
          ),
        );
      } else if (summarize !== undefined) {
        this.#track(label, this.#build(next.span, summarize));
      } else {
        this.#inFlight.delete(label);
        break;
      }
    }
    this.#scheduleRetry();
  }

  #track(label: string, work: Promise<void>): void {
    const run = work.finally(() => {
      this.#inFlight.delete(label);
      this.#running.delete(run);
      this.#pump();
    });
    this.#running.add(run);
  }

  #take(withModel: boolean): WorkItem | undefined {
    const now = this.#now();
    return this.#takeMerge(withModel, now) ?? this.#takeLeaf(withModel, now);
  }

  #takeMerge(withModel: boolean, now: number): WorkItem | undefined {
    const { store } = this.#deps;
    const totalLeaves = store.leafCount();
    let best: { at: number; due: number; item: WorkItem } | undefined;
    let at = 0;
    while (at < this.#merges.length) {
      const span = this.#merges[at] as Span;
      const label = labelOf(span);
      if (store.node(span) !== undefined || this.#inFlight.has(label)) {
        this.#merges.splice(at, 1);
        this.#queued.delete(label);
        continue;
      }
      if ((this.#retries.get(label)?.at ?? 0) > now) {
        at++;
        continue;
      }
      const plan = this.#needsModel.has(label) ? ({ kind: "model" } as const) : this.#plan(span);
      if (plan.kind === "drop") {
        this.#merges.splice(at, 1);
        this.#queued.delete(label);
        continue;
      }
      if (plan.kind === "model") {
        this.#needsModel.add(label);
        if (!withModel) {
          at++;
          continue;
        }
      }
      const due = mergeDue(span, totalLeaves);
      if (best === undefined || isHigherPriorityMerge(span, due, best.item.span, best.due)) {
        best = {
          at,
          due,
          item:
            plan.kind === "free"
              ? { kind: "free", span, text: plan.text }
              : { kind: "model", span },
        };
      }
      at++;
    }
    if (best === undefined) return undefined;
    this.#merges.splice(best.at, 1);
    this.#queued.delete(labelOf(best.item.span));
    return best.item;
  }

  #takeLeaf(withModel: boolean, now: number): WorkItem | undefined {
    const { store } = this.#deps;
    let at = 0;
    while (at < this.#leaves.length) {
      const span = this.#leaves[at] as Span;
      const label = labelOf(span);
      if (store.node(span) !== undefined || this.#inFlight.has(label)) {
        this.#leaves.splice(at, 1);
        this.#queued.delete(label);
        continue;
      }
      if ((this.#retries.get(label)?.at ?? 0) > now) {
        at++;
        continue;
      }
      const plan = this.#needsModel.has(label) ? ({ kind: "model" } as const) : this.#plan(span);
      if (plan.kind === "drop") {
        this.#leaves.splice(at, 1);
        this.#queued.delete(label);
        continue;
      }
      if (plan.kind === "free") {
        this.#leaves.splice(at, 1);
        this.#queued.delete(label);
        return { kind: "free", span, text: plan.text };
      }
      this.#needsModel.add(label);
      if (!withModel) {
        at++;
        continue;
      }
      this.#leaves.splice(at, 1);
      this.#queued.delete(label);
      return { kind: "model", span };
    }
    return undefined;
  }

  #plan(span: Span): NodePlan {
    const { store } = this.#deps;
    if (span.size === 1) {
      const leaf = store.leaf(span.start);
      if (leaf === undefined) return { kind: "drop" };
      const line = oneLine(sourceOf(leaf));
      if (estimateTokens(line) <= LINE_TOKENS) return { kind: "free", text: line };
      const prose = oneLine(proseOf(leaf));
      return estimateTokens(prose) <= LINE_TOKENS
        ? { kind: "free", text: fitTokens(line, LINE_TOKENS) }
        : { kind: "model" };
    }
    const [left, right] = splitSpan(span).map((child) => store.node(child));
    if (left === undefined || right === undefined) return { kind: "drop" };
    const joined = `${left}\n${right}`;
    return estimateTokens(oneLine(joined)) <= LINE_TOKENS
      ? { kind: "free", text: joined }
      : { kind: "model" };
  }

  #contextBefore(start: number): string[] {
    const { store } = this.#deps;
    const from = Math.max(0, start - LEAF_CONTEXT_LINES);
    const context: string[] = [];
    for (let index = from; index < start; index++) {
      const built = store.node(leafSpan(index));
      if (built !== undefined) {
        context.push(oneLine(built));
        continue;
      }
      const leaf = store.leaf(index);
      if (leaf !== undefined) context.push(leafPreview(leaf));
    }
    return context;
  }

  #task(span: Span): SummaryTask | undefined {
    const { store } = this.#deps;
    if (span.size === 1) {
      const leaf = store.leaf(span.start);
      return (
        leaf && {
          input: [clipMiddle(sourceOf(leaf), SOURCE_CHARS)],
          context: this.#contextBefore(span.start),
        }
      );
    }
    const [left, right] = splitSpan(span).map((child) => store.node(child));
    if (left === undefined || right === undefined) return undefined;
    return { input: [left, right], context: [] };
  }

  async #build(span: Span, summarize: Summarize): Promise<void> {
    const task = this.#task(span);
    if (task === undefined) return;
    let text: string;
    let usage: NodeUsage | undefined;
    try {
      const result = await summarize(task, this.#deps.context.abortSignal);
      text = fitTokens(oneLine(result.text), LINE_TOKENS);
      if (text === "") throw new Error("The summary came back empty");
      if (result.usage !== undefined && result.modelKey !== undefined) {
        usage = { modelKey: result.modelKey, usage: result.usage };
      }
    } catch (error) {
      this.#defer(span, error, "summarize");
      return;
    }
    if (this.#closed) return;
    this.#failing = false;
    try {
      await this.#settle(span, text, usage);
    } catch (error) {
      this.#defer(span, error, "store");
    }
  }

  async #settle(span: Span, text: string, usage?: NodeUsage): Promise<void> {
    const { store } = this.#deps;
    await store.putNode(span, text, this.#deps.context, usage);
    const label = labelOf(span);
    this.#retries.delete(label);
    this.#needsModel.delete(label);
    const parent = parentOf(span);
    if (store.node(partnerOf(span)) !== undefined && store.node(parent) === undefined) {
      this.#enqueue(parent);
    }
  }

  #defer(span: Span, error: unknown, phase: "summarize" | "store"): void {
    if (this.#closed) return;
    const label = labelOf(span);
    const count = (this.#retries.get(label)?.count ?? 0) + 1;
    const baseMs = this.#deps.retryBaseMs ?? RETRY_MS;
    const maxMs = this.#deps.retryMaxMs ?? MAX_RETRY_MS;
    const delay = Math.min(baseMs * 2 ** (count - 1), maxMs);
    this.#retries.set(label, { count, at: this.#now() + delay });
    // Clear in-flight before re-enqueuing so `#enqueue` accepts it; `#track`'s finally is idempotent.
    this.#inFlight.delete(label);
    this.#enqueue(span, true);
    if (!this.#failing) {
      this.#failing = true;
      this.#report(error, { phase, span });
    }
  }

  #report(error: unknown, info: DreamerErrorInfo): void {
    if (this.#deps.onError !== undefined) {
      this.#deps.onError(error, info);
      return;
    }
    const prefix = this.#deps.label ? `[${this.#deps.label}] ` : "";
    const detail =
      info.phase === "ingest"
        ? "Dreamer could not read entries."
        : `Dreamer could not ${info.phase} ${info.span ? labelOf(info.span) : "node"}; it will be tried again.`;
    console.error(`${prefix}${detail}`, error);
  }

  #scheduleRetry(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const now = this.#now();
    const waiting = [...this.#retries.values()].map((retry) => retry.at).filter((at) => at > now);
    if (this.#closed || waiting.length === 0) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.#pump();
      },
      Math.max(0, Math.min(...waiting) - now),
    );
    this.#timer.unref();
  }
}
