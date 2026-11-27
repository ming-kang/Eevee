import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  type CommitPublication,
  type Conversation,
  createRegistry,
  type EntryId,
  Harness,
  MemoryStorage,
  UsageDoc,
} from "@earendil-works/pi-durable";
import {
  createSummarizer,
  Dreamer,
  type DreamerErrorInfo,
  ENTRY_PAGE,
  type EntryPager,
  labelOf,
  leafSpan,
  MemoryBucketDoc,
  MemoryMetaDoc,
  MemoryStore,
  PENDING_LINE,
  type Summarize,
  type SummaryTask,
} from "../src/index.ts";

function makeUsage(input: number, output: number, extra?: Partial<Usage>): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: input * 0.001,
      output: output * 0.002,
      cacheRead: 0,
      cacheWrite: 0,
      total: input * 0.001 + output * 0.002,
    },
    ...extra,
  };
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

async function openHarness(storage: MemoryStorage) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    storage,
    { models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  return { harness, models, faux };
}

async function writeUserEntry(conversation: Conversation, text: string): Promise<EntryId> {
  const created = await conversation.commit(
    (tx) =>
      tx.appendEntry(conversation.id, {
        kind: "pi.user",
        model: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
      }),
    BACKGROUND_CONTEXT,
  );
  return created.id;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("memory documents are strictly isolated per conversation in the same Harness", async () => {
  const storage = new MemoryStorage();
  const { harness } = await openHarness(storage);
  try {
    const convA = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    const convB = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );

    const storeA = await MemoryStore.open(harness, convA.id, BACKGROUND_CONTEXT);
    const storeB = await MemoryStore.open(harness, convB.id, BACKGROUND_CONTEXT);

    await storeA.putNode(leafSpan(0), "convA-leaf-0", BACKGROUND_CONTEXT, {
      modelKey: "faux/faux-1",
      usage: makeUsage(100, 20),
    });

    await storeB.putNode(leafSpan(0), "convB-leaf-0", BACKGROUND_CONTEXT, {
      modelKey: "faux/faux-1",
      usage: makeUsage(50, 10),
    });

    const reopenedA = await MemoryStore.open(harness, convA.id, BACKGROUND_CONTEXT);
    const reopenedB = await MemoryStore.open(harness, convB.id, BACKGROUND_CONTEXT);

    assert.equal(reopenedA.node(leafSpan(0)), "convA-leaf-0");
    assert.equal(reopenedB.node(leafSpan(0)), "convB-leaf-0");
    assert.equal(reopenedA.usage()["faux/faux-1"]?.input, 100);
    assert.equal(reopenedB.usage()["faux/faux-1"]?.input, 50);

    const metaB = await harness.snapshot(MemoryMetaDoc, convB.id, BACKGROUND_CONTEXT);
    assert.equal(metaB?.usage["faux/faux-1"]?.input, 50);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("fork uses initial semantics so forked conversations do not inherit unseen parent summaries", async () => {
  const storage = new MemoryStorage();
  const { harness } = await openHarness(storage);
  try {
    const parent = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    const e1 = await writeUserEntry(parent, "First message before fork");
    await writeUserEntry(parent, "Second message after fork");

    const parentStore = await MemoryStore.open(harness, parent.id, BACKGROUND_CONTEXT);
    const parentDreamer = new Dreamer({
      store: parentStore,
      pager: pagerFor(parent),
      summarizer: () => undefined,
      context: BACKGROUND_CONTEXT,
    });
    await parentDreamer.sync();
    await parentDreamer.idle();
    await parentDreamer.close();

    assert.equal(parentStore.leafCount(), 2);
    assert.ok(parentStore.node({ start: 0, size: 2 }));

    const child = await parent.fork(e1, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const childMeta = await harness.snapshot(MemoryMetaDoc, child.id, BACKGROUND_CONTEXT);
    const childBucket = await harness.snapshot(
      MemoryBucketDoc,
      child.id,
      "1:0",
      BACKGROUND_CONTEXT,
    );
    assert.deepEqual(childMeta?.buckets ?? [], []);
    assert.equal(childBucket, undefined);

    const childStore = await MemoryStore.open(harness, child.id, BACKGROUND_CONTEXT);
    const childDreamer = new Dreamer({
      store: childStore,
      pager: pagerFor(child),
      summarizer: () => undefined,
      context: BACKGROUND_CONTEXT,
    });
    await childDreamer.sync();
    await childDreamer.idle();
    await childDreamer.close();

    assert.equal(childStore.leafCount(), 1);
    assert.ok(childStore.node(leafSpan(0))?.includes("First message before fork"));
    assert.equal(childStore.node(leafSpan(1)), undefined);
    assert.equal(childStore.node({ start: 0, size: 2 }), undefined);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("reopening Storage restores the exact summary forest across 64-slot buckets and usage", async () => {
  const storage = new MemoryStorage();
  storage.close = () => Promise.resolve();
  const h1 = await openHarness(storage);
  let convId: Conversation["id"];
  try {
    const conv = await h1.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    convId = conv.id;
    for (let i = 0; i < 66; i++) {
      await writeUserEntry(conv, `entry-payload-${i}`);
    }
    const store = await MemoryStore.open(h1.harness, conv.id, BACKGROUND_CONTEXT);
    const dreamer = new Dreamer({
      store,
      pager: pagerFor(conv),
      summarizer: () => async (task) => ({
        text: `sum(${task.input.length}): ${task.input[0]?.slice(0, 24) ?? ""}`,
        modelKey: "test/dreamer-1",
        usage: makeUsage(10, 5),
      }),
      context: BACKGROUND_CONTEXT,
    });
    await dreamer.sync();
    await dreamer.idle();
    await dreamer.close();

    assert.equal(store.leafCount(), 66);
    assert.ok(store.node(leafSpan(0)));
    assert.ok(store.node(leafSpan(65)));
    assert.ok(store.node({ start: 0, size: 64 }), "64-leaf root 0+64 should be built");
  } finally {
    await h1.harness.close(BACKGROUND_CONTEXT);
  }

  const h2 = await openHarness(storage);
  try {
    const conv = await h2.harness.conversation(convId, BACKGROUND_CONTEXT);
    assert.ok(conv);
    const reopened = await MemoryStore.open(h2.harness, conv.id, BACKGROUND_CONTEXT);
    assert.ok(reopened.node(leafSpan(0))?.includes("entry-payload-0"));
    assert.ok(reopened.node(leafSpan(65))?.includes("entry-payload-65"));
    assert.ok(reopened.node({ start: 0, size: 64 }));
    assert.ok((reopened.usage()["test/dreamer-1"]?.totalTokens ?? 0) > 0);

    // Re-ingesting leaves rebuilds search index without rebuilding persisted tree nodes.
    let summarizeCalls = 0;
    const dreamer = new Dreamer({
      store: reopened,
      pager: pagerFor(conv),
      summarizer: () => async () => {
        summarizeCalls++;
        return { text: "unexpected" };
      },
      context: BACKGROUND_CONTEXT,
    });
    await dreamer.sync();
    await dreamer.idle();
    await dreamer.close();

    assert.equal(summarizeCalls, 0, "all persisted nodes should be reused after reopen");
    assert.equal(reopened.leafCount(), 66);
    const hits = reopened.search("entry-payload-65", 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.index, 65);
  } finally {
    await h2.harness.close(BACKGROUND_CONTEXT);
  }
});

test("node write and Dreamer usage accumulate atomically in the same commit without touching pi.usage", async () => {
  const storage = new MemoryStorage();
  const { harness, models, faux } = await openHarness(storage);
  const publications: CommitPublication[] = [];
  const obs = harness.observeCommits({
    advance: (pub) => publications.push(pub),
    end: () => {},
  });
  try {
    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    const longA = `alpha detail ${"word ".repeat(220)}`;
    const longB = `beta detail ${"word ".repeat(220)}`;
    await writeUserEntry(conv, longA);
    await writeUserEntry(conv, longB);

    faux.setResponses([
      fauxAssistantMessage(
        "Summary for leaf zero with enough tokens to prevent free merge. ".repeat(14),
      ),
      fauxAssistantMessage(
        "Summary for leaf one with enough tokens to prevent free merge. ".repeat(14),
      ),
      fauxAssistantMessage("Merged summary for leaves zero and one."),
    ]);

    const summarizer = createSummarizer(models, {
      provider: faux.provider.id,
      modelId: "faux-1",
    });
    assert.ok(summarizer);

    const store = await MemoryStore.open(harness, conv.id, BACKGROUND_CONTEXT);
    const dreamer = new Dreamer({
      store,
      pager: pagerFor(conv),
      summarizer: () => summarizer,
      concurrency: 1,
      context: BACKGROUND_CONTEXT,
    });
    await dreamer.sync();
    await dreamer.idle();
    await dreamer.close();

    const bucketCommits = publications.filter((pub) =>
      pub.changes.some(
        (change) =>
          change.type === "document" &&
          change.kind === "change" &&
          change.record.kind === MemoryBucketDoc.definition.kind,
      ),
    );
    assert.equal(bucketCommits.length, 3);
    for (const pub of bucketCommits) {
      const hasMeta = pub.changes.some(
        (change) =>
          change.type === "document" &&
          change.kind === "change" &&
          change.record.kind === MemoryMetaDoc.definition.kind,
      );
      assert.equal(
        hasMeta,
        true,
        "MemoryMetaDoc usage must commit atomically with MemoryBucketDoc",
      );
    }

    const modelKey = `${faux.provider.id}/faux-1`;
    const meta = await harness.snapshot(MemoryMetaDoc, conv.id, BACKGROUND_CONTEXT);
    assert.ok(meta?.usage[modelKey]);
    assert.ok((meta.usage[modelKey]?.totalTokens ?? 0) > 0);
    assert.deepEqual(store.usage(), meta.usage);

    const piUsage = await harness.snapshot(UsageDoc, conv.id, BACKGROUND_CONTEXT);
    assert.deepEqual(piUsage?.models ?? {}, {});
  } finally {
    obs.detach();
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("Dreamer prioritizes pending merges by mergeDue so urgent ancestors build first", async () => {
  const storage = new MemoryStorage();
  const { harness } = await openHarness(storage);
  try {
    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    for (let i = 0; i < 20; i++) {
      await writeUserEntry(conv, `turn-${i}`);
    }
    const store = await MemoryStore.open(harness, conv.id, BACKGROUND_CONTEXT);
    const pad = "summary detail padding ".repeat(20);
    // Pre-seed leaves 0..19 and size-2 merges 0+2..10+2 so pending merges span different sizes:
    // 0+4 (due=8.5), 12+2 (due=7.0), 4+4 (due=6.5), 14+2 (due=5.0), 8+4 (due=4.5), 16+2 (due=3.0), 18+2 (due=1.0).
    for (let i = 0; i < 20; i++) {
      await store.putNode(leafSpan(i), `L${i} ${pad}`, BACKGROUND_CONTEXT);
    }
    for (let start = 0; start < 12; start += 2) {
      await store.putNode({ start, size: 2 }, `M[${start}+2] ${pad}`, BACKGROUND_CONTEXT);
    }

    const mergeOrder: string[] = [];
    const dreamer = new Dreamer({
      store,
      pager: pagerFor(conv),
      concurrency: 1,
      summarizer: () => async (task) => {
        const leftTag = task.input[0]?.split(" ")[0] ?? "";
        const rightTag = task.input[1]?.split(" ")[0] ?? "";
        const merged = `(${leftTag}+${rightTag})`;
        mergeOrder.push(merged);
        return { text: `${merged} ${pad}` };
      },
      context: BACKGROUND_CONTEXT,
    });
    await dreamer.sync();
    await dreamer.idle();
    await dreamer.close();

    // Expected order strictly follows mergeDue(parent, 20):
    // 0+4 (8.5) -> 12+2 (7.0) -> 4+4 (6.5) -> 14+2 (5.0) -> 8+4 (4.5) -> 0+8 (3.25) -> 16+2 (3.0) -> ...
    assert.deepEqual(mergeOrder.slice(0, 7), [
      "(M[0+2]+M[2+2])",
      "(L12+L13)",
      "(M[4+2]+M[6+2])",
      "(L14+L15)",
      "(M[8+2]+M[10+2])",
      "((M[0+2]+M[2+2])+(M[4+2]+M[6+2]))",
      "(L16+L17)",
    ]);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("Dreamer supplies the two immediately preceding leaves as clean <context> even across power-of-two boundaries", async () => {
  const storage = new MemoryStorage();
  const { harness } = await openHarness(storage);
  try {
    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    await writeUserEntry(conv, "leaf-0 short");
    await writeUserEntry(conv, "leaf-1 short");
    await writeUserEntry(conv, "leaf-2 specific detail");
    await writeUserEntry(conv, `leaf-3 unbuilt long preview ${"alpha ".repeat(220)}`);
    await writeUserEntry(conv, `leaf-4 target at power-of-two boundary ${"beta ".repeat(220)}`);

    const store = await MemoryStore.open(harness, conv.id, BACKGROUND_CONTEXT);
    // Pre-build 0+1, 1+1, 2+1, and 0+4, leaving leaf 3 unbuilt to exercise clean preview fallback.
    await store.putNode(leafSpan(0), "built-0", BACKGROUND_CONTEXT);
    await store.putNode(leafSpan(1), "built-1", BACKGROUND_CONTEXT);
    await store.putNode(leafSpan(2), "built-2", BACKGROUND_CONTEXT);
    await store.putNode({ start: 0, size: 4 }, "coarse-0-to-3", BACKGROUND_CONTEXT);

    const capturedTasks: SummaryTask[] = [];
    const dreamer = new Dreamer({
      store,
      pager: pagerFor(conv),
      concurrency: 1,
      summarizer: () => async (task) => {
        capturedTasks.push(task);
        return { text: `summary-${capturedTasks.length}` };
      },
      context: BACKGROUND_CONTEXT,
    });
    await dreamer.sync();
    await dreamer.idle();
    await dreamer.close();

    const leaf3Task = capturedTasks.find((t) =>
      t.input[0]?.includes("leaf-3 unbuilt long preview"),
    );
    const leaf4Task = capturedTasks.find((t) =>
      t.input[0]?.includes("leaf-4 target at power-of-two boundary"),
    );
    assert.ok(leaf3Task);
    assert.ok(leaf4Task);
    // Leaf 3 receives leaves 1 and 2 (built summaries).
    assert.deepEqual(leaf3Task.context, ["built-1", "built-2"]);
    // Leaf 4 (at boundary 4) receives leaves 2 and 3, NOT coarse 0+4.
    assert.equal(leaf4Task.context.length, 2);
    assert.equal(leaf4Task.context[0], "built-2");
    assert.equal(leaf4Task.context[1]?.includes("coarse-0-to-3"), false);
    assert.equal(
      leaf4Task.context.some((line) => line.includes(PENDING_LINE)),
      false,
      "summarizer context must never include agent-facing PENDING_LINE hints",
    );
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("Dreamer uses clean leafPreview (without PENDING_LINE) when an immediately preceding leaf is still unbuilt", async () => {
  const storage = new MemoryStorage();
  const { harness } = await openHarness(storage);
  try {
    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    await writeUserEntry(conv, `leaf-0 still pending ${"foo ".repeat(220)}`);
    await writeUserEntry(conv, `leaf-1 runs concurrently ${"bar ".repeat(220)}`);

    const store = await MemoryStore.open(harness, conv.id, BACKGROUND_CONTEXT);
    const capturedTasks: SummaryTask[] = [];
    const dreamer = new Dreamer({
      store,
      pager: pagerFor(conv),
      concurrency: 2,
      summarizer: () => async (task) => {
        capturedTasks.push(task);
        return { text: "ok" };
      },
      context: BACKGROUND_CONTEXT,
    });
    await dreamer.sync();
    await dreamer.idle();
    await dreamer.close();

    const leaf1Task = capturedTasks.find((t) => t.input[0]?.includes("leaf-1 runs concurrently"));
    assert.ok(leaf1Task);
    assert.equal(leaf1Task.context.length, 1);
    assert.ok(leaf1Task.context[0]?.startsWith("user: leaf-0 still pending"));
    assert.equal(leaf1Task.context[0]?.includes(PENDING_LINE), false);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("Dreamer observes commits silently, skips TaskGraph, and retries summarization with backoff", async () => {
  const storage = new MemoryStorage();
  const { harness } = await openHarness(storage);
  const errors: DreamerErrorInfo[] = [];
  let attempts = 0;
  const summarize: Summarize = async (task) => {
    attempts++;
    if (attempts <= 2) {
      throw new Error(`transient failure #${attempts}`);
    }
    return {
      text: `summarized(${task.input[0]?.slice(0, 20) ?? ""})`,
      modelKey: "mock/model",
      usage: makeUsage(40, 10, { reasoning: 5, cacheWrite1h: 2 }),
    };
  };

  try {
    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    const otherConv = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );

    const store = await MemoryStore.open(harness, conv.id, BACKGROUND_CONTEXT);
    const dreamer = new Dreamer({
      store,
      pager: pagerFor(conv),
      summarizer: () => summarize,
      harness,
      context: BACKGROUND_CONTEXT,
      retryBaseMs: 15,
      retryMaxMs: 60,
      onError: (_err, info) => errors.push(info),
    });

    try {
      await writeUserEntry(otherConv, "unrelated conversation text");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(store.leafCount(), 0);

      await writeUserEntry(conv, `Long important design note ${"detail ".repeat(220)}`);
      await writeUserEntry(conv, "Short follow up");

      await waitUntil(() => store.node({ start: 0, size: 2 }) !== undefined);

      assert.equal(attempts, 3, "failed twice then succeeded on third attempt");
      assert.equal(errors.length, 1, "consecutive failures report only once per run of failures");
      assert.equal(errors[0]?.phase, "summarize");
      assert.equal(errors[0]?.span ? labelOf(errors[0].span) : undefined, "0+1");
      assert.ok(store.node(leafSpan(0))?.startsWith("summarized("));
      assert.ok(store.node(leafSpan(1))?.includes("Short follow up"));
      assert.ok(store.node({ start: 0, size: 2 }));

      const meta = await harness.snapshot(MemoryMetaDoc, conv.id, BACKGROUND_CONTEXT);
      assert.equal(meta?.usage["mock/model"]?.reasoning, 5);
      assert.equal(meta?.usage["mock/model"]?.cacheWrite1h, 2);

      const inspection = await harness.inspect(BACKGROUND_CONTEXT);
      assert.equal(inspection.tasks.length, 0);
    } finally {
      await dreamer.close();
    }
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
