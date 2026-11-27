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
  canMerge,
  clipMiddle,
  composeView,
  covers,
  endOf,
  estimateTokens,
  fitTokens,
  fold,
  isLeftHalf,
  type Leaf,
  labelOf,
  leafOf,
  leafPreview,
  leafSpan,
  lineOf,
  type MemoryViewStore,
  mergeDue,
  oneLine,
  PENDING_LINE,
  parentOf,
  parseLabel,
  parseMemorySpans,
  partnerOf,
  proseOf,
  recallBudget,
  type Span,
  sourceOf,
  spanAt,
  spanText,
  splitSpan,
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

function fakeViewStore(options: { leaves: Leaf[]; nodes: Map<string, string> }): MemoryViewStore {
  return {
    leafCount: () => options.leaves.length,
    leaf: (index) => options.leaves[index],
    leavesBefore: (entry) => options.leaves.filter((leaf) => leaf.entry < entry).length,
    node: (span) => options.nodes.get(labelOf(span)),
  };
}

test("spanAt, parseLabel, and geometry helpers validate spans and compute parent, partner, split, and due", () => {
  assert.deepEqual(spanAt(0, 1), { start: 0, size: 1 });
  assert.deepEqual(spanAt(4, 4), { start: 4, size: 4 });
  assert.deepEqual(spanAt(8, 8), { start: 8, size: 8 });

  assert.equal(spanAt(-1, 1), undefined);
  assert.equal(spanAt(0, 0), undefined);
  assert.equal(spanAt(0, 3), undefined);
  assert.equal(spanAt(2, 4), undefined);
  assert.equal(spanAt(1.5, 1), undefined);
  assert.equal(spanAt(0, Number.MAX_SAFE_INTEGER), undefined);
  assert.equal(spanAt(Number.MAX_SAFE_INTEGER, 1), undefined);

  assert.deepEqual(parseLabel("0+1"), { start: 0, size: 1 });
  assert.deepEqual(parseLabel("4+4"), { start: 4, size: 4 });
  assert.equal(parseLabel("00+1"), undefined);
  assert.equal(parseLabel("0+01"), undefined);
  assert.equal(parseLabel("-1+1"), undefined);
  assert.equal(parseLabel("2+4"), undefined);
  assert.equal(parseLabel("0+3"), undefined);
  assert.equal(parseLabel("9007199254740992+1"), undefined);
  assert.equal(parseLabel(" 0+1"), undefined);

  const rightHalf: Span = { start: 4, size: 4 };
  const leftHalf: Span = { start: 0, size: 4 };
  assert.equal(endOf(rightHalf), 8);
  assert.equal(labelOf(rightHalf), "4+4");
  assert.equal(isLeftHalf(leftHalf), true);
  assert.equal(isLeftHalf(rightHalf), false);
  assert.deepEqual(parentOf(leftHalf), { start: 0, size: 8 });
  assert.deepEqual(parentOf(rightHalf), { start: 0, size: 8 });
  assert.deepEqual(partnerOf(rightHalf), leftHalf);
  assert.deepEqual(partnerOf(leftHalf), rightHalf);
  assert.equal(canMerge(leftHalf, rightHalf), true);
  assert.equal(canMerge(rightHalf, { start: 8, size: 4 }), false);
  assert.equal(canMerge(leftHalf, { start: 4, size: 2 }), false);
  assert.deepEqual(splitSpan(rightHalf), [
    { start: 4, size: 2 },
    { start: 6, size: 2 },
  ]);
  assert.throws(() => splitSpan(leafSpan(0)), RangeError);

  assert.equal(mergeDue({ start: 4, size: 4 }, 41), 17);

  assert.equal(covers([{ start: 0, size: 2 }, leafSpan(2)], 3), true);
  assert.equal(covers([{ start: 0, size: 2 }, leafSpan(3)], 4), false);
  assert.equal(covers([{ start: 0, size: 2 }], 3), false);
  assert.equal(covers([{ start: 0, size: 0 }], 0), false);
});

