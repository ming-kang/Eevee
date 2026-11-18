import { arr, int, num, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { type RoleName, THINKING_LEVELS } from "../contracts/domain.ts";
import { loadConfig, parseConfig } from "./config.ts";
import { readJson, writeJsonAtomic } from "./fs.ts";

const ModelChoiceSchema = obj({
  provider: str({ minLength: 1 }),
  modelId: str({ minLength: 1 }),
  thinkingLevel: opt(oneOf(THINKING_LEVELS)),
});

export const ModelDefaultsSchema = obj({
  default: opt(ModelChoiceSchema),
  router: opt(ModelChoiceSchema),
  worker: opt(ModelChoiceSchema),
  dreamer: opt(ModelChoiceSchema),
});

const RoleSettingsSchema = obj({
  /** Extensions enabled on top of the role's own, by name: MCP servers (`mcp.<name>`), user extensions. */
  extensions: opt(arr(str({ minLength: 1 }))),
  /** Most model turns a run may take; unset is Durable's default. */
  maxTurns: opt(int({ minimum: 1 })),
});

/** `~/.eevee/settings.json`, as stored: every field may be left out. */
export const StoredSettingsSchema = obj({
  port: opt(int({ minimum: 1, maximum: 65535 })),
  maxActiveWorkers: opt(int({ minimum: 1 })),
  backgroundAfterMs: opt(int({ minimum: 0 })),
  handoffThreshold: opt(num({ exclusiveMinimum: 0, maximum: 1 })),
  reminderAfterMs: opt(int({ minimum: 0 })),
  /** Least time between two Dreaming runs; 0 turns Dreaming off. */
  dreamIntervalMs: opt(int({ minimum: 0 })),
  models: opt(ModelDefaultsSchema),
  roles: opt(
    obj({
      router: opt(RoleSettingsSchema),
      worker: opt(RoleSettingsSchema),
      dreamer: opt(RoleSettingsSchema),
    }),
  ),
  /** Free-form notes; ignored. */
  $comment: opt(str()),
});

export type StoredSettings = Static<typeof StoredSettingsSchema>;
export type RoleSettings = Static<typeof RoleSettingsSchema>;

export type Settings = Required<Omit<StoredSettings, "$comment">>;

export const DEFAULT_SETTINGS: Settings = {
  port: 19190,
  maxActiveWorkers: 3,
  backgroundAfterMs: 5_000,
  handoffThreshold: 0.6,
  reminderAfterMs: 30 * 60_000,
  dreamIntervalMs: 24 * 60 * 60_000,
  models: {},
  roles: {},
};

export async function loadSettings(path: string): Promise<Settings> {
  return resolveSettings(await loadConfig(StoredSettingsSchema, path, {}));
}

function resolveSettings(stored: StoredSettings): Settings {
  const { $comment: _, ...fields } = stored;
  return {
    ...DEFAULT_SETTINGS,
    ...fields,
    models: { ...stored.models },
    roles: { ...stored.roles },
  };
}

/** The settings file's single writer: changes are queued, validated and written atomically. */
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

  update(change: (stored: StoredSettings) => StoredSettings): Promise<Settings> {
    const next = this.#queue.then(async () => {
      const raw = (await readJson<unknown>(this.#path)) ?? {};
      const current = parseConfig(StoredSettingsSchema, raw, this.#path);
      const stored = parseConfig(StoredSettingsSchema, change(current), this.#path);
      await writeJsonAtomic(this.#path, stored, { mode: 0o600 });
      this.#current = resolveSettings(stored);
      return this.#current;
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

/** Extensions enabled for `role` in `settings`. */
export const enabledExtensions = (settings: Settings, role: RoleName): readonly string[] =>
  settings.roles[role]?.extensions ?? [];
