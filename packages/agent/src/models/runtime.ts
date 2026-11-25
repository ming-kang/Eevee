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
  type ModelThinkingLevel,
  type MutableModels,
} from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { AuthStorage } from "./auth-storage.ts";
import { type ModelsConfig, parseModelsConfig } from "./model-config.ts";
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
};

export type ResolvedModelChoice = {
  readonly model: Model<Api>;
  readonly thinkingLevel?: ModelThinkingLevel;
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

export class ModelRuntime {
  readonly dir: string;
  readonly credentials: AuthStorage;
  readonly modelsStore: FileModelsStore;

  readonly #env?: Readonly<Record<string, string | undefined>>;
  readonly #identity?: ClientIdentity;
  readonly #authContext: AuthContext;
  #config: ModelsConfig;
  #models: MutableModels;

  private constructor(options: ModelRuntimeOptions, config: ModelsConfig) {
    this.dir = options.dir;
    this.credentials = new AuthStorage(join(options.dir, AUTH_FILE), options.env);
    this.modelsStore = new FileModelsStore(join(options.dir, MODELS_STORE_FILE));
    this.#env = options.env;
    this.#identity = options.identity;
    this.#authContext = runtimeAuthContext(options.env);
    this.#config = config;
    this.#models = this.compose();
  }

  static async open(options: ModelRuntimeOptions): Promise<ModelRuntime> {
    const config = await readModelsConfig(join(options.dir, MODELS_FILE));
    return new ModelRuntime(options, config);
  }

  models(): Models {
    return this.#models;
  }

  config(): ModelsConfig {
    return this.#config;
  }

  async reload(): Promise<void> {
    const config = await readModelsConfig(join(this.dir, MODELS_FILE));
    this.#config = config;
    this.#models = this.compose();
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

  private compose(): MutableModels {
    const models = createModels({
      credentials: this.credentials,
      modelsStore: this.modelsStore,
      authContext: this.#authContext,
      ...(this.#identity === undefined ? {} : { identity: this.#identity }),
    });
    for (const provider of composeProviders(this.#config, { env: this.#env })) {
      models.setProvider(provider);
    }
    return models;
  }
}

async function readModelsConfig(filePath: string): Promise<ModelsConfig> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { providers: {} };
    }
    throw error;
  }
  return parseModelsConfig(text);
}
