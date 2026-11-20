import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { WatchCall, WatchEnd, WatchHandle } from "@earendil-works/chord/watch";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BoardFeed, type BoardListener } from "../engine/board-feed.ts";
import type { BoardView } from "../protocol/contract.ts";
import {
  STREAM_PATH,
  STREAM_PROTOCOL,
  type StreamEvent,
  type StreamRequest,
  TOKEN_PROTOCOL_PREFIX,
} from "../protocol/stream.ts";
import { Auth } from "./auth.ts";
import { attachStream, type ProjectStream } from "./stream.ts";

/** A watch whose changes the test pushes. */
function fakeWatch(value: ConversationView) {
  let listener: ((call: WatchCall<ConversationView>) => Promise<void>) | undefined;
  let finish: (end: WatchEnd) => void = () => {};
  const closed = new Promise<WatchEnd>((resolve) => {
    finish = resolve;
  });
  const handle: WatchHandle<ConversationView> = {
    value,
    start: (l) => {
      listener = (call) => l(call, undefined as never);
    },
    stop: async () => {
      finish({ kind: "stopped" });
      return { kind: "stopped" };
    },
    closed,
  };
  return {
    handle,
    push: (ops: unknown[]) =>
      listener?.({ kind: "value", value, ops: ops as never, retired: false }),
    end: () => finish({ kind: "ended" }),
  };
}

const view = { conversation: { id: 1 }, entries: [], docs: {} } as unknown as ConversationView;
const emptyRouter = { running: false };
let board: BoardView = { tickets: [], openProposals: [], openQuestions: [], router: emptyRouter };
let watch = fakeWatch(view);
const watched: unknown[] = [];

const boardListeners = new Set<BoardListener>();
const setBoard = (next: BoardView) => {
  board = next;
  for (const listener of boardListeners) listener.view(board);
};

const project: ProjectStream = {
  watchBoard: (listener) => {
    boardListeners.add(listener);
    listener.view(board);
    return () => boardListeners.delete(listener);
  },
  conversations: {
    watch: async (ticket, _context, window) => {
      watched.push({ ticket, window });
      return watch.handle;
    },
    entries: async (_ticket, query, limit) => [{ id: query.minEntryId ?? 0, limit } as never],
  },
};

/** A real board feed whose builds the test finishes one at a time; each returns the board as it was when it began. */
const boardWith = (question: string): BoardView => ({
  tickets: [],
  openProposals: [],
  openQuestions: [{ id: question } as never],
  router: emptyRouter,
});
let slowState = boardWith("q0");
const slowBuilds: (() => void)[] = [];
const slowFeed = new BoardFeed(() => {
  const seen = slowState;
  return new Promise<BoardView>((resolve) => slowBuilds.push(() => resolve(seen)));
});
const setSlowBoard = (next: BoardView) => {
  slowState = next;
  slowFeed.invalidate();
};
const slowProject: ProjectStream = {
  ...project,
  watchBoard: (listener) => slowFeed.subscribe(listener),
};

let dir: string;
let server: Server;
let stream: { close(): Promise<void> };
let token: string;
let url: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "eevee-stream-"));
  const auth = new Auth();
  token = auth.token;
  server = createServer((_request, response) => response.end());
  stream = attachStream(server, {
    source: {
      bootId: "boot-1",
      projects: {
        get: (id) => (id === "p1" ? project : id === "p2" ? slowProject : undefined),
        watch: (listener) => {
          listener([]);
          return () => {};
        },
      },
    },
    auth,
    version: "test",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  url = `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}${STREAM_PATH}`;
});

after(async () => {
  await stream.close();
  await slowFeed.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

/** A connected client that hands out events in order. */
async function connect(protocols = [STREAM_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`]) {
  const ws = new WebSocket(url, protocols);
  const events: StreamEvent[] = [];
  const waiting: ((event: StreamEvent) => void)[] = [];
  ws.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data)) as StreamEvent;
    const next = waiting.shift();
    if (next) next(event);
    else events.push(event);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("Connection refused")), { once: true });
  });
  return {
    ws,
    send: (request: StreamRequest) => ws.send(JSON.stringify(request)),
    next: () =>
      new Promise<StreamEvent>((resolve, reject) => {
        const ready = events.shift();
        if (ready) return resolve(ready);
        const timer = setTimeout(() => reject(new Error("Timed out waiting for an event")), 2000);
        waiting.push((event) => {
          clearTimeout(timer);
          resolve(event);
        });
      }),
  };
}

test("a connection is refused with no token, a wrong token or no protocol", async () => {
  await assert.rejects(connect([STREAM_PROTOCOL]), /refused/);
  await assert.rejects(connect([STREAM_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}wrong`]), /refused/);
  await assert.rejects(connect(["eevee.v1", `${TOKEN_PROTOCOL_PREFIX}${token}`]), /refused/);
  await assert.rejects(connect([`${TOKEN_PROTOCOL_PREFIX}${token}`]), /refused/);
});

