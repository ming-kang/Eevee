import type { ConversationWindow, EntryQuery, EntryRecord } from "@earendil-works/pi-durable";
import type { ProblemBody } from "../../src/api/contract.ts";
import {
  type BoardTopic,
  type ConversationTopic,
  STREAM_PATH,
  STREAM_PROTOCOL,
  type StreamEvent,
  type StreamRequest,
  TOKEN_PROTOCOL_PREFIX,
} from "../../src/api/stream.ts";
import type { Problem } from "../../src/contracts/index.ts";
import { t } from "./i18n.ts";

export type StreamState = "connecting" | "connected" | "reconnecting" | "closed";

/** A request the Engine refused over the stream: the Problem to word, its wording as the message. */
export class StreamError extends Error {
  override name = "StreamError";
  readonly problem: Problem;

  constructor({ message, ...problem }: ProblemBody) {
    super(message);
    this.problem = problem as Problem;
  }
}

export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: () => void): void;
};

export type TimerLike = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

export type WatchEvent =
  | Extract<StreamEvent, { type: "value" | "ops" | "board" | "end" }>
  | { type: "error"; id: string; error: ProblemBody };

export type WatchRegistration = {
  topic: ConversationTopic | BoardTopic;
  window?: () => ConversationWindow | undefined;
  onReset?: () => void;
  onEvent: (event: WatchEvent) => void;
};

export type HelloInfo = {
  bootId: string;
  bootChanged: boolean;
};

export type StreamClientOptions = {
  baseUrl: string;
  token: string;
  createSocket?: (url: string, protocols: string[]) => SocketLike;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  timers?: TimerLike;
};

