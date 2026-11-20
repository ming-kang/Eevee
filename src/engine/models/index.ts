import type { CredentialStore, Models, MutableModels, Provider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ConfigError, configIssue, parseConfig } from "../../config/load.ts";
import { type ModelsConfig, ModelsConfigSchema, type ProviderConfig } from "../../config/models.ts";
import { type ConfigProblem, describeConfigProblem, ProblemError } from "../../domain/index.ts";
import { readJson, writeJsonAtomic } from "../../shared/fs.ts";
import type { EeveePaths } from "../../shared/paths.ts";
import { FileCredentialStore } from "./auth-store.ts";
import { type BuiltinModelRef, builtinCatalog } from "./builtin-catalog.ts";
import { applyModelsConfig, composeProvider, loadModelsConfig } from "./models-config.ts";

export type BuiltinProvider = { name: string; baseUrl?: string };

export type ModelRuntime = {
  models: () => Models;
  credentials: FileCredentialStore;
  /** Providers successfully added or customized by models.json at the last load. */
  customProviders: () => ReadonlySet<string>;
  builtinProviders: () => ReadonlyMap<string, BuiltinProvider>;
  builtinCatalog: () => readonly BuiltinModelRef[];
  /** Problems found in models.json at the last load; the affected providers keep their built-in form. */
  problems: () => readonly ConfigProblem[];
  providerConfigs(): Promise<Record<string, ProviderConfig>>;
  /**
   * models.json's single writer: replaces one provider's entry, or removes it (`undefined`), then reloads.
   * The entry must make a working provider, and the models in `keep` must still exist afterwards.
   */
  setProviderConfig(
    id: string,
    entry: ProviderConfig | undefined,
    keep?: readonly string[],
  ): Promise<void>;
  reload(): Promise<void>;
};

const FILE = "models.json";

export type ModelRuntimeOptions = {
  /** The providers models.json builds on; pi-ai's built-in ones unless a test or scenario brings its own. */
  base?: (credentials: CredentialStore) => MutableModels;
};

export async function createModelRuntime(
  paths: EeveePaths,
  options: ModelRuntimeOptions = {},
): Promise<ModelRuntime> {
  const credentials = new FileCredentialStore(paths.auth);
  const base = options.base ?? ((store) => builtinModels({ credentials: store }));
  const build = async () => {
    const models = base(credentials);
    const builtins = new Map<string, BuiltinProvider>(
      models.getProviders().map((p) => [p.id, describeBuiltin(p)]),
    );
    const problems: ConfigProblem[] = [];
    const custom = new Set<string>();
    try {
      problems.push(...applyModelsConfig(models, await loadModelsConfig(paths.models), custom));
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(...error.problems);
    }
    for (const problem of problems) console.error(describeConfigProblem(problem));
    return { models, builtins, custom, problems };
  };
  let current = await build();
  let catalog: readonly BuiltinModelRef[] | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const readConfig = async (): Promise<ModelsConfig> => {
    try {
      const raw = await readJson<unknown>(paths.models);
      return raw === undefined ? {} : parseConfig(ModelsConfigSchema, raw, FILE);
    } catch (error) {
      throw badConfig(error);
    }
  };

  return {
    models: () => current.models,
    credentials,
    customProviders: () => current.custom,
    builtinProviders: () => current.builtins,
    builtinCatalog: () => {
      catalog ??= builtinCatalog();
      return catalog;
    },
    problems: () => current.problems,
    providerConfigs: () => serial(async () => ({ ...(await readConfig()).providers })),
    setProviderConfig: (id, entry, keep = []) =>
      serial(async () => {
        const config = await readConfig();
        const providers = { ...config.providers };
        if (entry === undefined) delete providers[id];
        else providers[id] = entry;
        const next: ModelsConfig = { ...config, providers };
        try {
          parseConfig(ModelsConfigSchema, next, FILE);
        } catch (error) {
          throw badConfig(error);
        }
        const builtin = base(credentials).getProvider(id);
        let provider: Provider | undefined = builtin;
        if (entry !== undefined) {
          try {
            provider = composeProvider(id, builtin, entry);
          } catch (error) {
            throw new ProblemError({
              code: "bad_config",
              problems: [{ ...configIssue(error), file: FILE, entry: id }],
            });
          }
        }
        const left = new Set(provider?.getModels().map((m) => m.id) ?? []);
        const gone = keep.find((modelId) => !left.has(modelId));
        if (gone !== undefined) {
          throw new ProblemError({ code: "model_in_use", provider: id, modelId: gone });
        }
        await writeJsonAtomic(paths.models, next, { mode: 0o600 });
        current = await build();
      }),
    reload: () =>
      serial(async () => {
        current = await build();
      }),
  };
}

function describeBuiltin(provider: Provider): BuiltinProvider {
  const baseUrl = provider.baseUrl ?? provider.getModels()[0]?.baseUrl;
  return { name: provider.name, ...(baseUrl ? { baseUrl } : {}) };
}

function badConfig(error: unknown): ProblemError {
  if (error instanceof ProblemError) return error;
  const problems: ConfigProblem[] =
    error instanceof ConfigError ? [...error.problems] : [{ ...configIssue(error), file: FILE }];
  return new ProblemError({ code: "bad_config", problems });
}
