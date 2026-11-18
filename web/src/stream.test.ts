import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryId } from "@earendil-works/pi-durable";
import { STREAM_PROTOCOL, type StreamEvent, TOKEN_PROTOCOL_PREFIX } from "../../src/api/stream.ts";
import { createStreamClient, type SocketLike, streamUrl, type WatchEvent } from "./stream.ts";

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly url: string;
  readonly protocols: string[];
  readonly sent: unknown[] = [];
  closed = false;
  readonly #listeners = new Map<string, Set<(arg?: unknown) => void>>();

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  addEventListener: SocketLike["addEventListener"] = (type, listener) => {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener as (arg?: unknown) => void);
    this.#listeners.set(type, set);
  };

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
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
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(arg);
    }
  }
}

function fakeTimers() {
  let nextId = 1;
  const scheduled: { id: number; ms: number; fn: () => void }[] = [];
  return {
    scheduled,
    timers: {
      setTimeout(fn: () => void, ms: number) {
        const id = nextId++;
        scheduled.push({ id, ms, fn });
        return id;
      },
      clearTimeout(id: unknown) {
        const index = scheduled.findIndex((item) => item.id === id);
        if (index >= 0) scheduled.splice(index, 1);
      },
    },
    flushNext(): number | undefined {
      const next = scheduled.shift();
      if (!next) return undefined;
      next.fn();
      return next.ms;
    },
  };
}

test("streamUrl turns http/https into ws/wss and appends /api/stream", () => {
  assert.equal(streamUrl("http://127.0.0.1:19190"), "ws://127.0.0.1:19190/api/stream");
  assert.equal(streamUrl("https://localhost:8443/ui/"), "wss://localhost:8443/api/stream");
});

test("subprotocol auth, hello replays the subscriptions, events are dispatched by id", () => {
  const sockets: FakeSocket[] = [];
  const client = createStreamClient({
    baseUrl: "http://127.0.0.1:19190",
    token: "tok-secret",
    createSocket: (url, protocols) => {
      const ws = new FakeSocket(url, protocols);
      sockets.push(ws);
      return ws;
    },
  });

  const ws = sockets[0];
  assert.ok(ws);
  assert.equal(ws.url, "ws://127.0.0.1:19190/api/stream");
  assert.deepEqual(ws.protocols, [STREAM_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}tok-secret`]);
  assert.equal(client.state, "connecting");

  const boardEvents: WatchEvent[] = [];
  const convEvents: WatchEvent[] = [];
  const stopBoard = client.watch("b1", {
    topic: { kind: "board", project: "p1" },
    onEvent: (event) => boardEvents.push(event),
  });
  // no watch is sent before hello
  assert.deepEqual(ws.sent, []);

  ws.open();
  ws.receive({ type: "hello", bootId: "boot-1" });
  assert.equal(client.state, "connected");
  assert.equal(client.bootId, "boot-1");
  assert.deepEqual(ws.sent, [{ type: "watch", id: "b1", topic: { kind: "board", project: "p1" } }]);

  client.watch("c1", {
    topic: { kind: "conversation", project: "p1" },
    onEvent: (event) => convEvents.push(event),
  });
  assert.deepEqual(ws.sent[1], {
    type: "watch",
    id: "c1",
    topic: { kind: "conversation", project: "p1" },
  });

  ws.receive({
    type: "board",
    id: "b1",
    board: { tickets: [], openQuestions: [], router: { running: false } },
  });
  ws.receive({
    type: "value",
    id: "c1",
    value: { conversation: { id: 1 as never }, entries: [], docs: {} },
  });
  assert.equal(boardEvents.length, 1);
  assert.equal(boardEvents[0]?.type, "board");
  assert.equal(convEvents.length, 1);
  assert.equal(convEvents[0]?.type, "value");

  stopBoard();
  assert.deepEqual(ws.sent[2], { type: "unwatch", id: "b1" });
  client.close();
});

test("a drop reconnects with exponential backoff: the same bootId resumes, a new one resets first", async () => {
  const sockets: FakeSocket[] = [];
  const clock = fakeTimers();
  let cursor: EntryId | undefined = 42 as EntryId;
  let resets = 0;
  const hellos: { bootId: string; bootChanged: boolean }[] = [];

  const client = createStreamClient({
    baseUrl: "http://127.0.0.1:19190",
    token: "tok",
    baseDelayMs: 100,
    maxDelayMs: 500,
    jitter: 0,
    timers: clock.timers,
    createSocket: (url, protocols) => {
      const ws = new FakeSocket(url, protocols);
      sockets.push(ws);
      return ws;
    },
  });

  client.onHello((info) => hellos.push(info));
  client.watch("c1", {
    topic: { kind: "conversation", project: "p1" },
    window: () => (cursor === undefined ? undefined : { from: cursor }),
    onReset: () => {
      resets += 1;
      cursor = undefined;
    },
    onEvent: () => {},
  });

  sockets[0]?.open();
  sockets[0]?.receive({ type: "hello", bootId: "boot-1" });
  assert.deepEqual(sockets[0]?.sent[0], {
    type: "watch",
    id: "c1",
    topic: { kind: "conversation", project: "p1" },
    window: { from: 42 },
  });

  // first drop: wait 100ms, then reconnect; bootId unchanged
  sockets[0]?.drop();
  assert.equal(client.state, "reconnecting");
  assert.equal(clock.flushNext(), 100);
  assert.equal(sockets.length, 2);

  // dropping again before it connects doubles the backoff to 200ms
  sockets[1]?.drop();
  assert.equal(clock.flushNext(), 200);
  assert.equal(sockets.length, 3);

  sockets[2]?.open();
  sockets[2]?.receive({ type: "hello", bootId: "boot-1" });
  assert.equal(resets, 0);
  assert.deepEqual(sockets[2]?.sent[0], {
    type: "watch",
    id: "c1",
    topic: { kind: "conversation", project: "p1" },
    window: { from: 42 },
  });

  // dropping once more, the Engine restarts (bootId becomes boot-2): backoff resets to 100ms, reset first, then resubscribe without a window
  sockets[2]?.drop();
  assert.equal(clock.flushNext(), 100);
  sockets[3]?.open();
  sockets[3]?.receive({ type: "hello", bootId: "boot-2" });
  assert.equal(resets, 1);
  assert.deepEqual(sockets[3]?.sent[0], {
    type: "watch",
    id: "c1",
    topic: { kind: "conversation", project: "p1" },
  });
  assert.deepEqual(hellos, [
    { bootId: "boot-1", bootChanged: false },
    { bootId: "boot-1", bootChanged: false },
    { bootId: "boot-2", bootChanged: true },
  ]);

  // entries requests are dispatched by id, and a drop refuses them
  const pendingOk = client.entries(
    { kind: "conversation", project: "p1" },
    { order: "descending" },
    10,
  );
  const req = sockets[3]?.sent[1] as { id: string; type: string };
  assert.equal(req.type, "entries");
  sockets[3]?.receive({ type: "entries", id: req.id, items: [{ id: 1 } as never] });
  assert.deepEqual(await pendingOk, [{ id: 1 }]);

  const pendingDrop = client.entries({ kind: "conversation", project: "p1" }, {}, 10);
  sockets[3]?.drop();
  await assert.rejects(pendingDrop, /disconnected/);
  client.close();
});