export function streamUrl(baseUrl: string): string {
  const url = new URL(STREAM_PATH, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

const WS_OPEN = 1;

export function createStreamClient(options: StreamClientOptions) {
  const createSocket =
    options.createSocket ??
    ((url, protocols) => {
      const Ctor = (
        globalThis as unknown as {
          WebSocket: new (u: string, p: string[]) => SocketLike;
        }
      ).WebSocket;
      return new Ctor(url, protocols);
    });
  const timers: TimerLike = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const jitter = options.jitter ?? 0.2;
  const url = streamUrl(options.baseUrl);
  const protocols = [STREAM_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${options.token}`];

  const watches = new Map<string, WatchRegistration>();
  const pendingEntries = new Map<
    string,
    { resolve: (items: EntryRecord[]) => void; reject: (error: Error) => void }
  >();
  const stateListeners = new Set<(state: StreamState) => void>();
  const helloListeners = new Set<(info: HelloInfo) => void>();
  const errorListeners = new Set<(error: StreamError) => void>();

  let socket: SocketLike | undefined;
  let reconnectTimer: unknown;
  let disposed = false;
  let greeted = false;
  let lastBootId: string | undefined;
  let attempt = 0;
  let nextEntrySeq = 1;
  let currentState: StreamState = "connecting";

  function setState(next: StreamState): void {
    if (currentState === next) return;
    currentState = next;
    for (const listener of [...stateListeners]) listener(next);
  }

  function send(request: StreamRequest): void {
    if (socket?.readyState === WS_OPEN) {
      socket.send(JSON.stringify(request));
    }
  }

  function sendWatch(id: string, reg: WatchRegistration): void {
    if (reg.topic.kind === "board") {
      send({ type: "watch", id, topic: reg.topic });
      return;
    }
    const win = reg.window?.();
    send({
      type: "watch",
      id,
      topic: reg.topic,
      ...(win === undefined ? {} : { window: win }),
    });
  }

  function rejectPending(reason: string): void {
    if (pendingEntries.size === 0) return;
    const pending = [...pendingEntries.values()];
    pendingEntries.clear();
    for (const item of pending) item.reject(new Error(reason));
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer !== undefined) return;
    const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    attempt += 1;
    const delay =
      jitter === 0 ? raw : Math.max(0, Math.round(raw * (1 - jitter + Math.random() * jitter * 2)));
    setState("reconnecting");
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = undefined;
      if (!disposed) open();
    }, delay);
  }

  function handleMessage(rawData: unknown): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(String(rawData)) as StreamEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case "hello": {
        const bootChanged = lastBootId !== undefined && lastBootId !== event.bootId;
        lastBootId = event.bootId;
        attempt = 0;
        greeted = true;
        setState("connected");
        if (bootChanged) {
          for (const reg of [...watches.values()]) reg.onReset?.();
        }
        for (const listener of [...helloListeners]) {
          listener({ bootId: event.bootId, bootChanged });
        }
        for (const [id, reg] of [...watches.entries()]) {
          sendWatch(id, reg);
        }
        return;
      }
      case "entries": {
        const pending = pendingEntries.get(event.id);
        if (!pending) return;
        pendingEntries.delete(event.id);
        pending.resolve(event.items);
        return;
      }
      case "error": {
        const error = new StreamError(event.error);
        if (event.id !== undefined) {
          const pending = pendingEntries.get(event.id);
          if (pending) {
            pendingEntries.delete(event.id);
            pending.reject(error);
            return;
          }
          const sub = watches.get(event.id);
          if (sub) {
            sub.onEvent({ type: "error", id: event.id, error: event.error });
            return;
          }
        }
        for (const listener of [...errorListeners]) listener(error);
        return;
      }
      case "end": {
        const sub = watches.get(event.id);
        if (!sub) return;
        watches.delete(event.id);
        sub.onEvent(event);
        return;
      }
      case "value":
      case "ops":
      case "board": {
        watches.get(event.id)?.onEvent(event);
        return;
      }
    }
  }

  function open(): void {
    if (disposed) return;
    greeted = false;
    setState(attempt === 0 && lastBootId === undefined ? "connecting" : "reconnecting");
    const ws = createSocket(url, protocols);
    socket = ws;

    ws.addEventListener("message", (event) => {
      if (ws !== socket || disposed) return;
      handleMessage(event.data);
    });
    ws.addEventListener("close", () => {
      if (ws !== socket) return;
      socket = undefined;
      greeted = false;
      rejectPending(t("实时流连接已断开"));
      if (!disposed) scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // Browser fires close right after error when connection fails.
    });
  }

  open();

  return {
    get state(): StreamState {
      return currentState;
    },
    get bootId(): string | undefined {
      return lastBootId;
    },
    watch(id: string, registration: WatchRegistration): () => void {
      if (disposed) return () => {};
      if (watches.has(id)) throw new Error(t("重复的 watch id：{id}", { id }));
      watches.set(id, registration);
      if (greeted && socket?.readyState === WS_OPEN) {
        sendWatch(id, registration);
      }
      return () => {
        if (watches.get(id) !== registration) return;
        watches.delete(id);
        if (greeted && socket?.readyState === WS_OPEN) {
          send({ type: "unwatch", id });
        }
      };
    },
    entries(
      topic: ConversationTopic,
      query: Omit<EntryQuery, "conversationId">,
      limit: number,
    ): Promise<EntryRecord[]> {
      if (disposed || !greeted || socket?.readyState !== WS_OPEN) {
        return Promise.reject(new Error(t("实时流尚未连接")));
      }
      const id = `e${nextEntrySeq++}`;
      return new Promise<EntryRecord[]>((resolve, reject) => {
        pendingEntries.set(id, { resolve, reject });
        send({ type: "entries", id, topic, query, limit });
      });
    },
    onState(listener: (state: StreamState) => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onHello(listener: (info: HelloInfo) => void): () => void {
      helloListeners.add(listener);
      return () => helloListeners.delete(listener);
    },
    onError(listener: (error: StreamError) => void): () => void {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    reconnectNow(): void {
      if (disposed) return;
      if (reconnectTimer !== undefined) {
        timers.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      attempt = 0;
      const prev = socket;
      socket = undefined;
      greeted = false;
      rejectPending(t("正在重新连接实时流"));
      prev?.close();
      open();
    },
    close(): void {
      if (disposed) return;
      disposed = true;
      if (reconnectTimer !== undefined) {
        timers.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const prev = socket;
      socket = undefined;
      greeted = false;
      watches.clear();
      rejectPending(t("实时流已关闭"));
      prev?.close();
      setState("closed");
    },
  };
}

export type StreamClient = ReturnType<typeof createStreamClient>;
