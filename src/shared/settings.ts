import type { ModelDefaults } from "../contracts/domain.ts";
import { readJson, writeJsonAtomic } from "./fs.ts";

export type Settings = {
  port: number;
  maxActiveWorkers: number;
  backgroundAfterMs: number;
  handoffThreshold: number;
  reminderAfterMs: number;
  models: ModelDefaults;
};

export const DEFAULT_SETTINGS: Settings = {
  port: 19190,
  maxActiveWorkers: 3,
  backgroundAfterMs: 5_000,
  handoffThreshold: 0.6,
  reminderAfterMs: 30 * 60_000,
  models: {},
};

export async function loadSettings(path: string): Promise<Settings> {
  return resolveSettings(await readJson<Partial<Settings>>(path));
}

function resolveSettings(stored: Partial<Settings> | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...stored, models: { ...stored?.models } };
}

export class SettingsStore {
  readonly #path: string;
  #current: Settings;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, current: Settings) {
    this.#path = path;
    this.#current = current;
  }

  static async open(path: string): Promise<SettingsStore> {
    return new SettingsStore(path, await loadSettings(path));
  }

  get current(): Settings {
    return this.#current;
  }

  update(change: (stored: Partial<Settings>) => Partial<Settings>): Promise<Settings> {
    const next = this.#queue.then(async () => {
      const stored = change((await readJson<Partial<Settings>>(this.#path)) ?? {});
      await writeJsonAtomic(this.#path, stored, { mode: 0o600 });
      this.#current = resolveSettings(stored);
      return this.#current;
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
