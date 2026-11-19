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
import {
  type ConversationTopic,
  parseStreamRequest,
  STREAM_PATH,
  STREAM_PROTOCOL,
  type StreamEvent,
  type StreamRequest,
  TOKEN_PROTOCOL_PREFIX,
} from "../api/stream.ts";
import type { TicketId } from "../contracts/index.ts";
import { ProblemError, problemOf } from "../contracts/index.ts";
import type { BoardListener } from "../engine/board-feed.ts";
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
  /** Feeds `listener` the current board and each change, in order, until the returned function is called. */
  watchBoard(listener: BoardListener): () => void;
};

export type StreamOptions = {
  source: StreamSource;
  auth: Auth;
};

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
    wss.handleUpgrade(request, socket, head, (ws) => {
      try {
        serve(ws, options);
      } catch (error) {
        console.error("The live stream failed.", error);
        ws.terminate();
      }
    });
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
  return auth.verify(token) ? undefined : "401 Unauthorized";
}

function serve(ws: WebSocket, options: StreamOptions): void {
  const { source } = options;
  const watches = new Map<string, () => void>();
  const send = (event: StreamEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  const fail = (id: string | undefined, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    send({
      type: "error",
      ...(id === undefined ? {} : { id }),
      error: { ...problemOf(error), message },
    });
  };
  const project = (id: string): ProjectStream => {
    const found = source.project(id);
    if (found === undefined) throw new ProblemError({ code: "no_project", projectId: id });
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
    let value: unknown;
    try {
      value = JSON.parse(String(data));
    } catch {
      return fail(undefined, new ProblemError({ code: "bad_json" }));
    }
    try {
      const request = parseStreamRequest(value);
      void handle(request).catch((error: unknown) => fail(request.id, error));
    } catch (error) {
      fail(idOf(value), error);
    }
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
        if (watches.has(request.id)) throw new ProblemError({ code: "invalid", field: "id" });
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
      await handle.stop().catch(() => undefined);
      return;
    }
    const stop = () => {
      handle.stop().catch((error: unknown) => fail(id, error));
    };
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

  function watchBoard(id: string, host: ProjectStream): void {
    const stop = host.watchBoard({
      view: (board) => send({ type: "board", id, board }),
      failed: (error) => fail(id, error),
    });
    watches.set(id, stop);
  }

  send({ type: "hello", bootId: source.bootId });
}

async function drained(ws: WebSocket): Promise<void> {
  while (ws.readyState === ws.OPEN && ws.bufferedAmount > HIGH_WATER) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The `id` of a decoded message, if it carries one; never trusts the rest of an unvalidated value. */
function idOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : undefined;
}
