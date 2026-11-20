import { arr, bool, int, num, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { type RoleName, THINKING_LEVELS } from "../domain/domain.ts";
import { JsonFileStore } from "./json-file-store.ts";
import { loadConfig } from "./load.ts";

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
  /** Extensions enabled on top of the role's own, by name: MCP servers (`mcp.<name>`). */
  extensions: opt(arr(str({ minLength: 1 }))),
  /** Most model turns a run may take; unset is Durable's default. */
  maxTurns: opt(int({ minimum: 1 })),
});

const DreamingSchema = obj({
  /** Off turns Dreaming off entirely. */
  enabled: opt(bool()),
  /** How long the project must be idle before dreaming may run. */
  idleMs: opt(int({ minimum: 0 })),
  /** Least time between two dreamings. */
  minGapMs: opt(int({ minimum: 0 })),
  /** Closed tickets since the last dreaming that make it due. */
  afterTickets: opt(int({ minimum: 1 })),
  /** Lessons in reports since the last dreaming that make it due. */
  afterLessons: opt(int({ minimum: 1 })),
});

export type DreamingSettings = Required<Static<typeof DreamingSchema>>;

export const DEFAULT_DREAMING: DreamingSettings = {
  enabled: true,
  idleMs: 30 * 60_000,
  minGapMs: 6 * 60 * 60_000,
  afterTickets: 3,
  afterLessons: 5,
};

/** `~/.eevee/settings.json`, as stored: every field may be left out. */
export const StoredSettingsSchema = obj({
  port: opt(int({ minimum: 1, maximum: 65535 })),
  maxActiveWorkers: opt(int({ minimum: 1 })),
  backgroundAfterMs: opt(int({ minimum: 0 })),
  handoffThreshold: opt(num({ exclusiveMinimum: 0, maximum: 1 })),
  reminderAfterMs: opt(int({ minimum: 0 })),
  dreaming: opt(DreamingSchema),
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

export type Settings = Required<Omit<StoredSettings, "$comment" | "dreaming">> & {
  dreaming: DreamingSettings;
};

export const DEFAULT_SETTINGS: Settings = {
  port: 19190,
  maxActiveWorkers: 3,
  backgroundAfterMs: 5_000,
  handoffThreshold: 0.6,
  reminderAfterMs: 30 * 60_000,
  dreaming: DEFAULT_DREAMING,
  models: {},
  roles: {},
};

export async function loadSettings(path: string): Promise<Settings> {
  return resolveSettings(await loadConfig(StoredSettingsSchema, path, {}));
}

function resolveSettings(stored: StoredSettings): Settings {
  const { $comment: _, dreaming, ...fields } = stored;
  return {
    ...DEFAULT_SETTINGS,
    ...fields,
    models: { ...stored.models },
    roles: { ...stored.roles },
    dreaming: {
      ...DEFAULT_DREAMING,
      ...dreaming,
    },
  };
}

export class SettingsStore {
  readonly #store: JsonFileStore<typeof StoredSettingsSchema>;

  private constructor(store: JsonFileStore<typeof StoredSettingsSchema>) {
    this.#store = store;
  }

  static async open(path: string): Promise<SettingsStore> {
    return new SettingsStore(
      await JsonFileStore.open(StoredSettingsSchema, path, {}, { mode: 0o600 }),
    );
  }

  get current(): Settings {
    return resolveSettings(this.#store.current);
  }

  async update(change: (stored: StoredSettings) => StoredSettings): Promise<Settings> {
    return resolveSettings(await this.#store.update(change));
  }
}

export const enabledExtensions = (settings: Settings, role: RoleName): readonly string[] =>
  settings.roles[role]?.extensions ?? [];
