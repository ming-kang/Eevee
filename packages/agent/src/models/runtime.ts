import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  type AuthContext,
  type ClientIdentity,
  clampThinkingLevel,
  createModels,
  type Model,
  type Models,
  type ModelsRefreshResult,
  type ModelThinkingLevel,
  type MutableModels,
} from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { resolveConfigValue } from "../shared/config-value.ts";
import { AuthStorage } from "./auth-storage.ts";
import { type ModelsConfig, ModelsConfigError, parseModelsConfig } from "./model-config.ts";
import { FileModelsStore } from "./models-store.ts";
import { composeProviders } from "./provider-composer.ts";

export const AUTH_FILE = "auth.json";
export const MODELS_FILE = "models.json";
export const MODELS_STORE_FILE = "models-store.json";

export type ModelChoice = ModelRef & {
  readonly thinkingLevel?: ModelThinkingLevel;
};

export type ModelRuntimeOptions = {
  readonly dir: string;
  /** Fully replaces `process.env` for auth and `models.json` value resolution when present. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly identity?: ClientIdentity;
  readonly strict?: boolean;
};

export type ResolvedModelChoice = {
  readonly model: Model<Api>;
  readonly thinkingLevel?: ModelThinkingLevel;
};

export type ModelsConfigDiagnostic = {
  readonly path: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
};

export type ProviderAuthSummary = {
  readonly configured: boolean;
  readonly source?: string;
  readonly type?: "api_key" | "oauth";
  readonly preview?: string;
  readonly accountLabel?: string;
  readonly expiresAt?: number;
};

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function runtimeAuthContext(env?: Readonly<Record<string, string | undefined>>): AuthContext {
  return {
    env: async (name) => {
      if (env) return env[name];
      const value = process.env[name];
      return value === undefined || value === "" ? undefined : value;
    },
    fileExists: async (path) => {
      try {
        return existsSync(expandHome(path));
      } catch {
        return false;
      }
    },
  };
}

function errorPosition(text: string, error: unknown): { line?: number; column?: number } {
  if (!(error instanceof Error)) return {};
  const lineMatch = /line (\d+) column (\d+)/i.exec(error.message);
  if (lineMatch) return { line: Number(lineMatch[1]), column: Number(lineMatch[2]) };
  const positionMatch = /position (\d+)/i.exec(error.message);
  if (!positionMatch) return {};
  const position = Number(positionMatch[1]);
  const before = text.slice(0, position);
  const lines = before.split(/\r\n|\r|\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function diagnosticFor(error: unknown, text = "", fallbackPath = ""): ModelsConfigDiagnostic {
  return {
    path: error instanceof ModelsConfigError ? error.path : fallbackPath,
    message: error instanceof Error ? error.message : String(error),
    ...errorPosition(text, error),
  };
}

type ConfigReadResult = {
  readonly config: ModelsConfig;
  readonly diagnostics: readonly ModelsConfigDiagnostic[];
  readonly error?: unknown;
};

async function readModelsConfig(filePath: string, strict: boolean): Promise<ConfigReadResult> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { config: { providers: {} }, diagnostics: [] };
    }
    throw error;
  }
  try {
    return { config: parseModelsConfig(text), diagnostics: [] };
  } catch (error) {
    if (strict) throw error;
    return {
      config: { providers: {} },
      diagnostics: [diagnosticFor(error, text)],
      error,
    };
  }
}

function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function accountLabel(credential: unknown): string | undefined {
  if (typeof credential !== "object" || credential === null) return undefined;
  const record = credential as Record<string, unknown>;
  for (const key of ["accountLabel", "email", "accountId", "account", "user", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export class ModelRuntime {
  readonly dir: string;
  readonly credentials: AuthStorage;
  readonly modelsStore: FileModelsStore;

  readonly #env?: Readonly<Record<string, string | undefined>>;
  readonly #identity?: ClientIdentity;
  readonly #authContext: AuthContext;
  readonly #strict: boolean;
  #config: ModelsConfig;
  #models: MutableModels;
  #diagnostics: ModelsConfigDiagnostic[];
  #reloadChain: Promise<void> = Promise.resolve();

  private constructor(
    options: ModelRuntimeOptions,
    config: ModelsConfig,
    diagnostics: readonly ModelsConfigDiagnostic[],
  ) {
    this.dir = options.dir;
    this.credentials = new AuthStorage(join(options.dir, AUTH_FILE), options.env);
    this.modelsStore = new FileModelsStore(join(options.dir, MODELS_STORE_FILE));
    this.#env = options.env;
    this.#identity = options.identity;
    this.#authContext = runtimeAuthContext(options.env);
    this.#strict = options.strict ?? false;
    this.#config = config;
    this.#diagnostics = [...diagnostics];
    try {
      this.#models = this.compose(config);
    } catch (error) {
      if (this.#strict) throw error;
      this.#diagnostics.push(diagnosticFor(error));
      this.#config = { providers: {} };
      this.#models = this.compose(this.#config);
    }
  }

  static async open(options: ModelRuntimeOptions): Promise<ModelRuntime> {
    const loaded = await readModelsConfig(join(options.dir, MODELS_FILE), options.strict ?? false);
    const runtime = new ModelRuntime(options, loaded.config, loaded.diagnostics);
    await runtime.hydrateStoredCatalogs();
    return runtime;
  }

  models(): Models {
    return this.#models;
  }

  config(): ModelsConfig {
    return this.#config;
  }

  configDiagnostics(): readonly ModelsConfigDiagnostic[] {
    return this.#diagnostics;
  }

  async reload(options?: { readonly strict?: boolean }): Promise<void> {
    const run = this.#reloadChain.then(() => this.#runReload(options));
    this.#reloadChain = run.catch(() => undefined);
    return run;
  }

  async #runReload(options?: { readonly strict?: boolean }): Promise<void> {
    const strict = options?.strict ?? this.#strict;
    const loaded = await readModelsConfig(join(this.dir, MODELS_FILE), strict);
    let models: MutableModels;
    let config = loaded.config;
    const diagnostics = [...loaded.diagnostics];
    try {
      models = this.compose(config);
    } catch (error) {
      if (strict) throw error;
      diagnostics.push(diagnosticFor(error));
      config = { providers: {} };
      models = this.compose(config);
    }
    this.#config = config;
    this.#models = models;
    this.#diagnostics = diagnostics;
    await this.hydrateStoredCatalogs();
  }

  async hydrateStoredCatalogs(): Promise<ModelsRefreshResult> {
    return this.#models.refresh({ allowNetwork: false });
  }

  async getAuthSummary(providerId: string): Promise<ProviderAuthSummary> {
    const stored = await this.credentials.read(providerId);
    const check = await this.#models.checkAuth(providerId);
    const resolved =
      check && stored?.type !== "oauth" ? await this.#models.getAuth(providerId) : undefined;
    const configKey = this.#config.providers[providerId]?.apiKey;
    const resolvedConfigKey =
      stored || configKey === undefined
        ? undefined
        : resolveConfigValue(configKey, this.#env, { cacheCommands: false });
    let secret = stored?.type === "api_key" ? stored.key : resolvedConfigKey;
    secret ??= resolved?.auth.apiKey;
    if (!secret && stored?.type === "oauth") secret = stored.access;
    if (!secret) {
      const headers = resolved?.auth.headers ?? {};
      const authorization = Object.entries(headers).find(([name]) =>
        ["authorization", "x-api-key", "x-goog-api-key", "cf-aig-authorization"].includes(
          name.toLowerCase(),
        ),
      )?.[1];
      if (typeof authorization === "string") secret = authorization.replace(/^Bearer\s+/i, "");
    }
    const source = stored
      ? "auth.json"
      : check?.source === "models.json"
        ? "models.json"
        : (check?.source ?? resolved?.source);
    const type = stored?.type ?? check?.type;
    const preview = maskSecret(secret);
    const account = accountLabel(stored);
    return {
      configured: check !== undefined && (stored?.type === "oauth" || resolved !== undefined),
      ...(source === undefined ? {} : { source }),
      ...(type === undefined ? {} : { type }),
      ...(preview === undefined ? {} : { preview }),
      ...(account === undefined ? {} : { accountLabel: account }),
      ...(stored?.type === "oauth" ? { expiresAt: stored.expires } : {}),
    };
  }

  resolveModel(ref: ModelRef): Model<Api> | undefined {
    return this.#models.getModel(ref.provider, ref.modelId);
  }

  resolveChoice(choice: ModelChoice): ResolvedModelChoice | undefined {
    const model = this.resolveModel(choice);
    if (!model) return undefined;
    if (choice.thinkingLevel === undefined) return { model };
    return { model, thinkingLevel: clampThinkingLevel(model, choice.thinkingLevel) };
  }

  private compose(config: ModelsConfig): MutableModels {
    const models = createModels({
      credentials: this.credentials,
      modelsStore: this.modelsStore,
      authContext: this.#authContext,
      ...(this.#identity === undefined ? {} : { identity: this.#identity }),
    });
    for (const provider of composeProviders(config, { env: this.#env })) {
      models.setProvider(provider);
    }
    return models;
  }
}
