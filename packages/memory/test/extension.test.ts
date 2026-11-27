import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  contentText,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type SimpleStreamOptions,
  type SystemMessage,
  type ToolResultMessage,
  type TranscriptContext,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  type CommitPublication,
  CompactionEntry,
  type Conversation,
  type ConversationId,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryRecord,
  Harness,
  type HarnessSettings,
  MemoryStorage,
  type NestedToolExecutionResult,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import {
  createMemoryExtension,
  Dreamer,
  ENTRY_PAGE,
  type EntryPager,
  MEMORY_EXTENSION,
  type MemoryBinding,
  MemoryBucketDoc,
  MemoryMetaDoc,
  MemoryStore,
  type RecallBudget,
  type Summarize,
} from "../src/index.ts";

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
    500,
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

function memoryLines(summary: string): string[] {
  const match = /(?:^|\n)<memory>\n([\s\S]*?)\n<\/memory>(?:\n|$)/.exec(summary);
  assert.ok(match, `Expected <memory> block in summary:\n${summary}`);
  return (match[1] ?? "").split("\n").filter(Boolean);
}

function isNativeCompaction(messages: readonly Message[]): boolean {
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

function pagerFor(conversation: Conversation): EntryPager {
  return (minEntryId, cursor, ctx) =>
    conversation.entries(
      { ...(minEntryId === undefined ? {} : { minEntryId }), order: "ascending" },
      ENTRY_PAGE,
      cursor,
      ctx,
    );
}

const deterministicSummarizer: Summarize = async (task) => ({
  text:
    task.input.length === 2
      ? `merged(${task.input[0]?.slice(0, 32) ?? ""} | ${task.input[1]?.slice(0, 32) ?? ""})`
      : `sum(${task.input[0]?.slice(0, 48) ?? ""})`,
});

async function createMemoryHarness(options: {
  bindings: Map<ConversationId, MemoryBinding>;
  settings?: HarnessSettings;
  extraExtensions?: readonly ReturnType<typeof defineExtension>[];
}) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const memoryExt = createMemoryExtension({
    resolve: (id) => options.bindings.get(id),
  });
  assert.equal(memoryExt.name, MEMORY_EXTENSION);
  registry.install(memoryExt);
  for (const ext of options.extraExtensions ?? []) {
    registry.install(ext);
  }
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      ...(options.settings === undefined ? {} : { settings: options.settings }),
    },
    BACKGROUND_CONTEXT,
  );
  return { harness, faux, memoryExt };
}

