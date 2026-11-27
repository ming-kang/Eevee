import { EngineError } from "./engine-error.ts";
import { KeyedSerialQueue } from "./serial-queue.ts";
import { BufferedSessionStream } from "./session-stream.ts";

export type ManagedSessionEntry<TFrame> = {
  readonly sessionId: string;
  readonly stream: BufferedSessionStream<TFrame>;
};

export type KeyedSessionRegistryOptions = {
  readonly retentionMs?: number;
};

export class KeyedSessionRegistry<TSession extends ManagedSessionEntry<TFrame>, TFrame> {
  readonly #sessions = new Map<string, TSession>();
  readonly #startQueue = new KeyedSerialQueue();
  readonly #retentionMs: number | undefined;
  #closed = false;

  constructor(options: KeyedSessionRegistryOptions = {}) {
    this.#retentionMs = options.retentionMs;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get size(): number {
    return this.#sessions.size;
  }

  assertOpen(): void {
    if (this.#closed) {
      throw new EngineError(503, "engine_closed", "Engine is closing");
    }
  }

  createStream(
    getSessionId: () => string,
    retentionMs = this.#retentionMs,
  ): BufferedSessionStream<TFrame> {
    return new BufferedSessionStream<TFrame>({
      ...(retentionMs === undefined ? {} : { retentionMs }),
      onExpire: () => {
        if (this.#closed) return;
        const id = getSessionId();
        if (id !== "") this.#sessions.delete(id);
      },
    });
  }

  async start(chainKey: string, createFn: () => Promise<TSession> | TSession): Promise<TSession> {
    this.assertOpen();
    return this.#startQueue.enqueue(chainKey, async () => {
      this.assertOpen();
      const session = await createFn();
      this.#sessions.set(session.sessionId, session);
      return session;
    });
  }

  require(
    sessionId: string,
    predicate: (session: TSession) => boolean,
    notFoundError: () => EngineError,
  ): TSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || !predicate(session)) {
      throw notFoundError();
    }
    return session;
  }

  async cancelWhere(
    predicate: (session: TSession) => boolean,
    cancelFn: (session: TSession) => void,
    waitFor: (session: TSession) => Promise<void> = (session) => session.stream.done,
  ): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const session of this.#sessions.values()) {
      if (predicate(session) && !session.stream.terminal) {
        cancelFn(session);
        pending.push(waitFor(session));
      }
    }
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  }

  async close(cancelFn: (session: TSession) => void): Promise<void> {
    this.#closed = true;
    for (const session of this.#sessions.values()) {
      session.stream.cancelCleanup();
      if (!session.stream.terminal) {
        cancelFn(session);
      }
    }
    await this.#startQueue.drainAll();
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) {
      session.stream.cancelCleanup();
      if (!session.stream.terminal) {
        cancelFn(session);
      }
    }
    await Promise.allSettled(sessions.map((session) => session.stream.done));
    for (const session of sessions) {
      session.stream.dispose();
    }
    this.#sessions.clear();
  }
}
