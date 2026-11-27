import type {
  AnyModel,
  ModelsStore,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
} from "@earendil-works/pi-ai";
import { errorMessage, isRecord } from "../shared/guards.ts";
import { LockedJsonMapStore } from "../shared/json-map-store.ts";

function validateModelsStoreEntry(providerId: string, value: unknown): ModelsStoreEntry {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new Error(`Invalid models-store.json entry for provider "${providerId}"`);
  }
  return { ...value, models: value.models as readonly AnyModel[] };
}

export class FileModelsStore implements ModelsStore {
  readonly filePath: string;
  readonly #store: LockedJsonMapStore<ModelsStoreEntry>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.#store = new LockedJsonMapStore({
      filePath,
      validateEntry: validateModelsStoreEntry,
      invalidRootMessage: "Invalid models-store.json: expected an object keyed by provider id",
      wrapError: (error) => new Error(`Failed to read models-store.json: ${errorMessage(error)}`),
    });
  }

  async read(
    providerId: string,
    options?: ModelsStoreOperationOptions,
  ): Promise<ModelsStoreEntry | undefined> {
    return this.#store.get(providerId, options?.signal);
  }

  async write(
    providerId: string,
    entry: ModelsStoreEntry,
    options?: ModelsStoreOperationOptions,
  ): Promise<void> {
    await this.#store.set(providerId, entry, options?.signal);
  }

  async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    await this.#store.delete(providerId, options?.signal);
  }
}
