import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AssistantMessage,
  Message,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { CompactionEntry, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import {
  childrenOf,
  clipMiddle,
  composeView,
  coverBackward,
  covers,
  endOf,
  estimateTokens,
  fitTokens,
  fold,
  keyOf,
  type Leaf,
  labelOf,
  leafOf,
  leafRef,
  lineOf,
  type MemoryViewStore,
  type NodeRef,
  nodeAt,
  nodeText,
  oneLine,
  PENDING_LINE,
  parentOf,
  proseOf,
  recallBudget,
  siblingOf,
  sourceOf,
  spanOf,
  startOf,
  textsBefore,
} from "../src/index.ts";

function makeEntry(
  id: number,
  kind: string,
  model?: readonly Message[],
  head?: number,
): EntryRecord {
  return {
    id: id as EntryId,
    conversationId: 1 as EntryRecord["conversationId"],
    kind,
    ...(model === undefined ? {} : { model }),
    ...(head === undefined ? {} : { head: head as EntryId }),
    createdAt: id,
  } as EntryRecord;
}

function userMsg(content: UserMessage["content"], timestamp = 1_700_000_000_000): UserMessage {
  return { role: "user", content, timestamp };
}

function assistantMsg(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  timestamp = 1_700_000_000_100,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp,
  };
}

function toolResultMsg(
  toolName: string,
  content: ToolResultMessage["content"],
  isError = false,
  timestamp = 1_700_000_000_200,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName,
    content,
    isError,
    timestamp,
  };
}

function systemMsg(prompt: string): SystemMessage {
  return { role: "system", content: "", sections: { base: prompt }, timestamp: 1 };
}

function fakeViewStore(options: {
  leaves: Leaf[];
  nodes: Map<string, string>;
  views?: Map<number, NodeRef[]>;
}): MemoryViewStore {
  return {
    leafCount: () => options.leaves.length,
    leaf: (index) => options.leaves[index],
    leavesBefore: (entry) => options.leaves.filter((leaf) => leaf.entry < entry).length,
    node: (ref) => options.nodes.get(keyOf(ref)),
    view: (firstKept) => {
      const found = options.views?.get(firstKept);
      return found === undefined ? undefined : [...found];
    },
  };
}

test("nodeAt validates addresses and shape helpers convert parent, sibling, children, and labels", () => {
  assert.deepEqual(nodeAt(0, 1), { level: 0, index: 0 });
  assert.deepEqual(nodeAt(4, 4), { level: 2, index: 1 });
  assert.deepEqual(nodeAt(8, 8), { level: 3, index: 1 });

  assert.equal(nodeAt(-1, 1), undefined);
  assert.equal(nodeAt(0, 0), undefined);
  assert.equal(nodeAt(0, 3), undefined);
  assert.equal(nodeAt(2, 4), undefined);
  assert.equal(nodeAt(1.5, 1), undefined);
  assert.equal(nodeAt(0, Number.MAX_SAFE_INTEGER), undefined);
  assert.equal(nodeAt(Number.MAX_SAFE_INTEGER, 1), undefined);

  const node = { level: 2, index: 1 };
  assert.equal(spanOf(node), 4);
  assert.equal(startOf(node), 4);
  assert.equal(endOf(node), 8);
  assert.equal(labelOf(node), "4+4");
  assert.equal(keyOf(node), "2:1");
  assert.deepEqual(parentOf(node), { level: 3, index: 0 });
  assert.deepEqual(siblingOf(node), { level: 2, index: 0 });
  assert.deepEqual(siblingOf({ level: 2, index: 0 }), node);
  assert.deepEqual(childrenOf(node), [
    { level: 1, index: 2 },
    { level: 1, index: 3 },
  ]);
  assert.throws(() => childrenOf(leafRef(0)), RangeError);

  assert.equal(
    covers(
      [
        { level: 1, index: 0 },
        { level: 0, index: 2 },
      ],
      3,
    ),
    true,
  );
  assert.equal(
    covers(
      [
        { level: 1, index: 0 },
        { level: 0, index: 3 },
      ],
      4,
    ),
    false,
  );
  assert.equal(covers([{ level: 1, index: 0 }], 3), false);
});

