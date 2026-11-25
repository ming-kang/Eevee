import type { Context } from "@earendil-works/chord/context";
import {
  CompactionEntry,
  CompactionTask,
  type ConversationId,
  type DocumentReader,
  defineExtension,
  defineTool,
  type Extension,
  hook,
  section,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { arr, int, lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { ENTRY_PAGE, ingestEntries } from "./dreamer.ts";
import { MEMORY_TOOLS, SEARCH_TOOL, ZOOM_TOOL } from "./leaf.ts";
import { lineOf, nodeText, PENDING_LINE } from "./lines.ts";
import { childrenOf, endOf, nodeAt, spanOf, startOf } from "./shape.ts";
import type { MemoryStore } from "./store.ts";
import { composeView, type RecallBudget } from "./view.ts";

export {
  Dreamer,
  type DreamerDeps,
  type DreamerErrorInfo,
  ENTRY_PAGE,
  type EntryPager,
  ingestEntries,
} from "./dreamer.ts";
export {
  type Leaf,
  type LeafDraft,
  type LeafKind,
  leafOf,
  MEMORY_TOOLS,
  proseOf,
  SEARCH_TOOL,
  sourceOf,
  ZOOM_TOOL,
} from "./leaf.ts";
export {
  LINE_TOKENS,
  lineOf,
  type MemoryNodeReader,
  nodeText,
  PENDING_LINE,
  textsBefore,
} from "./lines.ts";
export {
  type Budget,
  childrenOf,
  coverBackward,
  covers,
  endOf,
  type ForestNodeRef,
  fold,
  keyOf,
  labelOf,
  leafRef,
  type NodeRef,
  nodeAt,
  parentOf,
  siblingOf,
  spanOf,
  startOf,
} from "./shape.ts";
export {
  MAX_STORED_VIEWS,
  MemoryBucketDoc,
  type MemoryBucketState,
  MemoryMetaDoc,
  type MemoryMetaState,
  MemoryStore,
  MemoryViewsDoc,
  type MemoryViewsState,
  type NodeUsage,
  type SearchHit,
} from "./store.ts";
export {
  createSummarizer,
  SUMMARY_PROMPT,
  type Summarize,
  type SummarizerModelChoice,
  type SummaryResult,
  type SummaryTask,
} from "./summarizer.ts";
export { clipMiddle, estimateTokens, fitTokens, oneLine } from "./text.ts";
export {
  composeView,
  type MemoryView,
  type MemoryViewStore,
  type RecallBudget,
  recallBudget,
} from "./view.ts";

export const MEMORY_EXTENSION = "eevee.memory";

export type MemoryBinding = {
  readonly store: MemoryStore;
  budget(): RecallBudget;
  sync?(context: Context): Promise<void>;
  opening?(reader: DocumentReader, context: Context): Promise<string | undefined>;
};

export type MemoryExtensionOptions = {
  resolve(conversationId: ConversationId): MemoryBinding | undefined;
};

const SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const OVERFLOW = 2;

const GUIDE = `Your memory of this conversation is a binary tree of one-line summaries. Once the context grows long, its older part is replaced by <memory>: lines covering every message before the ones you still see, oldest first. Recent lines cover one message each; older lines cover more.

  id+n|text   the n messages from message id on, summarized

- ${ZOOM_TOOL}(id, n) opens line id+n into the two lines it was made from; ${ZOOM_TOOL}(id, 1) gives message id whole.
- ${SEARCH_TOOL}(query) finds messages holding every word, newest first; zoom into a hit to read it.

Before you act on, guess at or ask about something from the past, look it up: search for exact names, paths, numbers and errors, and zoom to follow a line. The newest mention of a thing is the truth. Summaries keep little of tool output, so say in your replies what you learned that will matter later.`;

const LEAF_KIND_SCHEMA = union([lit("user"), lit("assistant"), lit("tool")]);

const ZOOM_OUTPUT_SCHEMA = union([
  obj({
    kind: lit("leaf"),
    id: int({ minimum: 0 }),
    n: lit(1),
    leafKind: LEAF_KIND_SCHEMA,
    at: num(),
    text: str(),
  }),
  obj({
    kind: lit("branch"),
    id: int({ minimum: 0 }),
    n: int({ minimum: 2 }),
    children: arr(
      obj({
        id: int({ minimum: 0 }),
        n: int({ minimum: 1 }),
        line: str(),
        text: str(),
      }),
    ),
  }),
]);

const SEARCH_OUTPUT_SCHEMA = obj({
  query: str(),
  hits: arr(
    obj({
      id: int({ minimum: 0 }),
      kind: LEAF_KIND_SCHEMA,
      at: num(),
      snippet: str(),
    }),
  ),
  nextBefore: opt(int({ minimum: 1 })),
});

export function createMemoryExtension(options: MemoryExtensionOptions): Extension {
  const zoom = defineTool({
    name: MEMORY_TOOLS.zoom,
    description:
      "Open line id+n of your memory into the two lines it was made from; with n = 1, read message id whole.",
    parameters: obj({
      id: int({ minimum: 0, description: "The line's first message" }),
      n: int({ minimum: 1, description: "How many messages the line covers, a power of two" }),
    }),
    structuredOutputSchema: ZOOM_OUTPUT_SCHEMA,
    replay: "safe",
    async execute(args, api, context): Promise<ToolExecutionResult> {
      const binding = options.resolve(api.conversationId);
      if (binding === undefined) {
        return errorResult("Memory is not attached to this conversation.");
      }
      await binding.sync?.(context);
      const node = nodeAt(args.id, args.n);
      if (node === undefined) {
        return errorResult(
          `${args.id}+${args.n} is not a line: n is a power of two and id a multiple of n.`,
        );
      }
      const count = binding.store.leafCount();
      if (count === 0) {
        return errorResult("No messages are in memory yet.");
      }
      if (endOf(node) > count) {
        return errorResult(
          `Messages ${args.id} to ${endOf(node) - 1} are not all in memory yet; the newest is ${count - 1}.`,
        );
      }
      if (node.level === 0) {
        const leaf = binding.store.leaf(node.index);
        if (leaf === undefined) return errorResult(`Message ${args.id} is not in memory.`);
        return {
          output: [
            {
              type: "text",
              text: `${args.id}+1|${leaf.kind} · ${formatTime(leaf.at)}\n${leaf.text}`,
            },
          ],
          structuredOutput: {
            kind: "leaf",
            id: args.id,
            n: 1,
            leafKind: leaf.kind,
            at: leaf.at,
            text: leaf.text,
          },
        };
      }
      const children = childrenOf(node).map((child) => {
        const text = nodeText(binding.store, child) ?? PENDING_LINE;
        return {
          id: startOf(child),
          n: spanOf(child),
          line: lineOf(binding.store, child),
          text,
        };
      });
      return {
        output: [{ type: "text", text: children.map((child) => child.line).join("\n") }],
        structuredOutput: {
          kind: "branch",
          id: args.id,
          n: args.n,
          children,
        },
      };
    },
  });

  const search = defineTool({
    name: MEMORY_TOOLS.search,
    description:
      "Find the messages of this conversation that hold every word of the query, newest first. Words may be in any language; matching ignores case.",
    parameters: obj({
      query: str({ minLength: 1, description: "Words that must all appear, separated by spaces" }),
      before: opt(int({ minimum: 1, description: "Only messages before this message id" })),
      limit: opt(
        int({ minimum: 1, maximum: MAX_SEARCH_LIMIT, description: "How many hits, default 10" }),
      ),
    }),
    structuredOutputSchema: SEARCH_OUTPUT_SCHEMA,
    replay: "safe",
    async execute(args, api, context): Promise<ToolExecutionResult> {
      const binding = options.resolve(api.conversationId);
      if (binding === undefined) {
        return errorResult("Memory is not attached to this conversation.");
      }
      await binding.sync?.(context);
      const limit = args.limit ?? SEARCH_LIMIT;
      const found = binding.store.search(args.query, limit + 1, args.before);
      const hasMore = found.length > limit;
      const hits = hasMore ? found.slice(0, limit) : found;
      if (hits.length === 0) {
        return {
          output: [{ type: "text", text: `No message holds every word of “${args.query}”.` }],
          structuredOutput: { query: args.query, hits: [] },
        };
      }
      const lines = hits.map(
        (hit) => `${hit.index}+1|${hit.kind} · ${formatTime(hit.at)}|${hit.snippet}`,
      );
      const oldest = hits.at(-1)?.index;
      const nextBefore = hasMore && oldest !== undefined && oldest > 0 ? oldest : undefined;
      if (nextBefore !== undefined) {
        lines.push(`Older hits may remain: search again with before=${nextBefore}.`);
      }
      return {
        output: [{ type: "text", text: lines.join("\n") }],
        structuredOutput: {
          query: args.query,
          hits: hits.map((hit) => ({
            id: hit.index,
            kind: hit.kind,
            at: hit.at,
            snippet: hit.snippet,
          })),
          ...(nextBefore === undefined ? {} : { nextBefore }),
        },
      };
    },
  });

  return defineExtension({
    name: MEMORY_EXTENSION,
    tools: [zoom, search],
    sections: [
      section("memory", (input) =>
        options.resolve(input.conversationId) === undefined ? undefined : GUIDE,
      ),
    ],
    hooks: [
      hook(CompactionTask, {
        async beforeCompact(compaction, api, context) {
          const binding = options.resolve(api.conversationId);
          if (binding === undefined) return undefined;
          await binding.sync?.(context);
          await ingestEntries(
            binding.store,
            (minEntryId, cursor, ctx) =>
              api.entries(
                { ...(minEntryId === undefined ? {} : { minEntryId }), order: "ascending" },
                ENTRY_PAGE,
                cursor,
                ctx,
              ),
            context,
          );
          const head = compaction.entries[0];
          const previous = head !== undefined && CompactionEntry.is(head) ? head.head : undefined;
          const budget = binding.budget().view;
          const view = composeView(binding.store, compaction.firstKept, previous, budget);
          if (view.nodes.length === 0 || view.tokens > budget.max * OVERFLOW) return undefined;
          await binding.store.saveView(compaction.firstKept, view.nodes, context);
          const opening = await binding.opening?.(api, context);
          const body = `<memory>\n${view.lines.join("\n")}\n</memory>`;
          return {
            summary: opening ? `${body}\n\n${opening}` : body,
          };
        },
      }),
    ],
  });
}

const formatTime = (at: number): string =>
  new Date(at).toISOString().slice(0, 16).replace("T", " ");

const errorResult = (message: string) => ({
  output: [{ type: "text" as const, text: message }],
  isError: true,
});
