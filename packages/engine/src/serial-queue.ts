export class KeyedSerialQueue {
  readonly #chains = new Map<string, Promise<void>>();

  enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#chains.get(key) ?? Promise.resolve();
    const run = prev.then(() => fn());
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    const cleaned = tail.finally(() => {
      if (this.#chains.get(key) === cleaned) {
        this.#chains.delete(key);
      }
    });
    this.#chains.set(key, cleaned);
    return cleaned.then(() => run);
  }

  async drain(key: string): Promise<void> {
    while (this.#chains.has(key)) {
      await this.#chains.get(key);
    }
  }

  async drainAll(): Promise<void> {
    while (this.#chains.size > 0) {
      await Promise.allSettled([...this.#chains.values()]);
    }
  }
}