test("parseMemorySpans extracts spans from CompactionEntry and rejects non-memory or malformed blocks", () => {
  const validCompaction = makeEntry(
    20,
    CompactionEntry.kind,
    [
      userMsg(
        "The conversation history before this point was compacted into the following summary:\n\n<summary>\n<memory>\n0+4|user: discussed <memory> and </memory> tags inline\n4+2|assistant: confirmed\n6+1|user: next step\n</memory>\n\nOpening notes mentioning </memory> safely.\n</summary>",
      ),
    ],
    15,
  );
  assert.deepEqual(parseMemorySpans(validCompaction), [
    { start: 0, size: 4 },
    { start: 4, size: 2 },
    { start: 6, size: 1 },
  ]);

  const nonCompaction = makeEntry(21, "pi.user", [userMsg("<memory>\n0+1|fake\n</memory>")]);
  assert.equal(parseMemorySpans(nonCompaction), undefined);

  const nativeSummary = makeEntry(
    22,
    CompactionEntry.kind,
    [userMsg("<summary>\n## Goal\nPlain text summary.\n</summary>")],
    15,
  );
  assert.equal(parseMemorySpans(nativeSummary), undefined);

  const malformedLabel = makeEntry(
    23,
    CompactionEntry.kind,
    [userMsg("<summary>\n<memory>\n0+3|bad power of two\n</memory>\n</summary>")],
    15,
  );
  assert.equal(parseMemorySpans(malformedLabel), undefined);

  const missingBar = makeEntry(
    24,
    CompactionEntry.kind,
    [userMsg("<summary>\n<memory>\n0+1 without separator\n</memory>\n</summary>")],
    15,
  );
  assert.equal(parseMemorySpans(missingBar), undefined);

  assert.equal(parseMemorySpans(undefined), undefined);
});

test("fold keeps older merged lines intact and merges only the most due built sibling pairs", () => {
  const initial: Span[] = [
    { start: 0, size: 4 },
    { start: 4, size: 2 },
    { start: 6, size: 2 },
    leafSpan(8),
    leafSpan(9),
    leafSpan(10),
    leafSpan(11),
  ];

  const untouched = fold(
    initial,
    16,
    { min: 40, max: 100 },
    () => 10,
    () => true,
  );
  assert.deepEqual(untouched, initial);

  const foldedOnce = fold(
    initial,
    16,
    { min: 60, max: 65 },
    () => 10,
    () => true,
  );
  assert.deepEqual(foldedOnce.map(labelOf), ["0+4", "4+2", "6+2", "8+2", "10+1", "11+1"]);
  assert.deepEqual(foldedOnce.slice(0, 3), initial.slice(0, 3));

  const onlyBuilt10 = fold(
    initial,
    16,
    { min: 40, max: 65 },
    () => 10,
    (span) => labelOf(span) === "10+2",
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

test("spanText, leafPreview, composeView, and recallBudget preserve prefixes and fall back cleanly", () => {
  const leaves: Leaf[] = Array.from({ length: 8 }, (_, index) => ({
    index,
    entry: (index + 1) * 10,
    kind: index % 2 === 0 ? "user" : "assistant",
    text: `message-${index} content`,
    at: 1_700_000_000_000 + index * 1000,
  }));
  const nodes = new Map<string, string>([
    ["0+1", "m0"],
    ["1+1", "m1"],
    ["2+1", "m2"],
    ["3+1", "m3"],
    ["4+1", "m4"],
    ["5+1", "m5"],
    ["0+2", "m0-1"],
    ["2+2", "m2-3"],
    ["0+4", "m0-3"],
  ]);
  const store = fakeViewStore({ leaves, nodes });

  assert.equal(spanText(store, { start: 0, size: 2 }), "m0-1");
  assert.equal(spanText(store, { start: 4, size: 2 }), undefined);
  assert.equal(leafPreview(leaves[6] as Leaf), "user: message-6 content");
  assert.equal(spanText(store, leafSpan(6)), `${PENDING_LINE} user: message-6 content`);
  assert.equal(lineOf(store, { start: 0, size: 2 }), "0+2|m0-1");

  const previousSpans: Span[] = [{ start: 0, size: 2 }, leafSpan(2), leafSpan(3)];
  const keptPrefixView = composeView(store, 70, previousSpans, { min: 100, max: 200 });
  assert.deepEqual(keptPrefixView.spans.map(labelOf), ["0+2", "2+1", "3+1", "4+1", "5+1"]);

  const rebuiltView = composeView(store, 50, undefined, { min: 1, max: 1 });
  assert.deepEqual(rebuiltView.spans.map(labelOf), ["0+4"]);
  assert.equal(covers(rebuiltView.spans, 4), true);

  const invalidPrev = composeView(store, 50, [{ start: 0, size: 2 }, leafSpan(3)], {
    min: 100,
    max: 200,
  });
  assert.deepEqual(invalidPrev.spans.map(labelOf), ["0+1", "1+1", "2+1", "3+1"]);

  const bigBudget = recallBudget(200_000, 80_000);
  assert.deepEqual(bigBudget.compaction, { reserveTokens: 120_000, keepRecentTokens: 20_000 });
  assert.deepEqual(bigBudget.view, { min: 10_000, max: 20_000 });

  const tinyWindowBudget = recallBudget(10_000, 80_000);
  assert.equal(tinyWindowBudget.compaction, null);
  assert.equal(recallBudget(undefined, 80_000).compaction, null);
});
