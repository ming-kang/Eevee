import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationWindow } from "@earendil-works/pi-durable";
import type { ConversationRef, McpOAuthEvent, WorkerId } from "@eevee/protocol";
import type { Engine, LoginSseFrame, WorkerTaskStream } from "./engine.ts";
import type { StreamWorkerTaskQuery } from "./http-io.ts";

const SSE_KEEPALIVE_MS = 20_000;

export type SseStreamDeps = {
  readonly engine: Engine;
  readonly isClosing: () => boolean;
  readonly trackCloser: (closer: () => Promise<void>) => () => void;
};

export type SseStreamHandlers = {
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
  ) => void;
  readonly handleProjectMcpOAuthStream: (
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    serverName: string,
    sessionId: string,
  ) => void;
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

function openSseStream(res: ServerResponse): ReturnType<typeof setInterval> {
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

export function createSseStreamHandlers(deps: SseStreamDeps): SseStreamHandlers {
  const { engine, isClosing, trackCloser } = deps;

  function handleLoginStream(
    req: IncomingMessage,
    res: ServerResponse,
    providerId: string,
    sessionId: string,
  ): void {
    const buffered: LoginSseFrame[] = [];
    let streamReady = false;
    let ended = false;
    let unsubscribe = () => {};
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let closeForServer = async () => {};
    let untrackCloser: () => void = () => {};

    const finish = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      untrackCloser();
      if (keepalive !== undefined) clearInterval(keepalive);
      unsubscribe();
      if (!res.writableEnded && !res.destroyed) res.end();
    };

    const emitFrame = (frame: LoginSseFrame): void => {
      if (ended) return;
      writeSseEvent(res, frame.event, frame.data);
      if (frame.event === "complete" || frame.event === "error") {
        void finish();
      }
    };

    unsubscribe = engine.subscribeLoginSession(providerId, sessionId, (frame) => {
      if (!streamReady) {
        buffered.push(frame);
        return;
      }
      emitFrame(frame);
    });

    if (isClosing() || res.destroyed || req.socket.destroyed) {
      unsubscribe();
      return;
    }

    keepalive = openSseStream(res);

    closeForServer = async () => {
      if (!ended) {
        writeSseEvent(res, "error", { code: "engine_closed", message: "Engine is closing" });
      }
      await finish();
    };
    untrackCloser = trackCloser(closeForServer);

    res.on("close", () => {
      void finish();
    });

    streamReady = true;
    for (const frame of buffered) {
      emitFrame(frame);
    }
  }

  async function handleBoardStream(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
  ): Promise<void> {
    const releaseStream = engine.acquireStream(projectId);
    try {
      const handle = await engine.openProject(projectId);
      const initial = await handle.board(BACKGROUND_CONTEXT);

      if (isClosing() || res.destroyed || req.socket.destroyed) {
        releaseStream();
        return;
      }

      const keepalive = openSseStream(res);
      let ended = false;
      let lastSignature = JSON.stringify(initial);
      writeSseEvent(res, "board", initial);

      let unsubscribe = () => {};
      let untrackCloser: () => void = () => {};

      const finish = async (reason?: "closed"): Promise<void> => {
        if (ended) return;
        ended = true;
        untrackCloser();
        clearInterval(keepalive);
        unsubscribe();
        releaseStream();
        if (reason !== undefined) {
          writeSseEvent(res, "end", { reason });
        }
        if (!res.writableEnded && !res.destroyed) res.end();
      };

      const closeForServer = () => finish("closed");
      untrackCloser = trackCloser(closeForServer);

      res.on("close", () => {
        void finish();
      });

      unsubscribe = handle.subscribeBoard((board) => {
        if (ended) return;
        const signature = JSON.stringify(board);
        if (signature === lastSignature) return;
        lastSignature = signature;
        writeSseEvent(res, "board", board);
      });
    } catch (error) {
      releaseStream();
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
    try {
      const watchAbort = new AbortController();
      const watchContext = withAbortSignal(watchAbort.signal, BACKGROUND_CONTEXT);
      const watch = await engine.watchConversation(projectId, ref, watchContext, window);

      if (isClosing() || res.destroyed || req.socket.destroyed) {
        watchAbort.abort();
        await watch.stop().catch(() => undefined);
        releaseStream();
        return;
      }

      const keepalive = openSseStream(res);
      let ended = false;
      let untrackCloser: () => void = () => {};

      const finish = async (
        endPayload?: {
          readonly reason: "ended" | "aborted" | "closed" | "failed";
          readonly message?: string;
        },
        stopWatch = true,
      ): Promise<void> => {
        if (ended) return;
        ended = true;
        untrackCloser();
        clearInterval(keepalive);
        releaseStream();
        if (endPayload !== undefined) {
          writeSseEvent(res, "end", endPayload);
        }
        if (!res.writableEnded && !res.destroyed) res.end();
        if (stopWatch) {
          watchAbort.abort();
          await watch.stop().catch(() => undefined);
        }
      };

      const closeForServer = () => finish({ reason: "closed" }, true);
      untrackCloser = trackCloser(closeForServer);

      res.on("close", () => {
        void finish(undefined, true);
      });

      const initialId = watch.value.entries.at(-1)?.id ?? watch.value.before;
      writeSseEvent(res, "snapshot", { view: watch.value }, initialId);

      watch.start(async (call) => {
        if (ended) return;
        if (call.kind === "value") {
          const entryId = call.value.entries.at(-1)?.id ?? call.value.before;
          writeSseEvent(res, "patch", { ops: call.ops, retired: call.retired }, entryId);
        } else {
          const message = call.error instanceof Error ? call.error.message : String(call.error);
          writeSseEvent(res, "failed", { message: message || "Conversation watch failed" });
        }
      });

      void watch.closed.then((watchEnd) => {
        if (ended) return;
        if (isClosing()) {
          void finish({ reason: "closed" }, false);
          return;
        }
        switch (watchEnd.kind) {
          case "ended":
            void finish({ reason: "ended" }, false);
            break;
          case "aborted":
          case "stopped":
            void finish({ reason: "aborted" }, false);
            break;
          case "failed":
          case "listener_error": {
            const message =
              watchEnd.error instanceof Error ? watchEnd.error.message : String(watchEnd.error);
            void finish({ reason: "failed", ...(message ? { message } : {}) }, false);
            break;
          }
        }
      });
    } catch (error) {
      releaseStream();
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
    let stream: WorkerTaskStream | undefined;
    try {
      stream = await engine.subscribeWorkerTaskStream(projectId, workerId, taskId, query);

      if (isClosing() || res.destroyed || req.socket.destroyed) {
        stream.close();
        releaseStream();
        return;
      }

      const keepalive = openSseStream(res);
      let ended = false;
      let untrackCloser: () => void = () => {};

      const finish = async (endPayload?: {
        readonly reason: "completed" | "terminal" | "failed" | "closed";
        readonly message?: string;
      }): Promise<void> => {
        if (ended) return;
        ended = true;
        untrackCloser();
        clearInterval(keepalive);
        stream?.close();
        releaseStream();
        if (endPayload !== undefined) {
          writeSseEvent(res, "end", endPayload);
        }
        if (!res.writableEnded && !res.destroyed) res.end();
      };

      const closeForServer = () => finish({ reason: "closed" });
      untrackCloser = trackCloser(closeForServer);

      res.on("close", () => {
        void finish();
      });

      writeSseEvent(res, "snapshot", stream.snapshot);

      if (stream.terminal) {
        await finish({ reason: "terminal" });
        return;
      }

      stream.start({
        onChunk: (chunk) => {
          if (ended) return;
          writeSseEvent(res, "chunk", chunk);
        },
        onStatus: (task) => {
          if (ended) return;
          writeSseEvent(res, "status", { task });
        },
        onEnd: (reason, message) => {
          void finish({ reason, ...(message === undefined ? {} : { message }) });
        },
      });
    } catch (error) {
      stream?.close();
      releaseStream();
      throw error;
    }
  }

  function streamMcpOAuth(
    req: IncomingMessage,
    res: ServerResponse,
    subscribe: (onEvent: (event: McpOAuthEvent) => void) => () => void,
  ): void {
    const buffered: McpOAuthEvent[] = [];
    let streamReady = false;
    let ended = false;
    let unsubscribe = () => {};
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let closeForServer = async () => {};
    let untrackCloser: () => void = () => {};

    const finish = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      untrackCloser();
      if (keepalive !== undefined) clearInterval(keepalive);
      unsubscribe();
      if (!res.writableEnded && !res.destroyed) res.end();
    };

    const emitEvent = (event: McpOAuthEvent): void => {
      if (ended) return;
      writeSseEvent(res, event.type, event);
      if (event.type === "complete" || event.type === "error") {
        void finish();
      }
    };

    unsubscribe = subscribe((event) => {
      if (!streamReady) {
        buffered.push(event);
        return;
      }
      emitEvent(event);
    });

    if (isClosing() || res.destroyed || req.socket.destroyed) {
      unsubscribe();
      return;
    }

    keepalive = openSseStream(res);

    closeForServer = async () => {
      if (!ended) {
        writeSseEvent(res, "error", {
          type: "error",
          code: "engine_closed",
          message: "Engine is closing",
        });
      }
      await finish();
    };
    untrackCloser = trackCloser(closeForServer);

    res.on("close", () => {
      void finish();
    });

    streamReady = true;
    for (const event of buffered) {
      emitEvent(event);
    }
  }

  function handleMcpOAuthStream(
    req: IncomingMessage,
    res: ServerResponse,
    serverName: string,
    sessionId: string,
  ): void {
    streamMcpOAuth(req, res, (onEvent) =>
      engine.subscribeMcpOAuthSession(serverName, sessionId, onEvent),
    );
  }

  function handleProjectMcpOAuthStream(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    serverName: string,
    sessionId: string,
  ): void {
    streamMcpOAuth(req, res, (onEvent) =>
      engine.subscribeProjectMcpOAuthSession(projectId, serverName, sessionId, onEvent),
    );
  }

  return {
    handleBoardStream,
    handleConversationStream,
    handleTaskStream,
    handleLoginStream,
    handleMcpOAuthStream,
    handleProjectMcpOAuthStream,
  };
}
