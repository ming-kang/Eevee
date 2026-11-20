import type { Schema, Static } from "@earendil-works/pi-schema";
import { readJson, writeJsonAtomic } from "../shared/fs.ts";
import { loadConfig, parseConfig } from "./load.ts";

export class JsonFileStore<S extends Schema> {
  readonly #schema: S;
  readonly #path: string;
  readonly #fallback: () => Static<S>;
  readonly #mode: number | undefined;
  #current: Static<S>;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    schema: S,
    path: string,
    current: Static<S>,
    options: { fallback?: () => Static<S>; mode?: number } = {},
  ) {
    this.#schema = schema;
    this.#path = path;
    this.#current = parseConfig(schema, current, path);
    this.#fallback = options.fallback ?? (() => this.#current);
    this.#mode = options.mode;
  }

  static async open<S extends Schema>(
    schema: S,
    path: string,
    fallback: Static<S>,
    options: { mode?: number } = {},
  ): Promise<JsonFileStore<S>> {
    return new JsonFileStore(schema, path, await loadConfig(schema, path, fallback), {
      ...options,
      fallback: () => fallback,
    });
  }

  get current(): Static<S> {
    return this.#current;
  }

  update(change: (current: Static<S>) => Static<S>): Promise<Static<S>> {
    const next = this.#queue.then(async () => {
      const raw = (await readJson<unknown>(this.#path)) ?? this.#fallback();
      const current = parseConfig(this.#schema, raw, this.#path);
      const changed = parseConfig(this.#schema, change(current), this.#path);
      await writeJsonAtomic(this.#path, changed, { mode: this.#mode });
      this.#current = changed;
      return changed;
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
