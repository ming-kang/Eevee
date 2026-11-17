import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { BACKGROUND_CONTEXT, type Context, withCancel } from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord/watch";
import type {
  ConversationView,
  ConversationWindow,
  EntryQuery,
  EntryRecord,
} from "@earendil-works/pi-durable";
import { type WebSocket, WebSocketServer } from "ws";
import type { BoardView } from "../api/contract.ts";
import {
  type ConversationTopic,
  STREAM_PATH,
  STREAM_PROTOCOL,
  type StreamEvent,
  type StreamRequest,
  TOKEN_PROTOCOL_PREFIX,
} from "../api/stream.ts";
import type { TicketId } from "../contracts/index.ts";
import { type Auth, isLoopbackRequest } from "./auth.ts";

/** What the stream reads: the Engine, or a stand-in in tests. */
export type StreamSource = {
  readonly bootId: string;
  project(id: string): ProjectStream | undefined;
};

export type ProjectStream = {
  watch(
    ticket: TicketId | undefined,
    context: Context,
    window?: ConversationWindow,
  ): Promise<WatchHandle<ConversationView>>;
  entries(
    ticket: TicketId | undefined,
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
  ): Promise<EntryRecord[]>;
  board(): Promise<BoardView>;
};

export type StreamOptions = {
  source: StreamSource;
  auth: Auth;
  /** How often a board watch looks for changes. */
  boardPollMs?: number;
};

const BOARD_POLL_MS = 500;
const PING_MS = 30_000;
const MAX_ENTRIES = 200;
/** A watch waits for the socket to drain past this many buffered bytes; Durable folds changes meanwhile. */
const HIGH_WATER = 1 << 20;
const MAX_MESSAGE = 64 * 1024;

/** Serves the realtime stream on `server`'s upgrades to `/api/stream`. */
export function attachStream(server: Server, options: StreamOptions): { close(): Promise<void> } {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE,
    handleProtocols: (protocols) => (protocols.has(STREAM_PROTOCOL) ? STREAM_PROTOCOL : false),
  });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const refusal = refuse(request, options.auth);
    if (refusal !== undefined) {
      socket.end(`HTTP/1.1 ${refusal}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => serve(ws, options));
  };
  server.on("upgrade", onUpgrade);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.off("upgrade", onUpgrade);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}

/** Why an upgrade is refused, as a status line; undefined to accept it. */
function refuse(request: IncomingMessage, auth: Auth): string | undefined {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== STREAM_PATH) return "404 Not Found";
  if (!isLoopbackRequest(request)) return "403 Forbidden";
  const protocols = (request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim());
  if (!protocols.includes(STREAM_PROTOCOL)) return "400 Bad Request";
  const token = protocols
    .find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX))
    ?.slice(TOKEN_PROTOCOL_PREFIX.length);
  return auth.verify(token) === undefined ? "401 Unauthorized" : undefined;
}

function serve(ws: WebSocket, options: StreamOptions): void {
  const { source } = options;
  const watches = new Map<string, () => void>();
  const send = (event: StreamEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  const fail = (id: string | undefined, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && error.name === "NotFound" ? "not_found" : "error";
    send({ type: "error", ...(id === undefined ? {} : { id }), code, message });
  };
  const project = (id: string): ProjectStream => {
    const found = source.project(id);
    if (found === undefined) throw Object.assign(new Error(`没有项目 ${id}`), { name: "NotFound" });
    return found;
  };

  let alive = true;
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, PING_MS);
  ping.unref();
  ws.on("pong", () => {
    alive = true;
  });
  ws.on("close", () => {
    clearInterval(ping);
    for (const stop of watches.values()) stop();
    watches.clear();
  });

  ws.on("message", (data) => {
    let request: StreamRequest;
    try {
      request = JSON.parse(String(data)) as StreamRequest;
    } catch {
      return fail(undefined, new Error("消息不是合法的 JSON"));
    }
    void handle(request).catch((error: unknown) => fail(request.id, error));
  });

  async function handle(request: StreamRequest): Promise<void> {
    switch (request.type) {
      case "unwatch":
        watches.get(request.id)?.();
        watches.delete(request.id);
        return;
      case "entries": {
        const limit = Math.min(Math.max(1, Math.trunc(request.limit)), MAX_ENTRIES);
        const host = project(request.topic.project);
        const items = await host.entries(request.topic.ticket, request.query, limit);
        return send({ type: "entries", id: request.id, items });
      }
      case "watch":
        if (watches.has(request.id)) throw new Error(`watch ${request.id} 已存在`);
        if (request.topic.kind === "board")
          return watchBoard(request.id, project(request.topic.project));
        return watchConversation(
          request.id,
          request.topic,
          "window" in request ? request.window : undefined,
        );
    }
  }

  async function watchConversation(
    id: string,
    topic: ConversationTopic,
    window: ConversationWindow | undefined,
  ): Promise<void> {
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
    const abandon = () => cancel();
    watches.set(id, abandon);
    let handle: WatchHandle<ConversationView>;
    try {
      handle = await project(topic.project).watch(topic.ticket, context, window);
    } catch (error) {
      if (watches.get(id) !== abandon) return;
      watches.delete(id);
      throw error;
    }
    if (watches.get(id) !== abandon) {
      await handle.stop();
      return;
    }
    const stop = () => void handle.stop();
    watches.set(id, stop);
    send({ type: "value", id, value: handle.value });
    handle.start(async (call) => {
      if (call.kind === "failed") return fail(id, call.error);
      await drained(ws);
      send({ type: "ops", id, ops: call.ops });
    });
    const end = await handle.closed;
    // Unwatched, or the socket closed: nobody is waiting for the end.
    if (watches.get(id) !== stop) return;
    watches.delete(id);
    send({ type: "end", id, reason: end.kind });
  }

  async function watchBoard(id: string, host: ProjectStream): Promise<void> {
    let last = "";
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    watches.set(id, () => {
      stopped = true;
      clearTimeout(timer);
    });
    const poll = async () => {
      try {
        const board = await host.board();
        const serialized = JSON.stringify(board);
        if (serialized !== last && !stopped) {
          last = serialized;
          send({ type: "board", id, board });
        }
      } catch (error) {
        fail(id, error);
      }
      if (!stopped) timer = setTimeout(() => void poll(), options.boardPollMs ?? BOARD_POLL_MS);
    };
    await poll();
  }

  send({ type: "hello", bootId: source.bootId });
}

async function drained(ws: WebSocket): Promise<void> {
  while (ws.readyState === ws.OPEN && ws.bufferedAmount > HIGH_WATER) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
