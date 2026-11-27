import type {
  ApiKeyCredential,
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { clearConfigValueCache, resolveConfigValue } from "../shared/config-value.ts";
import { errorMessage, isRecord, isStringRecord } from "../shared/guards.ts";
import { LockedJsonMapStore } from "../shared/json-map-store.ts";

function validateCredential(providerId: string, value: unknown): Credential {
  if (!isRecord(value)) {
    throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
  }
  if (value.type === "api_key") {
    const validKey = value.key === undefined || typeof value.key === "string";
    const validEnv = value.env === undefined || isStringRecord(value.env);
    if (validKey && validEnv) {
      return { ...value, type: "api_key" as const } as ApiKeyCredential;
    }
  } else if (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    typeof value.refresh === "string" &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires)
  ) {
    return {
      ...value,
      type: "oauth",
      access: value.access,
      refresh: value.refresh,
      expires: value.expires,
    };
  }
  throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
}

export class AuthStorage implements CredentialStore {
  readonly filePath: string;
  readonly #env?: Readonly<Record<string, string | undefined>>;
  readonly #store: LockedJsonMapStore<Credential>;

  constructor(filePath: string, env?: Readonly<Record<string, string | undefined>>) {
    this.filePath = filePath;
    this.#env = env;
    this.#store = new LockedJsonMapStore({
      filePath,
      validateEntry: validateCredential,
      invalidRootMessage: "Invalid auth.json: expected an object keyed by provider id",
      wrapError: (error) => new Error(`Failed to read auth.json: ${errorMessage(error)}`),
    });
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    const credential = await this.#store.get(providerId, options?.signal);
    if (credential === undefined) return undefined;
    if (credential.type !== "api_key" || credential.key === undefined) {
      return structuredClone(credential);
    }
    const env = { ...(this.#env ?? process.env), ...credential.env };
    return { ...credential, key: resolveConfigValue(credential.key, env) };
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const data = await this.#store.readAll(options?.signal);
    return Object.entries(data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const result = await this.#store.modify(providerId, fn, options?.signal);
    clearConfigValueCache();
    return result;
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    const deleted = await this.#store.delete(providerId, options?.signal);
    if (deleted) clearConfigValueCache();
  }
}