test("compaction replaces old turns with a <memory> forest view and supports zoom(id, n?) drill-down and search", async () => {
  const bindings = new Map<ConversationId, MemoryBinding>();
  const nestedResults: NestedToolExecutionResult[] = [];
  const probeExt = defineExtension({
    name: "test.probe",
    tools: [
      defineTool({
        name: "probe_memory",
        description: "Invoke memory tools as nested calls to inspect structuredOutput.",
        parameters: obj({ query: str() }),
        async execute(args, api, context) {
          nestedResults.push(await api.executeTool("zoom", { id: 0, n: 4 }, context));
          nestedResults.push(await api.executeTool("zoom", { id: 0 }, context));
          nestedResults.push(
            await api.executeTool("search", { query: args.query, limit: 1 }, context),
          );
          return { output: [{ type: "text", text: "probe done" }] };
        },
      }),
    ],
  });

  const calls: CapturedCall[] = [];
  const capture =
    (response: AssistantMessage) => (context: TranscriptContext, options?: SimpleStreamOptions) => {
      calls.push({ messages: [...context.messages], options });
      return response;
    };

  const { harness, faux, memoryExt } = await createMemoryHarness({
    bindings,
    extraExtensions: [probeExt],
    settings: {
      compaction: {
        enabled: true,
        keepRecentTokens: 20,
        reserveTokens: 1000,
        backgroundTokens: 0,
      },
    },
  });

  let dreamer: Dreamer | undefined;
  try {
    const conv = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: faux.provider.id, modelId: "faux-1" },
          extensions: [memoryExt, probeExt],
        },
      },
      BACKGROUND_CONTEXT,
    );
    const store = await MemoryStore.open(harness, conv.id, BACKGROUND_CONTEXT);
    dreamer = new Dreamer({
      store,
      pager: pagerFor(conv),
      summarizer: () => deterministicSummarizer,
      harness,
      context: BACKGROUND_CONTEXT,
    });
    const budget: RecallBudget = {
      compaction: null,
      view: { min: 45, max: 65 },
    };
    bindings.set(conv.id, {
      store,
      budget: () => budget,
      sync: (ctx) => dreamer?.sync(ctx) ?? Promise.resolve(),
    });

    faux.setResponses([
      capture(fauxAssistantMessage("Alpha secret token is ORION-42 in module alpha.")),
      capture(fauxAssistantMessage("Beta uses ORION-42 too for verification.")),
      capture(fauxAssistantMessage("Gamma discusses caching strategy in detail.")),
      capture(fauxAssistantMessage("Delta stays in the recent kept tail verbatim.")),
    ]);

    await submitAndWait(conv, "Turn 0: establish ORION-42 for alpha pipeline.");
    await submitAndWait(conv, "Turn 1: reuse ORION-42 in beta pipeline.");
    await submitAndWait(conv, "Turn 2: discuss gamma caching details.");
    await submitAndWait(conv, "Turn 3: recent question kept verbatim.");

    await dreamer.sync();
    await dreamer.idle();
    assert.ok(store.node({ start: 0, size: 4 }), "4-leaf node 0+4 must be built");

    const compactTask = await conv.compact(undefined, BACKGROUND_CONTEXT);
    const settled = await harness.waitForTask(compactTask, BACKGROUND_CONTEXT);
    assert.equal(settled.state.outcome.status, "completed");
    await conv.waitForIdle(BACKGROUND_CONTEXT);

    const summaries = await compactionEntries(conv);
    assert.equal(summaries.length, 1);
    const summaryText = entryText(summaries[0] as EntryRecord);
    const lines = memoryLines(summaryText);
    assert.ok(lines.length > 0);
    assert.ok(lines[0]?.startsWith("0+4|"), `Expected folded 0+4 line, got: ${lines.join("\n")}`);

    const leafCountBeforeLookups = store.leafCount();

    faux.setResponses([
      capture(
        fauxAssistantMessage(
          [
            fauxToolCall("zoom", { id: 0, n: 4 }),
            fauxToolCall("zoom", { id: 0, n: 2 }),
            fauxToolCall("zoom", { id: 0 }),
            fauxToolCall("zoom", { id: 1, n: 2 }),
            fauxToolCall("search", { query: "orion-42 alpha", limit: 1 }),
            fauxToolCall("search", { query: "ORION-42", limit: 2 }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      capture(
        fauxAssistantMessage(
          [
            fauxToolCall("search", { query: "ORION-42", before: 2, limit: 2 }),
            fauxToolCall("probe_memory", { query: "ORION-42" }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      capture(fauxAssistantMessage("Found ORION-42 in the earliest turn.")),
    ]);

    await submitAndWait(conv, "Look up ORION-42 from memory.");
    await dreamer.sync();
    await dreamer.idle();

    const postCompactCall = calls[4];
    assert.ok(postCompactCall);
    const sysMessage = postCompactCall.messages[0] as SystemMessage;
    assert.equal(sysMessage.role, "system");
    assert.ok(sysMessage.sections?.memory?.includes("zoom(id, n)"));
    assert.ok(sysMessage.sections?.memory?.includes("zoom(id)"));
    assert.ok(
      postCompactCall.messages.some(
        (m) => m.role === "user" && contentText(m.content).includes("<memory>"),
      ),
    );
    assert.equal(
      postCompactCall.messages.some(
        (m) =>
          m.role === "user" &&
          contentText(m.content) === "Turn 0: establish ORION-42 for alpha pipeline.",
      ),
      false,
    );

    const afterToolsCall = calls[5];
    assert.ok(afterToolsCall);
    const toolResults = afterToolsCall.messages.filter(
      (message): message is ToolResultMessage => message.role === "toolResult",
    );
    const resultTexts = toolResults.map((r) => ({
      name: r.toolName,
      isError: r.isError,
      text: contentText(r.content),
    }));

    assert.equal(resultTexts[0]?.isError, false);
    assert.ok(resultTexts[0]?.text.includes("0+2|"));
    assert.ok(resultTexts[0]?.text.includes("2+2|"));

    assert.equal(resultTexts[1]?.isError, false);
    assert.ok(resultTexts[1]?.text.includes("0+1|"));
    assert.ok(resultTexts[1]?.text.includes("1+1|"));

    assert.equal(resultTexts[2]?.isError, false);
    assert.ok(resultTexts[2]?.text.includes("Turn 0: establish ORION-42 for alpha pipeline."));

    assert.equal(resultTexts[3]?.isError, true, "unaligned zoom(1, 2) must be an error");

    assert.equal(resultTexts[4]?.isError, false);
    assert.ok(resultTexts[4]?.text.includes("ORION-42"));

    assert.equal(resultTexts[5]?.isError, false);
    assert.ok(
      resultTexts[5]?.text.includes("Older hits may remain: search again with before="),
      `Expected pagination hint in:\n${resultTexts[5]?.text}`,
    );

    assert.equal(nestedResults.length, 3);
    const [branchProbe, leafProbe, searchProbe] = nestedResults;
    assert.ok(branchProbe && leafProbe && searchProbe);

    assert.equal(branchProbe.isError, false);
    const branchStructured = branchProbe.structuredOutput as {
      kind: string;
      id: number;
      n: number;
      children: unknown[];
    };
    assert.equal(branchStructured.kind, "branch");
    assert.equal(branchStructured.children.length, 2);

    assert.equal(leafProbe.isError, false);
    const leafStructured = leafProbe.structuredOutput as {
      kind: string;
      id: number;
      n: number;
      text: string;
    };
    assert.equal(leafStructured.kind, "leaf");
    assert.equal(leafStructured.id, 0);
    assert.equal(leafStructured.n, 1);
    assert.equal(leafStructured.text, "Turn 0: establish ORION-42 for alpha pipeline.");

    assert.equal(searchProbe.isError, false);
    const searchStructured = searchProbe.structuredOutput as {
      query: string;
      hits: { id: number }[];
      nextBefore?: number;
    };
    assert.equal(searchStructured.query, "ORION-42");
    assert.equal(searchStructured.hits.length, 1);
    assert.equal(typeof searchStructured.nextBefore, "number");

    const addedLeaves = [];
    for (let i = leafCountBeforeLookups; i < store.leafCount(); i++) {
      addedLeaves.push(store.leaf(i));
    }
    assert.equal(
      addedLeaves.some(
        (leaf) =>
          leaf?.kind === "tool" && (leaf.text.startsWith("zoom") || leaf.text.startsWith("search")),
      ),
      false,
    );
  } finally {
    await dreamer?.close();
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("sequential compactions reuse previous <memory> prefix from CompactionEntry without writing extra memory docs", async () => {
  const bindings = new Map<ConversationId, MemoryBinding>();
  const { harness, faux, memoryExt } = await createMemoryHarness({
    bindings,
    settings: {
      compaction: {
        enabled: true,
        keepRecentTokens: 15,
        reserveTokens: 1000,
        backgroundTokens: 0,
      },
    },
  });

  const compactionPublications: CommitPublication[] = [];
  let recording = false;
  const obs = harness.observeCommits({
    advance: (pub) => {
      if (recording) compactionPublications.push(pub);
    },
    end: () => {},
  });

  let dreamer: Dreamer | undefined;
  try {
    const conv = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: faux.provider.id, modelId: "faux-1" },
          extensions: [memoryExt],
        },
      },
      BACKGROUND_CONTEXT,
    );
    const store = await MemoryStore.open(harness, conv.id, BACKGROUND_CONTEXT);
    dreamer = new Dreamer({
      store,
      pager: pagerFor(conv),
      summarizer: () => deterministicSummarizer,
      harness,
      context: BACKGROUND_CONTEXT,
    });
    const budget: RecallBudget = {
      compaction: null,
      view: { min: 220, max: 270 },
    };
    bindings.set(conv.id, {
      store,
      budget: () => budget,
      sync: (ctx) => dreamer?.sync(ctx) ?? Promise.resolve(),
      opening: async () => "Current opening context for router.",
    });

    const pad = "context detail token padding ".repeat(5);
    const responses = Array.from({ length: 10 }, (_, i) =>
      fauxAssistantMessage(`Assistant reply ${i}: ${pad}`),
    );
    faux.setResponses(responses);

    for (let i = 0; i < 7; i++) {
      await submitAndWait(conv, `User turn ${i}: ${pad}`);
    }
    await dreamer.sync();
    await dreamer.idle();

    recording = true;
    const c1 = await conv.compact(undefined, BACKGROUND_CONTEXT);
    await harness.waitForTask(c1, BACKGROUND_CONTEXT);
    await conv.waitForIdle(BACKGROUND_CONTEXT);
    recording = false;

    const memoryDocWrites = compactionPublications.flatMap((pub) =>
      pub.changes.filter(
        (change) =>
          change.type === "document" &&
          change.kind === "change" &&
          (change.record.kind === MemoryMetaDoc.definition.kind ||
            change.record.kind === MemoryBucketDoc.definition.kind ||
            change.record.kind.startsWith("eevee.memory")),
      ),
    );
    assert.equal(memoryDocWrites.length, 0, "beforeCompact must not write any memory documents");

    for (let i = 7; i < 10; i++) {
      await submitAndWait(conv, `User turn ${i}: ${pad}`);
    }
    await dreamer.sync();
    await dreamer.idle();

    const c2 = await conv.compact(undefined, BACKGROUND_CONTEXT);
    await harness.waitForTask(c2, BACKGROUND_CONTEXT);
    await conv.waitForIdle(BACKGROUND_CONTEXT);

    const summaries = await compactionEntries(conv);
    assert.equal(summaries.length, 2);
    const text1 = entryText(summaries[0] as EntryRecord);
    const text2 = entryText(summaries[1] as EntryRecord);
    assert.ok(text1.includes("Current opening context for router."));
    assert.ok(text2.includes("Current opening context for router."));

    const lines1 = memoryLines(text1);
    const lines2 = memoryLines(text2);

    assert.ok(lines1.length >= 2, `Expected multiple lines in view 1, got:\n${lines1.join("\n")}`);
    assert.ok(lines2.length >= 2, `Expected multiple lines in view 2, got:\n${lines2.join("\n")}`);
    assert.notDeepEqual(lines2, lines1, "Second compaction should cover additional turns");
    assert.deepEqual(
      lines2.slice(0, 2),
      lines1.slice(0, 2),
      `Expected prefix lines to stay verbatim.\nView 1:\n${lines1.join("\n")}\nView 2:\n${lines2.join("\n")}`,
    );
  } finally {
    obs.detach();
    await dreamer?.close();
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("unattached conversations hide memory prompt, fail memory tools, and fall back to native compaction", async () => {
  const bindings = new Map<ConversationId, MemoryBinding>();
  const calls: CapturedCall[] = [];
  const capture =
    (response: AssistantMessage) => (context: TranscriptContext, options?: SimpleStreamOptions) => {
      calls.push({ messages: [...context.messages], options });
      return response;
    };

  const { harness, faux, memoryExt } = await createMemoryHarness({
    bindings,
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
    const unattached = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: faux.provider.id, modelId: "faux-1" },
          extensions: [memoryExt],
        },
      },
      BACKGROUND_CONTEXT,
    );

    faux.setResponses([
      capture(
        fauxAssistantMessage(
          [fauxToolCall("zoom", { id: 0, n: 1 }), fauxToolCall("search", { query: "anything" })],
          { stopReason: "toolUse" },
        ),
      ),
      capture(fauxAssistantMessage("Acknowledged memory is unavailable.")),
      capture(fauxAssistantMessage("Second turn response kept verbatim.")),
      capture(fauxAssistantMessage("## Goal\nNative compaction summary.")),
    ]);

    await submitAndWait(unattached, "Try calling memory tools without a binding.");
    await submitAndWait(unattached, "Second turn before compaction.");

    const firstSys = calls[0]?.messages[0] as SystemMessage;
    assert.equal(firstSys.sections?.memory, undefined);

    const results = (calls[1]?.messages ?? []).filter(
      (message): message is ToolResultMessage => message.role === "toolResult",
    );
    assert.equal(results.length, 2);
    assert.equal(results[0]?.isError, true);
    assert.equal(results[1]?.isError, true);

    const taskId = await unattached.compact(undefined, BACKGROUND_CONTEXT);
    await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    await unattached.waitForIdle(BACKGROUND_CONTEXT);

    const nativeCall = calls.at(-1);
    assert.ok(nativeCall);
    assert.equal(nativeCall.options?.cacheRetention, "none");
    assert.equal(isNativeCompaction(nativeCall.messages), true);

    const summaries = await compactionEntries(unattached);
    assert.equal(summaries.length, 1);
    assert.ok(entryText(summaries[0] as EntryRecord).includes("Native compaction summary."));
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("memory compaction falls back to native compaction when forest view exceeds twice view.max", async () => {
  const bindings = new Map<ConversationId, MemoryBinding>();
  const calls: CapturedCall[] = [];
  const capture =
    (response: AssistantMessage) => (context: TranscriptContext, options?: SimpleStreamOptions) => {
      calls.push({ messages: [...context.messages], options });
      return response;
    };

  const { harness, faux, memoryExt } = await createMemoryHarness({
    bindings,
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
    const conv = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: faux.provider.id, modelId: "faux-1" },
          extensions: [memoryExt],
        },
      },
      BACKGROUND_CONTEXT,
    );
    const store = await MemoryStore.open(harness, conv.id, BACKGROUND_CONTEXT);
    bindings.set(conv.id, {
      store,
      budget: () => ({ compaction: null, view: { min: 2, max: 4 } }),
    });

    faux.setResponses([
      capture(fauxAssistantMessage("Long response overflowing tiny view budget ".repeat(15))),
      capture(fauxAssistantMessage("Second turn response kept verbatim.")),
      capture(fauxAssistantMessage("## Goal\nNative fallback on oversized view.")),
    ]);

    await submitAndWait(conv, "First long prompt ".repeat(15));
    await submitAndWait(conv, "Second prompt kept verbatim.");

    const taskId = await conv.compact(undefined, BACKGROUND_CONTEXT);
    await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    await conv.waitForIdle(BACKGROUND_CONTEXT);

    const nativeCall = calls.at(-1);
    assert.ok(nativeCall);
    assert.equal(isNativeCompaction(nativeCall.messages), true);

    const summaries = await compactionEntries(conv);
    assert.equal(summaries.length, 1);
    assert.ok(
      entryText(summaries[0] as EntryRecord).includes("Native fallback on oversized view."),
    );
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
