import { type CommitPublication, LiveDoc } from "@earendil-works/pi-durable";
import type { BoardView } from "../protocol/contract.ts";
import { SerialPass } from "../shared/serial-pass.ts";
import { Board, QuestionDoc, ReportLog, TicketDoc } from "./docs.ts";
import { WorkerQueue } from "./orchestration/index.ts";

const BOARD_DOC_KINDS = new Set([
  Board.definition.kind,
  TicketDoc.definition.kind,
  ReportLog.definition.kind,
  QuestionDoc.definition.kind,
  LiveDoc.definition.kind,
  WorkerQueue.definition.kind,
]);

export function isBoardCommit(pub: CommitPublication): boolean {
  return pub.changes.some((c) => c.type === "document" && BOARD_DOC_KINDS.has(c.record.kind));
}

/** Hears a board: each distinct snapshot in the order they were taken, or why one could not be built. */
export type BoardListener = {
  view(board: BoardView): void;
  failed(error: unknown): void;
};

type Snapshot = { generation: number; view: BoardView; json: string };
type Subscriber = { listener: BoardListener; last: BoardView | undefined };

/**
 * A board's snapshots and their one delivery path. `invalidate()` marks the board stale. Builds run one at a time,
 * so snapshots are taken in order; one whose content did not change keeps the previous object. `read()` resolves
 * with a snapshot taken after it was called. Subscribers are fed by a single serial pass, never by their own
 * reads: each hears the current snapshot, then every later one that differs, in order, so a slow build can
 * never overtake a newer one on its way to a client.
 */
export class BoardFeed {
  readonly #build: () => Promise<BoardView>;
  readonly #subscribers = new Set<Subscriber>();
  readonly #delivery: SerialPass;
  #generation = 0;
  #snapshot: Snapshot | undefined;
  #building: { generation: number; done: Promise<Snapshot> } | undefined;

  constructor(build: () => Promise<BoardView>) {
    this.#build = build;
    this.#delivery = new SerialPass(
      () => this.#deliver(),
      (error) => console.error("Delivering the board failed.", error),
    );
  }

  invalidate(): void {
    this.#generation += 1;
    if (this.#subscribers.size > 0) this.#delivery.request();
  }

  async read(): Promise<BoardView> {
    return (await this.#current()).view;
  }

  subscribe(listener: BoardListener): () => void {
    const subscriber: Subscriber = { listener, last: undefined };
    this.#subscribers.add(subscriber);
    this.#delivery.request();
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  /** Drops the subscribers and waits for a delivery under way, which may still be reading the Session. */
  close(): Promise<void> {
    this.#subscribers.clear();
    return this.#delivery.close();
  }

  /** A snapshot taken no earlier than this call: the last one if nothing changed since, else a newer build's. */
  async #current(): Promise<Snapshot> {
    const wanted = this.#generation;
    for (;;) {
      if (this.#snapshot !== undefined && this.#snapshot.generation >= wanted)
        return this.#snapshot;
      const building = this.#building ?? this.#start();
      if (building.generation >= wanted) return building.done;
      // That build began before the change this read must see; another starts once it is over.
      await building.done.catch(() => undefined);
    }
  }

  #start(): { generation: number; done: Promise<Snapshot> } {
    const generation = this.#generation;
    const done = (async () => {
      const view = await this.#build();
      const json = JSON.stringify(view);
      this.#snapshot =
        json === this.#snapshot?.json
          ? { ...this.#snapshot, generation }
          : { generation, view, json };
      return this.#snapshot;
    })().finally(() => {
      this.#building = undefined;
    });
    this.#building = { generation, done };
    return this.#building;
  }

  async #deliver(): Promise<void> {
    if (this.#subscribers.size === 0) return;
    let view: BoardView;
    try {
      view = (await this.#current()).view;
    } catch (error) {
      for (const subscriber of this.#subscribers) tell(() => subscriber.listener.failed(error));
      return;
    }
    for (const subscriber of this.#subscribers) {
      if (subscriber.last === view) continue;
      subscriber.last = view;
      tell(() => subscriber.listener.view(view));
    }
  }
}

/** Calls one listener; a failing listener must not keep the others from hearing the board. */
function tell(call: () => void): void {
  try {
    call();
  } catch (error) {
    console.error("A board listener failed.", error);
  }
}
