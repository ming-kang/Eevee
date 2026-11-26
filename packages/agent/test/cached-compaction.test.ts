import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  type AssistantMessage,
  contentText,
  fauxAssistantMessage,
  fauxToolCall,
  type Message,
  type SimpleStreamOptions,
  type SystemMessage,
  type ToolResultMessage,
  type TranscriptContext,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  type Conversation,
  type EntryId,
  type EntryRecord,
  SystemEntry,
} from "@earendil-works/pi-durable";
import {
  CACHED_COMPACTION_EXTENSION,
  type CachedCompactionEvent,
  checkpointSummary,
  createCachedCompactionExtension,
  createCodingToolsExtension,
  extractFileOps,
  keptStart,
  reconstructConversationMessages,
  summaryInstruction,
} from "../src/index.ts";
import { createTestHarness } from "./harness.ts";

function entryId(value: number): EntryId {
  return value as EntryId;
}

function userMsg(text: string, timestamp = 1): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function systemMsg(prompt: string, timestamp = 1): SystemMessage {
  return {
    role: "system",
    content: "",
    sections: { base: prompt },
    timestamp,
  };
}

function assistantMsg(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  timestamp = 1,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp,
  };
}

function toolResultMsg(
  toolCallId: string,
  toolName: string,
  text: string,
  details?: JsonValue,
  timestamp = 1,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    ...(details === undefined ? {} : { details }),
    timestamp,
  };
}

function makeEntry(
  id: number,
  kind: string,
  model?: readonly Message[],
  extra?: Partial<EntryRecord>,
): EntryRecord {
  return {
    id: entryId(id),
    conversationId: 1 as EntryRecord["conversationId"],
    kind,
    ...(model === undefined ? {} : { model }),
    createdAt: id,
    ...extra,
  } as EntryRecord;
}

type CapturedCall = {
  readonly messages: readonly Message[];
  readonly options: SimpleStreamOptions | undefined;
};

