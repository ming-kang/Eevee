import { readFile } from "node:fs/promises";
import { withFileLock, writeFileAtomic } from "./file-lock.ts";
import { errorMessage, isEnoent, isRecord } from "./guards.ts";
import { stripBom, stripJsonComments } from "./json.ts";

export type LockedJsonMapStoreOptions<T> = {
  readonly filePath: string;
  readonly validateEntry: (key: string, value: unknown) => T;
  readonly mode?: number;
  readonly invalidRootMessage?: string;
  readonly formatParseError?: (error: unknown) => Error;
  readonly wrapError?: (error: unknown) => Error;
};

export class LockedJsonMapStore<T> {
  readonly filePath: string;
  readonly #validateEntry: (key: string, value: unknown) => T;
  readonly #mode: number;
  readonly #invalidRootMessage: string;
  readonly #formatParseError?: (error: unknown) => Error;
  readonly #wrapError?: (error: unknown) => Error;

  constructor(options: LockedJsonMapStoreOptions<T>) {
    this.filePath = options.filePath;
    this.#validateEntry = options.validateEntry;
    this.#mode = options.mode ?? 0o600;
    this.#invalidRootMessage = options.invalidRootMessage ?? "Expected a JSON object";
    this.#formatParseError = options.formatParseError;
    this.#wrapError = options.wrapError;
  }

  #parse(text: string): Record<string, T> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(stripBom(text)));
    } catch (error) {
      throw this.#formatParseError ? this.#formatParseError(error) : error;
    }
    if (!isRecord(parsed)) {
      throw new Error(this.#invalidRootMessage);
    }
    const result: Record<string, T> = {};
    for (const [key, entry] of Object.entries(parsed)) {
      const validated = this.#validateEntry(key, entry);
      Object.defineProperty(result, key, {
        value: validated,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }

  async readAll(signal?: AbortSignal): Promise<Record<string, T>> {
    signal?.throwIfAborted();
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) return {};
      throw error;
    }
    try {
      return this.#parse(text);
    } catch (error) {
      throw this.#wrapError
        ? this.#wrapError(error)
        : error instanceof Error
          ? error
          : new Error(errorMessage(error));
    }
  }

  async get(key: string, signal?: AbortSignal): Promise<T | undefined> {
    const data = await this.readAll(signal);
    return Object.hasOwn(data, key) ? data[key] : undefined;
  }

  async modify(
    key: string,
    fn: (current: T | undefined) => T | undefined | Promise<T | undefined>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    return withFileLock(
      this.filePath,
      async () => {
        const data = await this.readAll();
        const current = Object.hasOwn(data, key) ? data[key] : undefined;
        const next = await fn(current);
        if (next !== undefined) {
          Object.defineProperty(data, key, {
            value: next,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          await writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`, this.#mode);
          return next;
        }
        return current;
      },
      signal,
    );
  }

  async set(key: string, value: T, signal?: AbortSignal): Promise<void> {
    await this.modify(key, () => value, signal);
  }

  async delete(key: string, signal?: AbortSignal): Promise<boolean> {
    return withFileLock(
      this.filePath,
      async () => {
        const data = await this.readAll();
        if (!Object.hasOwn(data, key)) return false;
        delete data[key];
        await writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`, this.#mode);
        return true;
      },
      signal,
    );
  }
}
