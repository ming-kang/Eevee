import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { WatchCall, WatchEnd, WatchHandle } from "@earendil-works/chord/watch";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { BoardView } from "../api/contract.ts";
import {
  STREAM_PATH,
  STREAM_PROTOCOL,
  type StreamEvent,
  type StreamRequest,
  TOKEN_PROTOCOL_PREFIX,
} from "../api/stream.ts";
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
let board: BoardView = { tickets: [], openQuestions: [], router: emptyRouter };
let watch = fakeWatch(view);
const watched: unknown[] = [];

const boardListeners = new Set<() => void>();
const setBoard = (next: BoardView) => {
  board = next;
  for (const listener of boardListeners) listener();
};

const project: ProjectStream = {
  board: async () => board,
  subscribeBoard: (listener) => {
    boardListeners.add(listener);
    return () => boardListeners.delete(listener);
  },
  watch: async (ticket, _context, window) => {
    watched.push({ ticket, window });
    return watch.handle;
  },
  entries: async (_ticket, query, limit) => [{ id: query.minEntryId ?? 0, limit } as never],
};

let dir: string;
let server: Server;
let stream: { close(): Promise<void> };
let token: string;
let url: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "eevee-stream-"));
  const auth = await Auth.open({
    cliTokenPath: join(dir, "cli-token"),
    sessionsPath: join(dir, "sessions.json"),
  });
  token = (await readFile(join(dir, "cli-token"), "utf8")).trim();
  server = createServer((_request, response) => response.end());
  stream = attachStream(server, {
    source: { bootId: "boot-1", project: (id) => (id === "p1" ? project : undefined) },
    auth,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  url = `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}${STREAM_PATH}`;
});

after(async () => {
  await stream.close();
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
    ws.addEventListener("error", () => reject(new Error("连接被拒绝")), { once: true });
  });
  return {
    ws,
    send: (request: StreamRequest) => ws.send(JSON.stringify(request)),
    next: () =>
      new Promise<StreamEvent>((resolve, reject) => {
        const ready = events.shift();
        if (ready) return resolve(ready);
        const timer = setTimeout(() => reject(new Error("等待事件超时")), 2000);
        waiting.push((event) => {
          clearTimeout(timer);
          resolve(event);
        });
      }),
  };
}

test("没有 token、token 不对或不带协议时拒绝连接", async () => {
  await assert.rejects(connect([STREAM_PROTOCOL]), /拒绝/);
  await assert.rejects(connect([STREAM_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}wrong`]), /拒绝/);
  await assert.rejects(connect([`${TOKEN_PROTOCOL_PREFIX}${token}`]), /拒绝/);
});

test("连上先收到 hello；对话 watch 先发 value 再转发 ops，源结束时发 end", async () => {
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

test("看板 watch 先发当前看板，变化时再发；unwatch 后不再发", async () => {
  board = { tickets: [], openQuestions: [], router: emptyRouter };
  const client = await connect();
  await client.next();
  client.send({ type: "watch", id: "b", topic: { kind: "board", project: "p1" } });
  assert.deepEqual(await client.next(), { type: "board", id: "b", board });

  setBoard({ tickets: [], openQuestions: [{ id: "q1" } as never], router: emptyRouter });
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
  setBoard({ tickets: [], openQuestions: [], router: emptyRouter });
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

test("未知项目和坏消息回 error，连接不断", async () => {
  const client = await connect();
  await client.next();
  client.send({ type: "watch", id: "x", topic: { kind: "board", project: "nope" } });
  const error = await client.next();
  assert.equal(error.type, "error");
  assert.deepEqual(error.type === "error" && error.error, {
    code: "no_project",
    projectId: "nope",
    message: "没有项目 nope",
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
