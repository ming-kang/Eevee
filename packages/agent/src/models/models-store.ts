import { readFile } from "node:fs/promises";
import type {
  ModelsStore,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
} from "@earendil-works/pi-ai";
import { withFileLock, writeFileAtomic } from "../shared/file-lock.ts";
import { stripBom, stripJsonComments } from "../shared/json.ts";

type ModelsStoreFileData = Record<string, ModelsStoreEntry>;

function isModelsStoreEntry(value: unknown): value is ModelsStoreEntry {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as { models?: unknown }).models);
}

function parseModelsStoreFile(text: string): ModelsStoreFileData {
  const parsed: unknown = JSON.parse(stripJsonComments(stripBom(text)));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid models-store.json: expected an object keyed by provider id");
  }
  for (const [providerId, entry] of Object.entries(parsed)) {
    if (!isModelsStoreEntry(entry)) {
      throw new Error(`Invalid models-store.json entry for provider "${providerId}"`);
    }
  }
  return parsed as ModelsStoreFileData;
}

async function readModelsStoreFile(filePath: string): Promise<ModelsStoreFileData> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  try {
    return parseModelsStoreFile(text);
  } catch (error) {
    throw new Error(
      `Failed to read models-store.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export class FileModelsStore implements ModelsStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async read(
    providerId: string,
    options?: ModelsStoreOperationOptions,
  ): Promise<ModelsStoreEntry | undefined> {
    options?.signal?.throwIfAborted();
    const data = await readModelsStoreFile(this.filePath);
    return data[providerId];
  }

  async write(
    providerId: string,
    entry: ModelsStoreEntry,
    options?: ModelsStoreOperationOptions,
  ): Promise<void> {
    await withFileLock(
      this.filePath,
      async () => {
        const data = await readModelsStoreFile(this.filePath);
        data[providerId] = entry;
        await writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
      },
      options?.signal,
    );
  }

  async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    await withFileLock(
      this.filePath,
      async () => {
        const data = await readModelsStoreFile(this.filePath);
        if (!(providerId in data)) return;
        delete data[providerId];
        await writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
      },
      options?.signal,
    );
  }
}
