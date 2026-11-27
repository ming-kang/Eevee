import type { Context } from "@earendil-works/chord/context";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import type { Usage } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineDoc,
  defineDocFamily,
  type Harness,
} from "@earendil-works/pi-durable";
import type { Leaf, LeafDraft } from "./leaf.ts";
import {
  isLeftHalf,
  labelOf,
  leafSpan,
  parentOf,
  parseLabel,
  partnerOf,
  type Span,
} from "./span.ts";
import { oneLine } from "./text.ts";

export type SearchHit = Leaf & {
  readonly snippet: string;
};

export type NodeUsage = {
  readonly modelKey: string;
  readonly usage: Usage;
};

export type MemoryMetaState = {
  buckets: string[];
  usage: Record<string, JsonRepresentation<Usage>>;
};

export type MemoryBucketState = {
  nodes: Record<string, string>;
};

const BUCKET_SIZE = 64;
const SNIPPET_CHARS = 240;

export const MemoryMetaDoc = defineDoc<MemoryMetaState>({
  kind: "eevee.memory-meta",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ buckets: [], usage: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export const MemoryBucketDoc = defineDocFamily<MemoryBucketState, null>({
  kind: "eevee.memory-bucket",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: () => ({ nodes: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

const bucketKey = (span: Span): string =>
  `${span.size}:${Math.floor(span.start / span.size / BUCKET_SIZE)}`;

function addUsage(total: JsonRepresentation<Usage>, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  if (usage.cacheWrite1h !== undefined) {
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  }
  if (usage.reasoning !== undefined) {
    total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  }
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;
}

function accumulateUsage(
  totals: Record<string, JsonRepresentation<Usage>>,
  modelKey: string,
  usage: Usage,
): void {
  const existing = Object.hasOwn(totals, modelKey) ? totals[modelKey] : undefined;
  if (existing === undefined) {
    totals[modelKey] = copyJson(usage, {
      omitUndefinedProperties: true,
    }) as JsonRepresentation<Usage>;
  } else {
    addUsage(existing, usage);
  }
}

/**
 * Conversation-scoped summary forest store. Immutable summary nodes and Dreamer usage live in
 * conversation documents (`fork: "initial"`); leaves are rebuilt in memory from the transcript.
 * Writes commit before updating memory so memory never runs ahead of durable state.
 */
export class MemoryStore {
  readonly conversationId: ConversationId;
  readonly #harness: Pick<Harness, "snapshot" | "commit">;
  readonly #nodes = new Map<string, string>();
  readonly #usage: Record<string, JsonRepresentation<Usage>> = {};
  readonly #leaves: Leaf[] = [];
  #scanned: number | undefined;

  private constructor(
    harness: Pick<Harness, "snapshot" | "commit">,
    conversationId: ConversationId,
  ) {
    this.#harness = harness;
    this.conversationId = conversationId;
  }

  static async open(
    harness: Pick<Harness, "snapshot" | "commit">,
    conversationId: ConversationId,
    context: Context,
  ): Promise<MemoryStore> {
    const meta = await harness.snapshot(MemoryMetaDoc, conversationId, context);
    const keys = meta?.buckets ?? [];
    const buckets = await Promise.all(
      keys.map((key) => harness.snapshot(MemoryBucketDoc, conversationId, key, context)),
    );
    const store = new MemoryStore(harness, conversationId);
    for (const [modelKey, usage] of Object.entries(meta?.usage ?? {})) {
      store.#usage[modelKey] = structuredClone(usage);
    }
    for (const bucket of buckets) {
      if (bucket === undefined) continue;
      for (const [label, text] of Object.entries(bucket.nodes)) {
        store.#nodes.set(label, text);
      }
    }
    return store;
  }

  scannedThrough(): number | undefined {
    return this.#scanned;
  }

  append(drafts: readonly LeafDraft[], scannedThrough: number): Leaf[] {
    const scanned = this.#scanned ?? Number.NEGATIVE_INFINITY;
    let index = this.#leaves.length;
    const added: Leaf[] = [];
    for (const draft of drafts) {
      if (draft.entry <= scanned) continue;
      const leaf = { ...draft, index: index++ };
      this.#leaves.push(leaf);
      added.push(leaf);
    }
    if (scannedThrough > scanned) this.#scanned = scannedThrough;
    return added;
  }

  leafCount(): number {
    return this.#leaves.length;
  }

  leaf(index: number): Leaf | undefined {
    return this.#leaves[index];
  }

  leavesBefore(entry: number): number {
    let low = 0;
    let high = this.#leaves.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if ((this.#leaves[mid] as Leaf).entry < entry) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  node(span: Span): string | undefined {
    return this.#nodes.get(labelOf(span));
  }

  usage(): Record<string, JsonRepresentation<Usage>> {
    return structuredClone(this.#usage);
  }

  /** Write-once node commit; records Dreamer model usage in the same transaction when supplied. */
  async putNode(span: Span, text: string, context: Context, usage?: NodeUsage): Promise<void> {
    const label = labelOf(span);
    if (this.#nodes.has(label)) return;
    const key = bucketKey(span);
    const storedText = await this.#harness.commit(async (tx) => {
      const bucket = await tx.doc(MemoryBucketDoc, this.conversationId, key, null);
      if (bucket.nodes[label] === undefined) bucket.nodes[label] = text;
      const meta = await tx.doc(MemoryMetaDoc, this.conversationId);
      if (!meta.buckets.includes(key)) meta.buckets.push(key);
      if (usage !== undefined) accumulateUsage(meta.usage, usage.modelKey, usage.usage);
      return bucket.nodes[label] as string;
    }, context);
    this.#nodes.set(label, storedText);
    if (usage !== undefined) accumulateUsage(this.#usage, usage.modelKey, usage.usage);
  }

  pendingLeaves(): number[] {
    const pending: number[] = [];
    for (const leaf of this.#leaves) {
      if (!this.#nodes.has(labelOf(leafSpan(leaf.index)))) {
        pending.push(leaf.index);
      }
    }
    return pending;
  }

  pendingMerges(): Span[] {
    const pending: Span[] = [];
    for (const label of this.#nodes.keys()) {
      const span = parseLabel(label);
      if (span === undefined || !isLeftHalf(span)) continue;
      if (!this.#nodes.has(labelOf(partnerOf(span)))) continue;
      const parent = parentOf(span);
      if (this.#nodes.has(labelOf(parent))) continue;
      pending.push(parent);
    }
    pending.sort((a, b) => a.start - b.start || a.size - b.size);
    return pending;
  }

  search(query: string, limit: number, before?: number): SearchHit[] {
    const words = query.split(/\s+/).filter(Boolean);
    if (words.length === 0 || limit <= 0) return [];
    const lower = words.map((word) => word.toLowerCase());
    const hits: SearchHit[] = [];
    for (
      let at = Math.min(this.#leaves.length, before ?? this.#leaves.length) - 1;
      at >= 0 && hits.length < limit;
      at--
    ) {
      const leaf = this.#leaves[at] as Leaf;
      const text = leaf.text.toLowerCase();
      if (lower.every((word) => text.includes(word))) {
        hits.push({ ...leaf, snippet: snippetOf(leaf.text, words[0] as string) });
      }
    }
    return hits;
  }
}

function snippetOf(text: string, word: string): string {
  const at = text.toLowerCase().indexOf(word.toLowerCase());
  const start = Math.max(0, Math.floor(at - SNIPPET_CHARS / 2));
  const slice = text.slice(start, start + SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${oneLine(slice)}${start + SNIPPET_CHARS < text.length ? "…" : ""}`;
}
