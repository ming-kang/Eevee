import { readFile } from "node:fs/promises";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { clearConfigValueCache, resolveConfigValue } from "../shared/config-value.ts";
import { withFileLock, writeFileAtomic } from "../shared/file-lock.ts";
import { stripBom, stripJsonComments } from "../shared/json.ts";

type AuthFileData = Record<string, Credential>;

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function validateCredential(providerId: string, value: unknown): asserts value is Credential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
  }
  const credential = value as Record<string, unknown>;
  if (credential.type === "api_key") {
    const validKey = credential.key === undefined || typeof credential.key === "string";
    const validEnv = credential.env === undefined || isStringRecord(credential.env);
    if (validKey && validEnv) return;
  } else if (
    credential.type === "oauth" &&
    typeof credential.access === "string" &&
    typeof credential.refresh === "string" &&
    typeof credential.expires === "number" &&
    Number.isFinite(credential.expires)
  ) {
    return;
  }
  throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
}

function parseAuthFile(text: string): AuthFileData {
  const parsed: unknown = JSON.parse(stripJsonComments(stripBom(text)));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid auth.json: expected an object keyed by provider id");
  }
  for (const [providerId, credential] of Object.entries(parsed)) {
    validateCredential(providerId, credential);
  }
  return parsed as AuthFileData;
}

async function readAuthFile(filePath: string): Promise<AuthFileData> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  try {
    return parseAuthFile(text);
  } catch (error) {
    throw new Error(
      `Failed to read auth.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Pi-format `auth.json` credential store. A corrupted file fails every read, so a later write cannot
 * silently drop the other providers; writes are serialized cross-process and atomic.
 */
export class AuthStorage implements CredentialStore {
  readonly filePath: string;
  readonly #env?: Readonly<Record<string, string | undefined>>;

  constructor(filePath: string, env?: Readonly<Record<string, string | undefined>>) {
    this.filePath = filePath;
    this.#env = env;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const data = await readAuthFile(this.filePath);
    const credential = data[providerId];
    if (credential === undefined) return undefined;
    if (credential.type !== "api_key" || credential.key === undefined) {
      return structuredClone(credential);
    }
    const env = { ...(this.#env ?? process.env), ...credential.env };
    return { ...credential, key: resolveConfigValue(credential.key, env) };
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const data = await readAuthFile(this.filePath);
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
    return withFileLock(
      this.filePath,
      async () => {
        const data = await readAuthFile(this.filePath);
        const next = await fn(data[providerId]);
        if (next !== undefined) {
          data[providerId] = next;
          await writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 0o600);
        }
        clearConfigValueCache();
        return data[providerId];
      },
      options?.signal,
    );
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await withFileLock(
      this.filePath,
      async () => {
        const data = await readAuthFile(this.filePath);
        if (!(providerId in data)) return;
        delete data[providerId];
        await writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 0o600);
        clearConfigValueCache();
      },
      options?.signal,
    );
  }
}