test("on connect the client gets hello; a conversation watch sends value then forwards ops, and sends end when the source ends", async () => {
  watch = fakeWatch(view);
  const client = await connect();
  assert.equal(client.ws.protocol, STREAM_PROTOCOL);
  assert.deepEqual(await client.next(), { type: "hello", bootId: "boot-1" });

  client.send({
    type: "watch",
    id: "w1",
    topic: { kind: "conversation", project: "p1", ticket: "t2" as never },
    window: { from: 7 as never },
  });
  assert.deepEqual(await client.next(), { type: "value", id: "w1", value: view });
  assert.deepEqual(watched.at(-1), { ticket: "t2", window: { from: 7 } });

  await watch.push([["r", { x: 1 }]]);
  assert.deepEqual(await client.next(), { type: "ops", id: "w1", ops: [["r", { x: 1 }]] });
  watch.end();
  assert.deepEqual(await client.next(), { type: "end", id: "w1", reason: "ended" });
  client.ws.close();
});

test("a board watch sends the current board then changes, and stops after unwatch", async () => {
  board = { tickets: [], openProposals: [], openQuestions: [], router: emptyRouter };
  const client = await connect();
  await client.next();
  client.send({ type: "watch", id: "b", topic: { kind: "board", project: "p1" } });
  assert.deepEqual(await client.next(), { type: "board", id: "b", board });

  setBoard({
    tickets: [],
    openProposals: [],
    openQuestions: [{ id: "q1" } as never],
    router: emptyRouter,
  });
  assert.deepEqual(await client.next(), { type: "board", id: "b", board });

  client.send({ type: "unwatch", id: "b" });
  client.send({
    type: "entries",
    id: "e",
    topic: { kind: "conversation", project: "p1" },
    query: { minEntryId: 3 as never },
    limit: 9999,
  });
  assert.deepEqual(await client.next(), {
    type: "entries",
    id: "e",
    items: [{ id: 3, limit: 200 }],
  });
  setBoard({ tickets: [], openProposals: [], openQuestions: [], router: emptyRouter });
  client.send({
    type: "entries",
    id: "e2",
    topic: { kind: "conversation", project: "p1" },
    query: {},
    limit: 1,
  });
  assert.equal((await client.next()).type, "entries");
  client.ws.close();
});

test("a board watch never sends an older board after a newer one, however its builds finish", async () => {
  const client = await connect();
  await client.next();
  client.send({ type: "watch", id: "b", topic: { kind: "board", project: "p2" } });
  while (slowBuilds.length === 0) await sleep(5);
  slowBuilds.shift()?.();
  assert.deepEqual(await client.next(), { type: "board", id: "b", board: boardWith("q0") });

  setSlowBoard(boardWith("q1"));
  while (slowBuilds.length === 0) await sleep(5);
  setSlowBoard(boardWith("q2"));
  // Finish the newest build first each time, as a quick build overtaking a slow one would.
  for (;;) {
    await sleep(30);
    const finish = slowBuilds.pop();
    if (finish === undefined) break;
    finish();
  }

  client.send({
    type: "entries",
    id: "e",
    topic: { kind: "conversation", project: "p1" },
    query: {},
    limit: 1,
  });
  const boards: string[] = [];
  for (;;) {
    const event = await client.next();
    if (event.type === "entries") break;
    if (event.type === "board") boards.push(event.board.openQuestions[0]?.id ?? "");
  }
  assert.equal(boards.at(-1), "q2");
  client.ws.close();
});

test("an unknown project and a bad message reply with error and keep the connection", async () => {
  const client = await connect();
  await client.next();
  client.send({ type: "watch", id: "x", topic: { kind: "board", project: "nope" } });
  const error = await client.next();
  assert.equal(error.type, "error");
  assert.deepEqual(error.type === "error" && error.error, {
    code: "no_project",
    projectId: "nope",
    title: "No project nope",
    status: 404,
  });
  client.ws.send("{");
  assert.equal((await client.next()).type, "error");
  for (const bad of ["[]", "null", '{"type":"entries"}', '{"type":"watch","id":"y"}']) {
    client.ws.send(bad);
    const refused = await client.next();
    assert.equal(refused.type, "error");
    assert.equal(refused.type === "error" && refused.error.code, "invalid");
  }
  client.ws.close();
});