async function submitAndWait(conversation: Conversation, content: string): Promise<void> {
  const submission = await conversation.submit({ type: "input", content }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
}

async function compactionEntries(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries(
    { order: "ascending" },
    200,
    undefined,
    BACKGROUND_CONTEXT,
  );
  return page.items.filter((entry) => CompactionEntry.is(entry));
}

function entryText(entry: EntryRecord): string {
  return (entry.model ?? [])
    .filter((message): message is UserMessage => message.role === "user")
    .map((message) => contentText(message.content))
    .join("\n");
}

function isNativeCompactionMessages(messages: readonly Message[]): boolean {
  const first = messages[0];
  const last = messages.at(-1);
  return (
    first?.role === "system" &&
    typeof first.content === "string" &&
    first.content.includes("context summarization assistant") &&
    last?.role === "user" &&
    contentText(last.content).includes("<conversation>")
  );
}

test("keptStart formats user/assistant previews, truncates at 400 chars, and counts duplicates", () => {
  const repeated = userMsg("continue", 10);
  const tailDuplicate = userMsg("continue", 10);
  const reply = assistantMsg(
    [
      { type: "text", text: "checking" },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ],
    "toolUse",
    11,
  );
  const conversation: Message[] = [
    systemMsg("sys", 1),
    userMsg("continue", 10),
    repeated,
    reply,
    tailDuplicate,
  ];
  const boundary = keptStart(conversation, [repeated, reply, tailDuplicate]);
  assert.deepEqual(boundary, { text: "continue", fromEnd: 2, count: 3 });

  const toolBoundary = keptStart(conversation, [reply, tailDuplicate]);
  assert.deepEqual(toolBoundary, {
    text: 'checking\n[tool call: read {"path":"a.ts"}]',
    fromEnd: 1,
    count: 2,
  });

  const longMsg = userMsg("x".repeat(450), 20);
  const longBoundary = keptStart([systemMsg("sys"), longMsg], [longMsg]);
  assert.equal(longBoundary?.text.length, 401);
  assert.equal(longBoundary?.text.endsWith("…"), true);

  const sysMsg = systemMsg("delta", 21);
  const skipped = keptStart([systemMsg("sys"), sysMsg, longMsg], [sysMsg, longMsg]);
  assert.equal(skipped?.count, 1);
  assert.equal(skipped?.text.startsWith("xxxx"), true);
});

test("summaryInstruction includes kept-start, occurrence disambiguation, tool call note, and focus", () => {
  const prompt = summaryInstruction(
    { text: '[tool call: read {"path":"a.ts"}]', fromEnd: 2, count: 4 },
    "keep error traces",
  );
  assert.ok(prompt.includes("followed by the last 4 messages"));
  assert.ok(prompt.includes("occurrence 2, counting backward"));
  assert.ok(prompt.includes("Tool calls are written as [tool call: name arguments]."));
  assert.ok(prompt.includes('<kept-start>\n[tool call: read {"path":"a.ts"}]\n</kept-start>'));
  assert.ok(prompt.includes("Additional focus from the user:\nkeep error traces"));
});

test("extractFileOps and checkpointSummary track direct, codemode, and prior compaction files", () => {
  const entries: EntryRecord[] = [
    makeEntry(
      1,
      CompactionEntry.kind,
      [
        userMsg(
          "<summary>\nPrior\n\n<read-files>\nold-read.ts\nshared.ts\n</read-files>\n\n<modified-files>\nold-mod.ts\n</modified-files>\n</summary>",
        ),
      ],
      { head: entryId(1) },
    ),
    makeEntry(2, "pi.assistant", [
      assistantMsg(
        [
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "new-read.ts" } },
          { type: "toolCall", id: "c2", name: "edit", arguments: { path: "shared.ts" } },
          { type: "toolCall", id: "c3", name: "write", arguments: { path: "written.ts" } },
        ],
        "toolUse",
      ),
    ]),
    makeEntry(3, "pi.assistant", [
      assistantMsg(
        [{ type: "toolCall", id: "c4", name: "write", arguments: { path: "ignored-error.ts" } }],
        "error",
      ),
    ]),
    makeEntry(4, "pi.tool-result", [
      toolResultMsg("c5", "codemode", "ok", {
        calls: [
          { id: 1, name: "read", args: '{"path":"script-read.ts"}', status: "ok" },
          { id: 2, name: "write", args: '{"path":"script-write.ts"}', status: "ok" },
          { id: 3, name: "read", args: '{"path":"truncated...', status: "ok" },
        ],
      }),
    ]),
  ];

  const ops = extractFileOps(entries);
  const result = checkpointSummary(
    "## Goal\nShip it\n\n<read-files>\nhallucinated.ts\n</read-files>",
    ops,
  );
  assert.deepEqual(result.readFiles, ["new-read.ts", "old-read.ts", "script-read.ts"]);
  assert.deepEqual(result.modifiedFiles, [
    "old-mod.ts",
    "script-write.ts",
    "shared.ts",
    "written.ts",
  ]);
  assert.ok(!result.summary.includes("hallucinated.ts"));
  assert.ok(
    result.summary.includes(
      "<read-files>\nnew-read.ts\nold-read.ts\nscript-read.ts\n</read-files>",
    ),
  );
  assert.ok(
    result.summary.includes(
      "<modified-files>\nold-mod.ts\nscript-write.ts\nshared.ts\nwritten.ts\n</modified-files>",
    ),
  );
});

