import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationWatch, ConversationWindow } from "@earendil-works/pi-durable";
import type { BoardView } from "@eevee/core";
import type { ConversationRef, McpOAuthEvent, WorkerId } from "@eevee/protocol";
import {
  type Engine,
  EngineError,
  type LoginSseFrame,
  type PoolBoardEvent,
  type WorkerTaskStream,
} from "./engine.ts";
import type { StreamWorkerTaskQuery } from "./http-io.ts";

const SSE_KEEPALIVE_MS = 20_000;

export type SseStreamDeps = {
  readonly engine: Engine;
  readonly isClosing: () => boolean;
  readonly trackCloser: (closer: () => Promise<void>) => () => void;
};

export type SseStreamHandlers = {
  readonly handleAllBoardsStream: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readonly handleBoardStream: (
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
  ) => Promise<void>;
  readonly handleConversationStream: (
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    ref: ConversationRef,
    window: ConversationWindow | undefined,
  ) => Promise<void>;
  readonly handleTaskStream: (
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    workerId: WorkerId,
    taskId: string,
    query: StreamWorkerTaskQuery,
  ) => Promise<void>;
  readonly handleLoginStream: (
    req: IncomingMessage,
    res: ServerResponse,
    providerId: string,
    sessionId: string,
  ) => void;
  readonly handleMcpOAuthStream: (
    req: IncomingMessage,
    res: ServerResponse,
    serverName: string,
    sessionId: string,
    projectId?: string,
  ) => void;
};

type SseFrame = {
  readonly event: string;
  readonly data: unknown;
  readonly id?: string | number;
  readonly terminal?: boolean;
};

type SseOpenOptions = {
  readonly onServerClose?: () => SseFrame | undefined;
  readonly onCleanup?: () => Promise<void> | void;
};

