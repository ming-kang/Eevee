import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { readJson, writeJsonAtomic } from "../shared/fs.ts";

type AuthFile = Record<string, Credential>;

export class FileCredentialStore implements CredentialStore {
  readonly #path: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.#load())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.#load()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#serial(async () => {
      const file = await this.#load();
      const next = await fn(file[providerId]);
      if (next === undefined) return file[providerId];
      file[providerId] = next;
      await this.#save(file);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.#serial(async () => {
      const file = await this.#load();
      if (!(providerId in file)) return;
      delete file[providerId];
      await this.#save(file);
    });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #load(): Promise<AuthFile> {
    return (await readJson<AuthFile>(this.#path)) ?? {};
  }

  async #save(file: AuthFile): Promise<void> {
    await writeJsonAtomic(this.#path, file, { mode: 0o600 });
  }
}
