import type { MemorySource } from "../../domain/index.ts";
import type { MemoryOp, MemoryStore } from "./store.ts";

export class MemoryRound {
  readonly #store: MemoryStore;
  #ops: MemoryOp[] = [];
  #pending: Promise<void> = Promise.resolve();

  constructor(store: MemoryStore) {
    this.#store = store;
  }

  add(op: MemoryOp): Promise<void> {
    const next = this.#pending.then(async () => {
      await this.#store.validate([...this.#ops, op]);
      this.#ops.push(op);
    });
    this.#pending = next.catch(() => {});
    return next;
  }

  async flush(source: MemorySource) {
    await this.#pending;
    const ops = this.#ops;
    this.#ops = [];
    return this.#store.apply(ops, source);
  }
}