function writeSseEvent(
  res: ServerResponse,
  event: string,
  data: unknown,
  id?: string | number,
): void {
  if (res.writableEnded || res.destroyed) return;
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${String(id)}`);
  lines.push(`event: ${event}`);
  const payload = JSON.stringify(data);
  for (const line of payload.split("\n")) {
    lines.push(`data: ${line}`);
  }
  res.write(`${lines.join("\n")}\n\n`);
}

function writeSseComment(res: ServerResponse, comment: string): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`: ${comment}\n\n`);
}

function openSseHeaders(res: ServerResponse): ReturnType<typeof setInterval> {
  res.setTimeout(0);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const keepalive = setInterval(() => {
    writeSseComment(res, "keepalive");
  }, SSE_KEEPALIVE_MS);
  keepalive.unref?.();
  return keepalive;
}

class SseStream {
  readonly #req: IncomingMessage;
  readonly #res: ServerResponse;
  readonly #isClosing: () => boolean;
  readonly #trackCloser: SseStreamDeps["trackCloser"];
  readonly #buffered: SseFrame[] = [];
  #opened = false;
  #ready = false;
  #ended = false;
  #keepalive: ReturnType<typeof setInterval> | undefined;
  #untrackCloser: () => void = () => {};
  #onServerClose: (() => SseFrame | undefined) | undefined;
  #onCleanup: (() => Promise<void> | void) | undefined;

  constructor(
    req: IncomingMessage,
    res: ServerResponse,
    deps: Pick<SseStreamDeps, "isClosing" | "trackCloser">,
  ) {
    this.#req = req;
    this.#res = res;
    this.#isClosing = deps.isClosing;
    this.#trackCloser = deps.trackCloser;
  }

  get opened(): boolean {
    return this.#opened;
  }

  get ended(): boolean {
    return this.#ended;
  }

  open(options: SseOpenOptions = {}): boolean {
    if (this.#ended || this.#isClosing() || this.#res.destroyed || this.#req.socket.destroyed) {
      this.#buffered.length = 0;
      return false;
    }
    this.#opened = true;
    this.#onServerClose = options.onServerClose;
    this.#onCleanup = options.onCleanup;
    this.#keepalive = openSseHeaders(this.#res);
    this.#untrackCloser = this.#trackCloser(async () => {
      const frame = this.#ended ? undefined : this.#onServerClose?.();
      await this.finish(frame);
    });
    this.#res.on("close", () => {
      void this.finish();
    });
    return true;
  }

  flush(): void {
    if (!this.#opened || this.#ended) return;
    this.#ready = true;
    for (const frame of this.#buffered) {
      if (this.#ended) break;
      this.#emit(frame);
    }
    this.#buffered.length = 0;
  }

  send(event: string, data: unknown, id?: string | number, terminal = false): void {
    if (this.#ended) return;
    const frame: SseFrame = {
      event,
      data,
      ...(id === undefined ? {} : { id }),
      ...(terminal ? { terminal: true } : {}),
    };
    if (!this.#ready) {
      this.#buffered.push(frame);
      return;
    }
    this.#emit(frame);
  }

  async finish(terminalFrame?: SseFrame): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    this.#untrackCloser();
    if (this.#keepalive !== undefined) {
      clearInterval(this.#keepalive);
      this.#keepalive = undefined;
    }
    this.#buffered.length = 0;
    if (terminalFrame !== undefined) {
      writeSseEvent(this.#res, terminalFrame.event, terminalFrame.data, terminalFrame.id);
    }
    if (!this.#res.writableEnded && !this.#res.destroyed) {
      this.#res.end();
    }
    await this.#onCleanup?.();
  }

  #emit(frame: SseFrame): void {
    writeSseEvent(this.#res, frame.event, frame.data, frame.id);
    if (frame.terminal) {
      void this.finish();
    }
  }
}

const MCP_OAUTH_SHUTDOWN_FRAME: SseFrame = {
  event: "error",
  data: { type: "error", code: "engine_closed", message: "Engine is closing" },
};

function toMcpOAuthSseFrame(event: McpOAuthEvent): SseFrame {
  return {
    event: event.type,
    data: event,
    terminal: event.type === "complete" || event.type === "error",
  };
}

function conversationEndFrame(
  watchEnd: Awaited<ConversationWatch["closed"]>,
  closing: boolean,
): SseFrame {
  if (closing) return { event: "end", data: { reason: "closed" } };
  switch (watchEnd.kind) {
    case "ended":
      return { event: "end", data: { reason: "ended" } };
    case "aborted":
    case "stopped":
      return { event: "end", data: { reason: "aborted" } };
    case "failed":
    case "listener_error": {
      const message =
        watchEnd.error instanceof Error ? watchEnd.error.message : String(watchEnd.error);
      return {
        event: "end",
        data: { reason: "failed", ...(message ? { message } : {}) },
      };
    }
  }
}

export function createSseStreamHandlers(deps: SseStreamDeps): SseStreamHandlers {
  const { engine, isClosing } = deps;

  function streamBufferedSession<TEvent>(
    req: IncomingMessage,
    res: ServerResponse,
    subscribe: (onEvent: (event: TEvent) => void) => () => void,
    toFrame: (event: TEvent) => SseFrame,
    shutdownFrame: SseFrame,
  ): void {
    const stream = new SseStream(req, res, deps);
    const unsubscribe = subscribe((event) => {
      const frame = toFrame(event);
      stream.send(frame.event, frame.data, frame.id, frame.terminal);
    });
    if (
      !stream.open({
        onServerClose: () => shutdownFrame,
        onCleanup: unsubscribe,
      })
    ) {
      unsubscribe();
      return;
    }
    stream.flush();
  }

  function handleLoginStream(
    req: IncomingMessage,
    res: ServerResponse,
    providerId: string,
    sessionId: string,
  ): void {
    streamBufferedSession<LoginSseFrame>(
      req,
      res,
      (onFrame) => engine.providers.subscribeLogin(providerId, sessionId, onFrame),
      (frame) => ({
        event: frame.event,
        data: frame.data,
        terminal: frame.event === "complete" || frame.event === "error",
      }),
      { event: "error", data: { code: "engine_closed", message: "Engine is closing" } },
    );
  }

  async function handleAllBoardsStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const stream = new SseStream(req, res, deps);
    const pending: PoolBoardEvent[] = [];
    let snapshotReady = false;
    const sentSignatures = new Map<string, string>();
    let unsubscribe = () => {};

    const emitEvent = (event: PoolBoardEvent) => {
      if (stream.ended) return;
      if (event.type === "board") {
        const signature = JSON.stringify(event.board);
        if (sentSignatures.get(event.projectId) === signature) return;
        sentSignatures.set(event.projectId, signature);
        stream.send("board", { projectId: event.projectId, board: event.board });
      } else {
        if (!sentSignatures.has(event.projectId)) return;
        sentSignatures.delete(event.projectId);
        stream.send("removed", { projectId: event.projectId });
      }
    };

    try {
      unsubscribe = engine.subscribeBoardEvents((event) => {
        if (stream.ended) return;
        if (!snapshotReady) {
          pending.push(event);
          return;
        }
        emitEvent(event);
      });

      const boards: Record<string, BoardView> = {};
      for (const projectId of engine.store.listProjectIds()) {
        if (isClosing() || res.destroyed || req.socket.destroyed) {
          unsubscribe();
          return;
        }
        const cached = !engine.isProjectOpen(projectId)
          ? engine.getCachedBoard(projectId)
          : undefined;
        if (cached !== undefined) {
          boards[projectId] = cached;
          continue;
        }
        try {
          const handle = await engine.openProject(projectId);
          const board = await handle.board(BACKGROUND_CONTEXT);
          engine.cacheBoard(projectId, board);
          boards[projectId] = board;
        } catch (error) {
          if (error instanceof EngineError && error.status === 404) {
            continue;
          }
          throw error;
        }
      }

      if (
        !stream.open({
          onServerClose: () => ({ event: "end", data: { reason: "closed" } }),
          onCleanup: () => {
            unsubscribe();
          },
        })
      ) {
        unsubscribe();
        return;
      }

      for (const [projectId, board] of Object.entries(boards)) {
        sentSignatures.set(projectId, JSON.stringify(board));
      }
      stream.flush();
      stream.send("snapshot", { boards });
      snapshotReady = true;
      for (const event of pending) {
        emitEvent(event);
      }
      pending.length = 0;
    } catch (error) {
      if (stream.opened) await stream.finish();
      else unsubscribe();
      throw error;
    }
  }

  async function handleBoardStream(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
  ): Promise<void> {
    const releaseStream = engine.acquireStream(projectId);
    let unsubscribe = () => {};
    const stream = new SseStream(req, res, deps);
    try {
      const handle = await engine.openProject(projectId);
      const initial = await handle.board(BACKGROUND_CONTEXT);
      if (
        !stream.open({
          onServerClose: () => ({ event: "end", data: { reason: "closed" } }),
          onCleanup: () => {
            unsubscribe();
            releaseStream();
          },
        })
      ) {
        releaseStream();
        return;
      }

      let lastSignature = JSON.stringify(initial);
      stream.flush();
      stream.send("board", initial);

      if (!stream.ended) {
        unsubscribe = handle.subscribeBoard((board) => {
          if (stream.ended) return;
          const signature = JSON.stringify(board);
          if (signature === lastSignature) return;
          lastSignature = signature;
          stream.send("board", board);
        });
      }
    } catch (error) {
      if (stream.opened) await stream.finish();
      else releaseStream();
      throw error;
    }
  }

  async function handleConversationStream(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    ref: ConversationRef,
    window: ConversationWindow | undefined,
  ): Promise<void> {
    const releaseStream = engine.acquireStream(projectId);
    const stream = new SseStream(req, res, deps);
    let watchClosed = false;
    const watchAbort = new AbortController();
    let watch: Awaited<ReturnType<Engine["projects"]["watchConversation"]>> | undefined;
    try {
      const watchContext = withAbortSignal(watchAbort.signal, BACKGROUND_CONTEXT);
      watch = await engine.projects.watchConversation(projectId, ref, watchContext, window);

      if (
        !stream.open({
          onServerClose: () => ({ event: "end", data: { reason: "closed" } }),
          onCleanup: async () => {
            releaseStream();
            if (!watchClosed && watch !== undefined) {
              watchAbort.abort();
              await watch.stop().catch(() => undefined);
            }
          },
        })
      ) {
        watchAbort.abort();
        await watch.stop().catch(() => undefined);
        releaseStream();
        return;
      }

      stream.flush();
      const initialId = watch.value.entries.at(-1)?.id ?? watch.value.before;
      stream.send("snapshot", { view: watch.value }, initialId);

      watch.start(async (call) => {
        if (stream.ended) return;
        if (call.kind === "value") {
          const entryId = call.value.entries.at(-1)?.id ?? call.value.before;
          stream.send("patch", { ops: call.ops, retired: call.retired }, entryId);
        } else {
          const message = call.error instanceof Error ? call.error.message : String(call.error);
          stream.send("failed", { message: message || "Conversation watch failed" });
        }
      });

      void watch.closed.then((watchEnd) => {
        watchClosed = true;
        if (!stream.ended) {
          void stream.finish(conversationEndFrame(watchEnd, isClosing()));
        }
      });
    } catch (error) {
      if (stream.opened) {
        await stream.finish();
      } else {
        watchAbort.abort();
        await watch?.stop().catch(() => undefined);
        releaseStream();
      }
      throw error;
    }
  }

  async function handleTaskStream(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    workerId: WorkerId,
    taskId: string,
    query: StreamWorkerTaskQuery,
  ): Promise<void> {
    const releaseStream = engine.acquireStream(projectId);
    let taskStream: WorkerTaskStream | undefined;
    const stream = new SseStream(req, res, deps);
    try {
      taskStream = await engine.projects.subscribeWorkerTaskStream(
        projectId,
        workerId,
        taskId,
        query,
      );
      if (
        !stream.open({
          onServerClose: () => ({ event: "end", data: { reason: "closed" } }),
          onCleanup: () => {
            taskStream?.close();
            releaseStream();
          },
        })
      ) {
        taskStream.close();
        releaseStream();
        return;
      }

      stream.flush();
      stream.send("snapshot", taskStream.snapshot);

      if (taskStream.terminal) {
        await stream.finish({ event: "end", data: { reason: "terminal" } });
        return;
      }

      taskStream.start({
        onChunk: (chunk) => stream.send("chunk", chunk),
        onStatus: (task) => stream.send("status", { task }),
        onEnd: (reason, message) => {
          void stream.finish({
            event: "end",
            data: { reason, ...(message === undefined ? {} : { message }) },
          });
        },
      });
    } catch (error) {
      if (stream.opened) {
        await stream.finish();
      } else {
        taskStream?.close();
        releaseStream();
      }
      throw error;
    }
  }

  function handleMcpOAuthStream(
    req: IncomingMessage,
    res: ServerResponse,
    serverName: string,
    sessionId: string,
    projectId?: string,
  ): void {
    streamBufferedSession<McpOAuthEvent>(
      req,
      res,
      (onEvent) => engine.mcp(projectId).subscribeOAuth(serverName, sessionId, onEvent),
      toMcpOAuthSseFrame,
      MCP_OAUTH_SHUTDOWN_FRAME,
    );
  }

  return {
    handleAllBoardsStream,
    handleBoardStream,
    handleConversationStream,
    handleTaskStream,
    handleLoginStream,
    handleMcpOAuthStream,
  };
}