test("reconstructConversationMessages mirrors leadWithSystem, edits, tool ordering, and head dedupe", () => {
  const baseSys = systemMsg("base prompt", 2);
  const u1 = userMsg("turn 1", 1);
  const a1 = assistantMsg(
    [
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "x.ts" } },
      { type: "toolCall", id: "c2", name: "read", arguments: { path: "y.ts" } },
    ],
    "toolUse",
    3,
  );
  const tr2 = toolResultMsg("c2", "read", "y", undefined, 4);
  const droppedErr = assistantMsg([{ type: "text", text: "boom" }], "error", 5);
  const u2 = userMsg("turn 2", 6);
  const u3 = userMsg("turn 3", 7);

  const head = makeEntry(8, CompactionEntry.kind, [userMsg("<summary>prev</summary>", 8)], {
    head: entryId(1),
  });
  const summarized: EntryRecord[] = [
    head,
    makeEntry(1, "pi.user", [u1]),
    makeEntry(2, SystemEntry.kind, [baseSys]),
    makeEntry(3, "pi.assistant", [a1]),
    makeEntry(4, "pi.tool-result", [tr2]),
    makeEntry(5, "pi.assistant", [droppedErr]),
  ];
  const kept: EntryRecord[] = [
    makeEntry(6, "pi.user", [u2]),
    makeEntry(7, "pi.user", [u3], {
      edits: [{ target: entryId(1), action: "omit" }],
    }),
    // Re-emitted head marker whose id >= firstKept (8 >= 6) must not be duplicated.
    head,
    makeEntry(9, SystemEntry.kind, [systemMsg("post-head baseline", 9)], {
      edits: [{ target: entryId(2), action: "omit" }],
    }),
  ];

  const reconstructed = reconstructConversationMessages(summarized, kept);
  assert.equal(reconstructed.messages[0]?.role, "system");
  assert.deepEqual(
    (reconstructed.messages[0] as SystemMessage).sections,
    { base: "post-head baseline" },
    "first pi.system after head becomes leading baseline",
  );
  assert.equal(
    reconstructed.messages.some(
      (message) => message.role === "user" && contentText(message.content) === "turn 1",
    ),
    false,
    "omit edit from kept entries applies to summarized entry",
  );
  assert.equal(
    reconstructed.messages.some(
      (message) => message.role === "assistant" && message.stopReason === "error",
    ),
    false,
    "error assistants are excluded",
  );
  const assistantIndex = reconstructed.messages.indexOf(a1);
  assert.ok(assistantIndex > 0);
  const firstResult = reconstructed.messages[assistantIndex + 1] as ToolResultMessage;
  const secondResult = reconstructed.messages[assistantIndex + 2] as ToolResultMessage;
  assert.equal(firstResult.toolCallId, "c1");
  assert.equal(firstResult.isError, true);
  assert.equal(secondResult.toolCallId, "c2");
  assert.equal(
    reconstructed.messages.filter(
      (message) =>
        message.role === "user" && contentText(message.content).includes("<summary>prev</summary>"),
    ).length,
    1,
    "head marker appears only once",
  );
  assert.equal(reconstructed.keptMessages.includes(u2), true);
  assert.equal(reconstructed.keptMessages.includes(u3), true);
});