test("coverBackward tiles [0, end) newest first with largest built nodes", () => {
  const built = new Set(["2:0", "1:2"]);
  const nodes = [...coverBackward(7, (ref) => built.has(keyOf(ref)))];
  assert.deepEqual(nodes.map(labelOf), ["6+1", "4+2", "0+4"]);

  const partial = [...coverBackward(7, (ref) => keyOf(ref) === "1:2")];
  assert.deepEqual(partial.map(labelOf), ["6+1", "4+2", "3+1", "2+1", "1+1", "0+1"]);
});

test("fold keeps older merged lines intact and merges only the most due built sibling pairs", () => {
  const initial: NodeRef[] = [
    { level: 2, index: 0 }, // 0+4
    { level: 1, index: 2 }, // 4+2
    { level: 1, index: 3 }, // 6+2
    leafRef(8),
    leafRef(9),
    leafRef(10),
    leafRef(11),
  ];

  // Everything fits under budget.max: no folding occurs.
  const untouched = fold(
    initial,
    16,
    { min: 40, max: 100 },
    () => 10,
    () => true,
  );
  assert.deepEqual(untouched, initial);

  // Pair (8+1, 9+1) has due = (16 - 9) / 1 = 7; (10+1, 11+1) has due = (16 - 11) / 1 = 5;
  // (4+2, 6+2) has due = (16 - 7) / 2 = 4.5.
  // So 8+1 & 9+1 fold first into 8+2, leaving older prefix [0+4, 4+2, 6+2] untouched.
  const foldedOnce = fold(
    initial,
    16,
    { min: 60, max: 65 },
    () => 10,
    () => true,
  );
  assert.deepEqual(foldedOnce.map(labelOf), ["0+4", "4+2", "6+2", "8+2", "10+1", "11+1"]);
  assert.deepEqual(foldedOnce.slice(0, 3), initial.slice(0, 3));

  // Unbuilt parents are never folded even if due.
  const onlyBuilt10 = fold(
    initial,
    16,
    { min: 40, max: 65 },
    () => 10,
    (node) => keyOf(node) === "1:5",
  );
  assert.deepEqual(onlyBuilt10.map(labelOf), ["0+4", "4+2", "6+2", "8+1", "9+1", "10+2"]);
});

test("text helpers estimate CJK/ASCII tokens, normalize whitespace, and fit or clip cleanly", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("中文ab"), 3);
  assert.equal(oneLine("  hello\n\tworld  "), "hello world");

  const fitted = fitTokens("first clause; second clause; third clause is much longer", 8);
  assert.ok(fitted.endsWith("…"));
  assert.ok(estimateTokens(fitted) <= 8);

  // Tiny limits with no sentence punctuation must not mis-treat -1 + mark.length as a match.
  const tiny = fitTokens("abcdefgh", 1);
  assert.equal(tiny, "…");

  const clipped = clipMiddle("0123456789abcdefghij", 10);
  assert.ok(clipped.startsWith("01234"));
  assert.ok(clipped.includes("10 characters omitted"));
  assert.ok(clipped.endsWith("fghij"));
});

