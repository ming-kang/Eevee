import assert from "node:assert/strict";
import { test } from "node:test";
import type { Op } from "@earendil-works/chord/delta";
import type {
  ConversationView as DurableView,
  EntryId,
  EntryRecord,
} from "@earendil-works/pi-durable";
import type { StreamEvent } from "../../../src/api/stream.ts";
import { type ConversationSnapshot, createConversationWatcher } from "./conversation.ts";
import { createStreamClient, type SocketLike } from "./stream.ts";

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  readonly #listeners = new Map<string, Set<(arg?: unknown) => void>>();

  addEventListener: SocketLike["addEventListener"] = (type, listener) => {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener as (arg?: unknown) => void);
    this.#listeners.set(type, set);
  };

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
    this.#emit("close", { code: 1000 });
  }

  open(): void {
    this.readyState = 1;
    this.#emit("open");
  }

  receive(event: StreamEvent): void {
    this.#emit("message", { data: JSON.stringify(event) });
  }

  drop(): void {
    this.readyState = 3;
    this.#emit("close", { code: 1006 });
  }

  #emit(type: string, arg?: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(arg);
  }
}

const entry = (id: number, text: string): EntryRecord => ({
  id: id as EntryId,
  conversationId: 1 as never,
  kind: "pi.user",
  model: [{ role: "user", content: text, timestamp: id * 1000 }],
});

const viewOf = (entries: EntryRecord[], before?: number, running = false): DurableView => ({
  conversation: { id: 1 as never },
  entries,
  ...(before === undefined ? {} : { before: before as EntryId }),
  docs: running ? { "pi.live": { run: { taskId: 1, inputs: [], turns: 0 } } } : {},
});

test("applies value/ops, resumes the stream and fills gaps and earlier pages with entries; a new bootId resets", async () => {
  const sockets: FakeSocket[] = [];
  const scheduled: (() => void)[] = [];
  let latest: ConversationSnapshot | undefined;

  const stream = createStreamClient({
    baseUrl: "http://127.0.0.1:19190",
    token: "tok",
    baseDelayMs: 10,
    jitter: 0,
    timers: {
      setTimeout: (fn) => {
        scheduled.push(fn);
        return scheduled.length;
      },
      clearTimeout: () => {},
    },
    createSocket: () => {
      const ws = new FakeSocket();
      sockets.push(ws);
      return ws;
    },
  });

  const watcher = createConversationWatcher({
    stream,
    watchId: "c1",
    topic: { kind: "conversation", project: "p1" },
    pageSize: 2,
    onChange: (snap) => {
      latest = snap;
    },
  });

  sockets[0]?.open();
  sockets[0]?.receive({ type: "hello", bootId: "b1" });

  // Initial window: entries 3, 4, with 1, 2 still before them
  sockets[0]?.receive({
    type: "value",
    id: "c1",
    value: viewOf([entry(3, "three"), entry(4, "four")], 2),
  });
  assert.deepEqual(
    latest?.view?.items.map((i) => (i.kind === "entry" ? i.entry.id : i.kind)),
    ["earlier", 3, 4],
  );

  // The ops increment appends entry 5 and sets the live state to running
  const ops: Op[] = [
    ["p", ["entries"], 2, 0, [entry(5, "five") as never]],
    ["s", ["docs", "pi.live"], { run: { taskId: 1, inputs: [], turns: 0 } }],
  ];
  sockets[0]?.receive({ type: "ops", id: "c1", ops });
  assert.deepEqual(
    latest?.view?.items.map((i) => (i.kind === "entry" ? i.entry.id : i.kind)),
    ["earlier", 3, 4, 5],
  );
  assert.ok((latest?.view?.docs["pi.live"] as { run?: unknown } | undefined)?.run);

  // Drop and reconnect with the same bootId; the resume window is { from: 6 }
  sockets[0]?.drop();
  scheduled.shift()?.();
  sockets[1]?.open();
  sockets[1]?.receive({ type: "hello", bootId: "b1" });
  assert.deepEqual(sockets[1]?.sent[0], {
    type: "watch",
    id: "c1",
    topic: { kind: "conversation", project: "p1" },
    window: { from: 6 },
  });

  // While offline 6, 7, 8 arrive; the server window truncates to just 8 (before=7) -> triggers an automatic entries gap fill
  sockets[1]?.receive({
    type: "value",
    id: "c1",
    value: viewOf([entry(8, "eight")], 7),
  });
  await Promise.resolve();
  const gapReq = sockets[1]?.sent.find((m) => m.type === "entries") as
    | { id: string; query: { minEntryId: number; maxEntryId: number } }
    | undefined;
  assert.ok(gapReq);
  assert.deepEqual(gapReq.query, { minEntryId: 6, maxEntryId: 7, order: "ascending" });
  sockets[1]?.receive({
    type: "entries",
    id: gapReq.id,
    items: [entry(6, "six"), entry(7, "seven")],
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    latest?.view?.items.map((i) => (i.kind === "entry" ? i.entry.id : i.kind)),
    ["earlier", 3, 4, 5, 6, 7, 8],
  );

  // Paging forward loads the earlier entries 1, 2
  const earlierPromise = watcher.loadEarlier();
  await Promise.resolve();
  const earlierReq = sockets[1]?.sent.at(-1) as {
    id: string;
    type: string;
    limit: number;
    query: { maxEntryId: number; order: string };
  };
  assert.equal(earlierReq.type, "entries");
  assert.equal(earlierReq.limit, 3);
  assert.deepEqual(earlierReq.query, { maxEntryId: 2, order: "descending" });
  // Two entries come back (< limit=3), so the start of the conversation is reached
  sockets[1]?.receive({
    type: "entries",
    id: earlierReq.id,
    items: [entry(2, "two"), entry(1, "one")],
  });
  await earlierPromise;
  assert.deepEqual(
    latest?.view?.items.map((i) => (i.kind === "entry" ? i.entry.id : i.kind)),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );

  // When the bootId becomes b2 the old state is dropped and it resubscribes
  sockets[1]?.drop();
  scheduled.shift()?.();
  sockets[2]?.open();
  sockets[2]?.receive({ type: "hello", bootId: "b2" });
  assert.equal(latest?.view, undefined);
  assert.deepEqual(sockets[2]?.sent[0], {
    type: "watch",
    id: "c1",
    topic: { kind: "conversation", project: "p1" },
  });

  watcher.stop();
  stream.close();
});
