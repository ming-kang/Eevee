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
import { LINE_TOKENS, textsBefore } from "./lines.ts";
import { childrenOf, keyOf, labelOf, leafRef, type NodeRef, parentOf, siblingOf } from "./shape.ts";
import type { MemoryStore, NodeUsage } from "./store.ts";
import type { Summarize, SummaryTask } from "./summarizer.ts";
import { clipMiddle, estimateTokens, fitTokens, oneLine } from "./text.ts";

export type EntryPager = (
  minEntryId: EntryId | undefined,
  cursor: Cursor | undefined,
  context: Context,
) => Promise<Page<EntryRecord, Cursor>>;

export type DreamerErrorInfo = {
  readonly phase: "ingest" | "summarize" | "store";
  readonly node?: NodeRef;
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

type WorkItem =
  | { readonly kind: "free"; readonly node: NodeRef; readonly text: string }
  | { readonly kind: "model"; readonly node: NodeRef };

/**
 * Silent background builder for one conversation's summary tree. Subscribes to `observeCommits`
 * when a harness is supplied, ingests new entries into leaves, and builds missing tree nodes
 * bottom-up outside the durable task graph.
 */
export class Dreamer {
  readonly #deps: DreamerDeps;
  readonly #merges: NodeRef[];
  readonly #leaves: NodeRef[];
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
    this.#leaves = deps.store.pendingLeaves().map(leafRef);
    for (const node of [...this.#merges, ...this.#leaves]) {
      this.#queued.add(keyOf(node));
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

  #enqueue(node: NodeRef, front = false): void {
    const key = keyOf(node);
    if (this.#queued.has(key) || this.#inFlight.has(key)) return;
    if (this.#deps.store.node(node) !== undefined) return;
    this.#queued.add(key);
    const queue = node.level === 0 ? this.#leaves : this.#merges;
    if (front) queue.unshift(node);
    else queue.push(node);
  }

  #pump(): void {
    if (this.#closed) return;
    const count = this.#deps.store.leafCount();
    while (this.#nextLeaf < count) {
      this.#enqueue(leafRef(this.#nextLeaf++));
    }
    const summarize = this.#deps.summarizer();
    const limit = this.#deps.concurrency ?? CONCURRENCY;
    while (this.#running.size < limit) {
      const next = this.#take(summarize !== undefined);
      if (next === undefined) break;
      const key = keyOf(next.node);
      this.#inFlight.add(key);
      if (next.kind === "free") {
        this.#track(
          key,
          this.#settle(next.node, next.text).catch((error) =>
            this.#defer(next.node, error, "store"),
          ),
        );
      } else if (summarize !== undefined) {
        this.#track(key, this.#build(next.node, summarize));
      } else {
        this.#inFlight.delete(key);
        break;
      }
    }
    this.#scheduleRetry();
  }

  #track(key: string, work: Promise<void>): void {
    const run = work.finally(() => {
      this.#inFlight.delete(key);
      this.#running.delete(run);
      this.#pump();
    });
    this.#running.add(run);
  }

  #take(withModel: boolean): WorkItem | undefined {
    const { store } = this.#deps;
    const now = this.#now();
    for (const queue of [this.#merges, this.#leaves]) {
      let at = 0;
      while (at < queue.length) {
        const node = queue[at] as NodeRef;
        const key = keyOf(node);
        if (store.node(node) !== undefined || this.#inFlight.has(key)) {
          queue.splice(at, 1);
          this.#queued.delete(key);
          continue;
        }
        if ((this.#retries.get(key)?.at ?? 0) > now) {
          at++;
          continue;
        }
        if (!this.#needsModel.has(key)) {
          const free = this.#freeText(node);
          if (free === undefined) {
            queue.splice(at, 1);
            this.#queued.delete(key);
            continue;
          }
          if (free !== null) {
            queue.splice(at, 1);
            this.#queued.delete(key);
            return { kind: "free", node, text: free };
          }
          this.#needsModel.add(key);
        }
        if (!withModel) {
          at++;
          continue;
        }
        queue.splice(at, 1);
        this.#queued.delete(key);
        return { kind: "model", node };
      }
    }
    return undefined;
  }

  #freeText(node: NodeRef): string | null | undefined {
    const { store } = this.#deps;
    if (node.level === 0) {
      const leaf = store.leaf(node.index);
      if (leaf === undefined) return undefined;
      const line = oneLine(sourceOf(leaf));
      if (estimateTokens(line) <= LINE_TOKENS) return line;
      const prose = oneLine(proseOf(leaf));
      return estimateTokens(prose) <= LINE_TOKENS ? fitTokens(line, LINE_TOKENS) : null;
    }
    const [left, right] = childrenOf(node).map((child) => store.node(child));
    if (left === undefined || right === undefined) return undefined;
    const joined = `${left}\n${right}`;
    return estimateTokens(oneLine(joined)) <= LINE_TOKENS ? joined : null;
  }

  #task(node: NodeRef): SummaryTask | undefined {
    const { store } = this.#deps;
    if (node.level === 0) {
      const leaf = store.leaf(node.index);
      const context = textsBefore(store, node.index, LEAF_CONTEXT_LINES);
      return leaf && { input: [clipMiddle(sourceOf(leaf), SOURCE_CHARS)], context };
    }
    const [left, right] = childrenOf(node).map((child) => store.node(child));
    if (left === undefined || right === undefined) return undefined;
    return { input: [left, right], context: [] };
  }

  async #build(node: NodeRef, summarize: Summarize): Promise<void> {
    const task = this.#task(node);
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
      this.#defer(node, error, "summarize");
      return;
    }
    if (this.#closed) return;
    this.#failing = false;
    try {
      await this.#settle(node, text, usage);
    } catch (error) {
      this.#defer(node, error, "store");
    }
  }

  async #settle(node: NodeRef, text: string, usage?: NodeUsage): Promise<void> {
    const { store } = this.#deps;
    await store.putNode(node, text, this.#deps.context, usage);
    const key = keyOf(node);
    this.#retries.delete(key);
    this.#needsModel.delete(key);
    const parent = parentOf(node);
    if (store.node(siblingOf(node)) !== undefined && store.node(parent) === undefined) {
      this.#enqueue(parent);
    }
  }

  #defer(node: NodeRef, error: unknown, phase: "summarize" | "store"): void {
    if (this.#closed) return;
    const key = keyOf(node);
    const count = (this.#retries.get(key)?.count ?? 0) + 1;
    const baseMs = this.#deps.retryBaseMs ?? RETRY_MS;
    const maxMs = this.#deps.retryMaxMs ?? MAX_RETRY_MS;
    const delay = Math.min(baseMs * 2 ** (count - 1), maxMs);
    this.#retries.set(key, { count, at: this.#now() + delay });
    // Clear in-flight before re-enqueuing so `#enqueue` accepts it; `#track`'s finally is idempotent.
    this.#inFlight.delete(key);
    this.#enqueue(node, true);
    if (!this.#failing) {
      this.#failing = true;
      this.#report(error, { phase, node });
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
        : `Dreamer could not ${info.phase} ${info.node ? labelOf(info.node) : "node"}; it will be tried again.`;
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