test("manual compaction hits cached prefix with same sessionId, tracks file ops, and fires onCompact", async () => {
  const events: CachedCompactionEvent[] = [];
  const calls: CapturedCall[] = [];
  const cachedExt = createCachedCompactionExtension({
    onCompact: (event) => events.push(event),
  });
  assert.equal(cachedExt.name, CACHED_COMPACTION_EXTENSION);

  const th = await createTestHarness({
    extensions: [createCodingToolsExtension(), cachedExt],
    settings: {
      compaction: {
        enabled: true,
        keepRecentTokens: 20,
        reserveTokens: 1000,
        backgroundTokens: 0,
      },
    },
  });
  try {
    await writeFile(join(th.dir, "alpha.txt"), "hello alpha");
    const capture =
      (response: AssistantMessage) =>
      (context: TranscriptContext, options?: SimpleStreamOptions) => {
        calls.push({ messages: [...context.messages], options });
        return response;
      };

    th.faux.setResponses([
      capture(
        fauxAssistantMessage(
          [
            fauxToolCall("read", { path: "alpha.txt" }),
            fauxToolCall("write", { path: "beta.txt", content: "beta body" }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      capture(fauxAssistantMessage("Turn one done with alpha and beta.")),
      capture(fauxAssistantMessage("Turn two answer stays in the kept tail with plenty of words.")),
      capture(fauxAssistantMessage("## Goal\nVerify cached compaction works cleanly.")),
    ]);

    const conversation = await th.createConversation();
    await submitAndWait(conversation, "First turn: read alpha.txt and write beta.txt");
    await submitAndWait(conversation, "Second turn: keep this message verbatim in the tail");
    const lastGenCall = calls.at(-1);
    assert.ok(lastGenCall);

    const taskId = await conversation.compact("focus on auth", BACKGROUND_CONTEXT);
    const settled = await th.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    assert.equal(settled.state.outcome.status, "completed");
    assert.ok(settled.state.outcome.result.submissionId !== undefined);
    await conversation.waitForIdle(BACKGROUND_CONTEXT);

    const compactCall = calls.at(-1);
    assert.ok(compactCall);
    assert.equal(calls.length, 4, "no native fallback call should happen");

    // Prefix of compaction request must match the previous generation's messages identically.
    assert.ok(compactCall.messages.length > lastGenCall.messages.length);
    assert.deepEqual(
      compactCall.messages.slice(0, lastGenCall.messages.length),
      lastGenCall.messages,
    );
    assert.equal(compactCall.options?.sessionId, lastGenCall.options?.sessionId);
    assert.notEqual(compactCall.options?.sessionId, undefined);
    assert.notEqual(compactCall.options?.cacheRetention, "none");

    const instruction = compactCall.messages.at(-1);
    assert.equal(instruction?.role, "user");
    const instructionText = contentText(instruction.content);
    assert.ok(instructionText.includes("<kept-start>"));
    assert.ok(instructionText.includes("focus on auth"));

    const summaries = await compactionEntries(conversation);
    assert.equal(summaries.length, 1);
    const summaryText = entryText(summaries[0] as EntryRecord);
    assert.ok(summaryText.includes("## Goal\nVerify cached compaction works cleanly."));
    assert.ok(summaryText.includes("<read-files>\nalpha.txt\n</read-files>"));
    assert.ok(summaryText.includes("<modified-files>\nbeta.txt\n</modified-files>"));

    assert.equal(events.length, 1);
    assert.equal(events[0]?.reason, "manual");
    assert.deepEqual(events[0]?.model, { provider: "faux", modelId: "faux-1" });
    assert.deepEqual(events[0]?.readFiles, ["alpha.txt"]);
    assert.deepEqual(events[0]?.modifiedFiles, ["beta.txt"]);
  } finally {
    await th.cleanup();
  }
});

test("automatic threshold compaction uses cached compaction hook", async () => {
  const events: CachedCompactionEvent[] = [];
  const calls: CapturedCall[] = [];
  const th = await createTestHarness({
    extensions: [
      createCodingToolsExtension(),
      createCachedCompactionExtension({ onCompact: (event) => events.push(event) }),
    ],
    model: { contextWindow: 600, maxTokens: 256 },
    settings: {
      compaction: {
        enabled: true,
        reserveTokens: 350,
        keepRecentTokens: 20,
        backgroundTokens: 0,
      },
    },
  });
  try {
    const capture =
      (response: AssistantMessage) =>
      (context: TranscriptContext, options?: SimpleStreamOptions) => {
        calls.push({ messages: [...context.messages], options });
        return response;
      };

    const bigReply = "Detailed first turn analysis ".repeat(40);
    th.faux.setResponses([
      capture(fauxAssistantMessage(bigReply)),
      // Threshold compaction runs before second generation's model call:
      capture(fauxAssistantMessage("## Goal\nThreshold cached summary.")),
      // Second generation after threshold compaction:
      capture(fauxAssistantMessage("Second turn completed after threshold compaction.")),
    ]);

    const conversation = await th.createConversation();
    await submitAndWait(conversation, "Start work ".repeat(20));
    const gen1 = calls[0];
    assert.ok(gen1);

    await submitAndWait(conversation, "Follow up question triggering threshold compaction.");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.reason, "threshold");
    assert.deepEqual(events[0]?.model, { provider: "faux", modelId: "faux-1" });

    const compactCall = calls[1];
    assert.ok(compactCall);
    assert.deepEqual(compactCall.messages.slice(0, gen1.messages.length), gen1.messages);
    assert.equal(compactCall.options?.sessionId, gen1.options?.sessionId);
    assert.notEqual(compactCall.options?.cacheRetention, "none");

    const summaries = await compactionEntries(conversation);
    assert.equal(summaries.length, 1);
    assert.ok(entryText(summaries[0] as EntryRecord).includes("Threshold cached summary."));
  } finally {
    await th.cleanup();
  }
});

test("toolCall or error responses during cached compaction fall back cleanly to native compaction", async () => {
  for (const badResponse of [
    fauxAssistantMessage([fauxToolCall("read", { path: "nope.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "transient failure" }),
  ]) {
    const events: CachedCompactionEvent[] = [];
    const calls: CapturedCall[] = [];
    const th = await createTestHarness({
      extensions: [
        createCodingToolsExtension(),
        createCachedCompactionExtension({ onCompact: (event) => events.push(event) }),
      ],
      settings: {
        compaction: {
          enabled: true,
          keepRecentTokens: 15,
          reserveTokens: 1000,
          backgroundTokens: 0,
        },
        retry: { enabled: false },
      },
    });
    try {
      const capture =
        (response: AssistantMessage) =>
        (context: TranscriptContext, options?: SimpleStreamOptions) => {
          calls.push({ messages: [...context.messages], options });
          return response;
        };
      th.faux.setResponses([
        capture(fauxAssistantMessage("First turn response with enough words to compact.")),
        capture(fauxAssistantMessage("Second turn stays kept in the tail.")),
        // Cached compaction attempt returns badResponse -> falls back to native:
        capture(badResponse),
        // Native compaction request:
        capture(fauxAssistantMessage("## Goal\nNative fallback summary.")),
      ]);

      const conversation = await th.createConversation();
      await submitAndWait(conversation, "Turn one prompt");
      await submitAndWait(conversation, "Turn two prompt");

      const taskId = await conversation.compact(undefined, BACKGROUND_CONTEXT);
      const settled = await th.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
      assert.equal(settled.state.outcome.status, "completed");
      await conversation.waitForIdle(BACKGROUND_CONTEXT);

      assert.equal(events.length, 0, "onCompact must not fire when falling back to native");
      assert.equal(calls.length, 4);
      const nativeCall = calls[3] as CapturedCall;
      assert.equal(nativeCall.options?.cacheRetention, "none");
      assert.equal(isNativeCompactionMessages(nativeCall.messages), true);

      const summaries = await compactionEntries(conversation);
      assert.equal(summaries.length, 1);
      assert.ok(entryText(summaries[0] as EntryRecord).includes("Native fallback summary."));
    } finally {
      await th.cleanup();
    }
  }
});

test("overflow compaction bypasses cached compaction and uses native compaction immediately", async () => {
  const events: CachedCompactionEvent[] = [];
  const calls: CapturedCall[] = [];
  const th = await createTestHarness({
    extensions: [
      createCodingToolsExtension(),
      createCachedCompactionExtension({ onCompact: (event) => events.push(event) }),
    ],
    settings: {
      compaction: {
        enabled: true,
        keepRecentTokens: 15,
        reserveTokens: 1000,
        backgroundTokens: 0,
      },
      retry: { enabled: false },
    },
  });
  try {
    const capture =
      (response: AssistantMessage) =>
      (context: TranscriptContext, options?: SimpleStreamOptions) => {
        calls.push({ messages: [...context.messages], options });
        return response;
      };
    th.faux.setResponses([
      capture(fauxAssistantMessage("First turn content that will be compacted on overflow.")),
      // Second turn hits provider context overflow:
      capture(
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "prompt is too long: maximum context length exceeded",
        }),
      ),
      // Overflow compaction must go straight to native (no cached compaction attempt):
      capture(fauxAssistantMessage("## Goal\nNative overflow summary.")),
      // Generation retries after overflow compaction and succeeds:
      capture(fauxAssistantMessage("Recovered after overflow.")),
    ]);

    const conversation = await th.createConversation();
    await submitAndWait(conversation, "First turn prompt");
    await submitAndWait(conversation, "Second turn prompt that overflows");

    assert.equal(events.length, 0);
    assert.equal(calls.length, 4);
    const compactionCall = calls[2] as CapturedCall;
    assert.equal(compactionCall.options?.cacheRetention, "none");
    assert.equal(isNativeCompactionMessages(compactionCall.messages), true);

    const summaries = await compactionEntries(conversation);
    assert.equal(summaries.length, 1);
    assert.ok(entryText(summaries[0] as EntryRecord).includes("Native overflow summary."));
  } finally {
    await th.cleanup();
  }
});

test("sequential compactions keep leading system prefix and accumulate file operations", async () => {
  const events: CachedCompactionEvent[] = [];
  const calls: CapturedCall[] = [];
  const th = await createTestHarness({
    extensions: [
      createCodingToolsExtension(),
      createCachedCompactionExtension({ onCompact: (event) => events.push(event) }),
    ],
    settings: {
      compaction: {
        enabled: true,
        keepRecentTokens: 20,
        reserveTokens: 1000,
        backgroundTokens: 0,
      },
    },
  });
  try {
    await writeFile(join(th.dir, "a.txt"), "file a");
    await writeFile(join(th.dir, "c.txt"), "file c");
    const capture =
      (response: AssistantMessage) =>
      (context: TranscriptContext, options?: SimpleStreamOptions) => {
        calls.push({ messages: [...context.messages], options });
        return response;
      };

    th.faux.setResponses([
      // Round 1: read a.txt, write b.txt
      capture(
        fauxAssistantMessage(
          [
            fauxToolCall("read", { path: "a.txt" }),
            fauxToolCall("write", { path: "b.txt", content: "v1" }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      capture(fauxAssistantMessage("Finished round 1 with a.txt and b.txt.")),
      // Round 2: kept tail for compaction #1
      capture(fauxAssistantMessage("Round 2 answer stays in the kept tail for compaction one.")),
      // Compaction #1
      capture(fauxAssistantMessage("## Goal\nCheckpoint one.")),
      // Round 3: read c.txt after compaction #1
      capture(
        fauxAssistantMessage([fauxToolCall("read", { path: "c.txt" })], { stopReason: "toolUse" }),
      ),
      capture(fauxAssistantMessage("Finished round 3 reading c.txt.")),
      // Round 4: kept tail for compaction #2
      capture(fauxAssistantMessage("Round 4 answer stays in the kept tail for compaction two.")),
      // Compaction #2
      capture(fauxAssistantMessage("## Goal\nCheckpoint two.")),
    ]);

    const conversation = await th.createConversation();
    await submitAndWait(conversation, "Round 1");
    await submitAndWait(conversation, "Round 2");
    const c1 = await conversation.compact(undefined, BACKGROUND_CONTEXT);
    await th.harness.waitForTask(c1, BACKGROUND_CONTEXT);
    await conversation.waitForIdle(BACKGROUND_CONTEXT);

    await submitAndWait(conversation, "Round 3");
    await submitAndWait(conversation, "Round 4");
    const lastGenBeforeC2 = calls.at(-1);
    assert.ok(lastGenBeforeC2);

    const c2 = await conversation.compact(undefined, BACKGROUND_CONTEXT);
    await th.harness.waitForTask(c2, BACKGROUND_CONTEXT);
    await conversation.waitForIdle(BACKGROUND_CONTEXT);

    const compact2Call = calls.at(-1);
    assert.ok(compact2Call);
    assert.equal(compact2Call.messages[0]?.role, "system");
    assert.deepEqual(
      compact2Call.messages.slice(0, lastGenBeforeC2.messages.length),
      lastGenBeforeC2.messages,
    );

    assert.equal(events.length, 2);
    assert.deepEqual(events[0]?.readFiles, ["a.txt"]);
    assert.deepEqual(events[0]?.modifiedFiles, ["b.txt"]);
    assert.deepEqual(events[1]?.readFiles, ["a.txt", "c.txt"]);
    assert.deepEqual(events[1]?.modifiedFiles, ["b.txt"]);

    const summaries = await compactionEntries(conversation);
    assert.equal(summaries.length, 2);
    const secondSummary = entryText(summaries[1] as EntryRecord);
    assert.ok(secondSummary.includes("<read-files>\na.txt\nc.txt\n</read-files>"));
    assert.ok(secondSummary.includes("<modified-files>\nb.txt\n</modified-files>"));
  } finally {
    await th.cleanup();
  }
});
