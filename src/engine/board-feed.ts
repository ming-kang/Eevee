import type { BoardView } from "../api/contract.ts";

type BuildEntry = { generation: number; promise: Promise<BoardView> };

/**
 * Coalesces board invalidations and serves single-flight cached snapshots:
 * `read()` never notifies, `invalidate()` batches notifications via `setImmediate`,
 * and stale in-flight builds never overwrite newer generations.
 */
export class BoardFeed {
  readonly #build: () => Promise<BoardView>;
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #cache: { generation: number; view: BoardView } | undefined;
  #inflight: BuildEntry | undefined;
  #scheduled: NodeJS.Immediate | undefined;
  #closed = false;

  constructor(build: () => Promise<BoardView>) {
    this.#build = build;
  }

  /** Marks the board dirty and schedules a single batched notification for listeners. */
  invalidate(): void {
    if (this.#closed) return;
    this.#generation += 1;
    if (this.#scheduled !== undefined) return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined;
      if (this.#closed) return;
      for (const listener of [...this.#listeners]) {
        if (!this.#listeners.has(listener)) continue;
        try {
          listener();
        } catch {
          // A failing listener must not keep the others from hearing the change.
        }
      }
    });
  }

  /** Current board snapshot: serves cache or in-flight work for the same generation, else builds anew. */
  read(): Promise<BoardView> {
    const generation = this.#generation;
    if (this.#cache?.generation === generation) return Promise.resolve(this.#cache.view);
    if (this.#inflight?.generation === generation) return this.#inflight.promise;
    const entry: BuildEntry = { generation, promise: undefined as never };
    entry.promise = (async () => {
      const view = await this.#build();
      if (this.#cache === undefined || generation >= this.#cache.generation) {
        this.#cache = { generation, view };
      }
      return view;
    })().finally(() => {
      if (this.#inflight === entry) this.#inflight = undefined;
    });
    this.#inflight = entry;
    return entry.promise;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    this.#closed = true;
    if (this.#scheduled !== undefined) {
      clearImmediate(this.#scheduled);
      this.#scheduled = undefined;
    }
    this.#listeners.clear();
  }
}