test("leafOf skips head markers, system, failed assistants, thinking, and memory lookup tools", () => {
  const compactionHead = makeEntry(1, CompactionEntry.kind, [userMsg("<memory>...</memory>")], 1);
  assert.equal(leafOf(compactionHead), undefined);

  const sysOnly = makeEntry(2, "pi.system", [systemMsg("base")]);
  assert.equal(leafOf(sysOnly), undefined);

  const errorAssistant = makeEntry(3, "pi.assistant", [
    assistantMsg([{ type: "text", text: "partial crash" }], "error"),
  ]);
  assert.equal(leafOf(errorAssistant), undefined);

  const thinkingAndLookupOnly = makeEntry(4, "pi.assistant", [
    assistantMsg([
      { type: "thinking", thinking: "secret chain of thought" },
      { type: "toolCall", id: "c1", name: "zoom", arguments: { id: 0, n: 2 } },
      { type: "toolCall", id: "c2", name: "search", arguments: { query: "foo" } },
    ]),
  ]);
  assert.equal(leafOf(thinkingAndLookupOnly), undefined);

  const zoomResult = makeEntry(5, "pi.tool-result", [
    toolResultMsg("zoom", [{ type: "text", text: "0+1|..." }]),
  ]);
  assert.equal(leafOf(zoomResult), undefined);

  const searchResult = makeEntry(6, "pi.tool-result", [
    toolResultMsg("search", [{ type: "text", text: "hits..." }]),
  ]);
  assert.equal(leafOf(searchResult), undefined);

  const richAssistant = makeEntry(7, "pi.assistant", [
    assistantMsg([
      { type: "thinking", thinking: "must be omitted" },
      { type: "text", text: "Checking file" },
      { type: "toolCall", id: "c3", name: "zoom", arguments: { id: 0, n: 1 } },
      { type: "toolCall", id: "c4", name: "read", arguments: { path: "src/app.ts" } },
    ]),
  ]);
  const assistantLeaf = leafOf(richAssistant);
  assert.ok(assistantLeaf);
  assert.equal(assistantLeaf.kind, "assistant");
  assert.equal(assistantLeaf.text, 'Checking file\n→ read {"path":"src/app.ts"}');
  assert.equal(proseOf(assistantLeaf), "Checking file");
  assert.equal(sourceOf(assistantLeaf), 'assistant: Checking file\n→ read {"path":"src/app.ts"}');

  const toolErr = makeEntry(8, "pi.tool-result", [
    toolResultMsg("read", [{ type: "text", text: "ENOENT" }], true),
  ]);
  const toolLeaf = leafOf(toolErr);
  assert.ok(toolLeaf);
  assert.equal(toolLeaf.kind, "tool");
  assert.equal(toolLeaf.text, "read (error): ENOENT");
  assert.equal(proseOf(toolLeaf), "");

  const userWithImage = makeEntry(9, "pi.user", [
    userMsg([
      { type: "text", text: "See screenshot" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]),
  ]);
  const userLeaf = leafOf(userWithImage);
  assert.equal(userLeaf?.kind, "user");
  assert.equal(userLeaf?.text, "See screenshot\n[image]");
});

test("lines, composeView, and recallBudget preserve prefixes and fall back when previous view is missing", () => {
  const leaves: Leaf[] = Array.from({ length: 8 }, (_, index) => ({
    index,
    entry: (index + 1) * 10,
    kind: index % 2 === 0 ? "user" : "assistant",
    text: `message-${index} content`,
    at: 1_700_000_000_000 + index * 1000,
  }));
  const nodes = new Map<string, string>([
    ["0:0", "m0"],
    ["0:1", "m1"],
    ["0:2", "m2"],
    ["0:3", "m3"],
    ["0:4", "m4"],
    ["0:5", "m5"],
    ["1:0", "m0-1"],
    ["1:1", "m2-3"],
    ["2:0", "m0-3"],
  ]);
  const views = new Map<number, NodeRef[]>([
    [50, [{ level: 1, index: 0 }, leafRef(2), leafRef(3)]],
  ]);
  const store = fakeViewStore({ leaves, nodes, views });

  assert.equal(nodeText(store, { level: 1, index: 0 }), "m0-1");
  assert.ok(nodeText(store, leafRef(6))?.startsWith(PENDING_LINE));
  assert.equal(lineOf(store, { level: 1, index: 0 }), "0+2|m0-1");
  assert.deepEqual(textsBefore(store, 6, 3), ["m0-3", "m4", "m5"]);

  // Starting from previousFirstKept=50 ([0+2, 2+1, 3+1]), grow through entry 70 (leaves 0..5).
  const keptPrefixView = composeView(store, 70, 50, { min: 100, max: 200 });
  assert.deepEqual(keptPrefixView.nodes.map(labelOf), ["0+2", "2+1", "3+1", "4+1", "5+1"]);

  // If previous view was pruned/missing, composeView rebuilds from leaves cleanly.
  const rebuiltView = composeView(store, 50, 999, { min: 1, max: 1 });
  assert.deepEqual(rebuiltView.nodes.map(labelOf), ["0+4"]);
  assert.equal(covers(rebuiltView.nodes, 4), true);

  const bigBudget = recallBudget(200_000, 80_000);
  assert.deepEqual(bigBudget.compaction, { reserveTokens: 120_000, keepRecentTokens: 20_000 });
  assert.deepEqual(bigBudget.view, { min: 10_000, max: 20_000 });

  const tinyWindowBudget = recallBudget(10_000, 80_000);
  assert.equal(tinyWindowBudget.compaction, null);
  assert.equal(recallBudget(undefined, 80_000).compaction, null);
});
