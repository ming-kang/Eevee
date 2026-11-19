/**
 * Background work that owns its whole lifecycle: a pass runs on the next turn of the event loop after a
 * `request()`, so a burst of requests costs one pass; passes never overlap, and a request made while one runs
 * runs it once more afterwards; `close()` takes no more requests and resolves once the pass under way is done,
 * so whatever the pass uses can be closed after it.
 */
export class SerialPass {
  readonly #run: () => Promise<void>;
  readonly #onError: (error: unknown) => void;
  #running: Promise<void> | undefined;
  #again = false;
  #closed = false;

  /** `onError` hears a pass that threw; the next request runs it again. */
  constructor(run: () => Promise<void>, onError: (error: unknown) => void) {
    this.#run = run;
    this.#onError = onError;
  }

  /** Whether `close()` was called: a long pass checks it to stop early. */
  get closed(): boolean {
    return this.#closed;
  }

  request(): void {
    if (this.#closed) return;
    if (this.#running !== undefined) {
      this.#again = true;
      return;
    }
    this.#running = this.#loop().finally(() => {
      this.#running = undefined;
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#running;
  }

  async #loop(): Promise<void> {
    do {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.#closed) return;
      // Requests made while waiting for this turn are served by this pass.
      this.#again = false;
      try {
        await this.#run();
      } catch (error) {
        this.#onError(error);
      }
    } while (this.#again && !this.#closed);
  }
}
