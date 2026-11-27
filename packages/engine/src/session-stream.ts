export const DEFAULT_SESSION_RETENTION_MS = 60_000;

export type BufferedSessionStreamOptions = {
  readonly retentionMs?: number;
  readonly onExpire?: () => void;
};

export class BufferedSessionStream<TFrame> {
  readonly #history: TFrame[] = [];
  readonly #subscribers = new Set<(frame: TFrame) => void>();
  readonly #retentionMs: number;
  readonly #onExpire?: () => void;
  #terminal = false;
  #retentionCancelled = false;
  #disposed = false;
  #done: Promise<void> = Promise.resolve();
  #cleanupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BufferedSessionStreamOptions = {}) {
    this.#retentionMs = options.retentionMs ?? DEFAULT_SESSION_RETENTION_MS;
    this.#onExpire = options.onExpire;
  }

  get terminal(): boolean {
    return this.#terminal;
  }

  get done(): Promise<void> {
    return this.#done;
  }

  get history(): readonly TFrame[] {
    return this.#history;
  }

  track(done: Promise<void>): Promise<void> {
    this.#done = done;
    return done;
  }

  emit(frame: TFrame): void {
    if (this.#terminal || this.#disposed) return;
    this.#fanOut(frame);
  }

  complete(terminalFrame: TFrame): void {
    if (this.#terminal || this.#disposed) return;
    this.#terminal = true;
    this.#fanOut(terminalFrame);
    this.#subscribers.clear();
    this.#scheduleCleanup();
  }

  subscribe(onFrame: (frame: TFrame) => void): () => void {
    if (this.#disposed) return () => {};
    for (const frame of [...this.#history]) {
      onFrame(frame);
    }
    if (this.#terminal || this.#disposed) {
      return () => {};
    }
    this.#subscribers.add(onFrame);
    return () => {
      this.#subscribers.delete(onFrame);
    };
  }

  cancelCleanup(): void {
    this.#retentionCancelled = true;
    if (this.#cleanupTimer !== undefined) {
      clearTimeout(this.#cleanupTimer);
      this.#cleanupTimer = undefined;
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.cancelCleanup();
    this.#subscribers.clear();
  }

  #fanOut(frame: TFrame): void {
    this.#history.push(frame);
    for (const subscriber of [...this.#subscribers]) {
      try {
        subscriber(frame);
      } catch {}
    }
  }

  #scheduleCleanup(): void {
    if (this.#disposed || this.#retentionCancelled || this.#onExpire === undefined) return;
    this.#cleanupTimer = setTimeout(() => {
      this.#cleanupTimer = undefined;
      if (!this.#disposed && !this.#retentionCancelled) {
        this.#onExpire?.();
      }
    }, this.#retentionMs);
    this.#cleanupTimer.unref?.();
  }
}
