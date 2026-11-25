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
  leafRef,
  MAX_STORED_VIEWS,
  MemoryBucketDoc,
  MemoryMetaDoc,
  MemoryStore,
  MemoryViewsDoc,
  type Summarize,
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

    await storeA.putNode(leafRef(0), "convA-leaf-0", BACKGROUND_CONTEXT, {
      modelKey: "faux/faux-1",
      usage: makeUsage(100, 20),
    });
    await storeA.saveView(10, [leafRef(0)], BACKGROUND_CONTEXT);

    await storeB.putNode(leafRef(0), "convB-leaf-0", BACKGROUND_CONTEXT, {
      modelKey: "faux/faux-1",
      usage: makeUsage(50, 10),
    });

    const reopenedA = await MemoryStore.open(harness, convA.id, BACKGROUND_CONTEXT);
    const reopenedB = await MemoryStore.open(harness, convB.id, BACKGROUND_CONTEXT);

    assert.equal(reopenedA.node(leafRef(0)), "convA-leaf-0");
    assert.equal(reopenedB.node(leafRef(0)), "convB-leaf-0");
    assert.deepEqual(reopenedA.view(10), [leafRef(0)]);
    assert.equal(reopenedB.view(10), undefined);
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
    assert.ok(parentStore.node({ level: 1, index: 0 }));
    await parentStore.saveView(e1, [leafRef(0)], BACKGROUND_CONTEXT);

    const child = await parent.fork(e1, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const childMeta = await harness.snapshot(MemoryMetaDoc, child.id, BACKGROUND_CONTEXT);
    const childViews = await harness.snapshot(MemoryViewsDoc, child.id, BACKGROUND_CONTEXT);
    const childBucket = await harness.snapshot(
      MemoryBucketDoc,
      child.id,
      "0:0",
      BACKGROUND_CONTEXT,
    );
    assert.deepEqual(childMeta?.buckets ?? [], []);
    assert.deepEqual(childViews?.views ?? {}, {});
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
    assert.ok(childStore.node(leafRef(0))?.includes("First message before fork"));
    assert.equal(childStore.node(leafRef(1)), undefined);
    assert.equal(childStore.node({ level: 1, index: 0 }), undefined);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("reopening Storage restores the exact summary tree across 64-slot buckets, views, and usage", async () => {
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
    assert.ok(store.node(leafRef(0)));
    assert.ok(store.node(leafRef(65)));
    assert.ok(store.node({ level: 6, index: 0 }), "64-leaf root 0+64 should be built");
    await store.saveView(50, [{ level: 5, index: 0 }], BACKGROUND_CONTEXT);
  } finally {
    await h1.harness.close(BACKGROUND_CONTEXT);
  }

  const h2 = await openHarness(storage);
  try {
    const conv = await h2.harness.conversation(convId, BACKGROUND_CONTEXT);
    assert.ok(conv);
    const reopened = await MemoryStore.open(h2.harness, conv.id, BACKGROUND_CONTEXT);
    assert.ok(reopened.node(leafRef(0))?.includes("entry-payload-0"));
    assert.ok(reopened.node(leafRef(65))?.includes("entry-payload-65"));
    assert.ok(reopened.node({ level: 6, index: 0 }));
    assert.deepEqual(reopened.view(50), [{ level: 5, index: 0 }]);
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

    // Every bucket write commit must contain the MemoryMetaDoc update in the same publication.
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

    // Dreamer usage stays in MemoryMetaDoc and never pollutes pi.usage.
    const piUsage = await harness.snapshot(UsageDoc, conv.id, BACKGROUND_CONTEXT);
    assert.deepEqual(piUsage?.models ?? {}, {});
  } finally {
    obs.detach();
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("saveView prunes the oldest views beyond MAX_STORED_VIEWS (8)", async () => {
  const storage = new MemoryStorage();
  const { harness } = await openHarness(storage);
  try {
    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    const store = await MemoryStore.open(harness, conv.id, BACKGROUND_CONTEXT);
    for (let i = 1; i <= MAX_STORED_VIEWS + 3; i++) {
      await store.saveView(i * 10, [leafRef(i - 1)], BACKGROUND_CONTEXT);
    }

    const expectedKeys = [40, 50, 60, 70, 80, 90, 100, 110];
    assert.deepEqual(store.viewKeys(), expectedKeys);
    assert.equal(store.view(10), undefined);
    assert.equal(store.view(20), undefined);
    assert.equal(store.view(30), undefined);
    assert.deepEqual(store.view(110), [leafRef(10)]);

    const doc = await harness.snapshot(MemoryViewsDoc, conv.id, BACKGROUND_CONTEXT);
    assert.deepEqual(
      Object.keys(doc?.views ?? {})
        .map(Number)
        .sort((a, b) => a - b),
      expectedKeys,
    );
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
      // Unrelated conversation writes must not wake this Dreamer or create leaves here.
      await writeUserEntry(otherConv, "unrelated conversation text");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(store.leafCount(), 0);

      // Writing a long entry to `conv` triggers observeCommits -> automatic wake + retry backoff.
      await writeUserEntry(conv, `Long important design note ${"detail ".repeat(220)}`);
      await writeUserEntry(conv, "Short follow up");

      await waitUntil(() => store.node({ level: 1, index: 0 }) !== undefined);

      assert.equal(attempts, 3, "failed twice then succeeded on third attempt");
      assert.equal(errors.length, 1, "consecutive failures report only once per run of failures");
      assert.equal(errors[0]?.phase, "summarize");
      assert.ok(store.node(leafRef(0))?.startsWith("summarized("));
      assert.ok(store.node(leafRef(1))?.includes("Short follow up"));
      assert.ok(store.node({ level: 1, index: 0 }));

      // Optional usage counters (reasoning, cacheWrite1h) are preserved.
      const meta = await harness.snapshot(MemoryMetaDoc, conv.id, BACKGROUND_CONTEXT);
      assert.equal(meta?.usage["mock/model"]?.reasoning, 5);
      assert.equal(meta?.usage["mock/model"]?.cacheWrite1h, 2);

      // Dreamer runs outside Harness TaskGraph: zero live tasks created.
      const inspection = await harness.inspect(BACKGROUND_CONTEXT);
      assert.equal(inspection.tasks.length, 0);
    } finally {
      await dreamer.close();
    }
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
