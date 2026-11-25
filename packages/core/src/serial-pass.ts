export type SerialPassOptions = {
  readonly onError?: (error: unknown) => void;
};

export class SerialPass {
  readonly #run: () => Promise<void>;
  readonly #onError?: (error: unknown) => void;
  #running = false;
  #requested = false;
  #closed = false;
  #idleWaiters = new Set<() => void>();

  constructor(run: () => Promise<void>, options: SerialPassOptions = {}) {
    this.#run = run;
    this.#onError = options.onError;
  }

  request(): void {
    if (this.#closed) return;
    this.#requested = true;
    if (this.#running) return;
    this.#running = true;
    void this.#drain();
  }

  close(): void {
    this.#closed = true;
    this.#requested = false;
    this.#flushIdle();
  }

  async idle(): Promise<void> {
    if (!this.#running) return;
    await new Promise<void>((resolve) => {
      this.#idleWaiters.add(resolve);
    });
  }

  async #drain(): Promise<void> {
    try {
      while (this.#requested && !this.#closed) {
        this.#requested = false;
        try {
          await this.#run();
        } catch (error) {
          this.#onError?.(error);
        }
      }
    } finally {
      this.#running = false;
      this.#flushIdle();
    }
  }

  #flushIdle(): void {
    if (this.#running) return;
    const waiters = [...this.#idleWaiters];
    this.#idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}
