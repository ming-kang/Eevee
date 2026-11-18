import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type ConfigProblem, describeConfigProblem } from "../contracts/index.ts";
import { ConfigError } from "../shared/config.ts";
import type { EeveePaths } from "../shared/paths.ts";
import { FileCredentialStore } from "./auth-store.ts";
import { applyModelsConfig, loadModelsConfig } from "./models-config.ts";

export type ModelRuntime = {
  models: () => Models;
  credentials: FileCredentialStore;
  /** Providers successfully added or customized by models.json at the last load. */
  customProviders: () => ReadonlySet<string>;
  /** Problems found in models.json at the last load; the affected providers keep their built-in form. */
  problems: () => readonly ConfigProblem[];
  reload(): Promise<void>;
};

export async function createModelRuntime(paths: EeveePaths): Promise<ModelRuntime> {
  const credentials = new FileCredentialStore(paths.auth);
  const build = async () => {
    const models = builtinModels({ credentials });
    const problems: ConfigProblem[] = [];
    const custom = new Set<string>();
    try {
      problems.push(...applyModelsConfig(models, await loadModelsConfig(paths.models), custom));
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(...error.problems);
    }
    for (const problem of problems) console.error(describeConfigProblem(problem));
    return { models, custom, problems };
  };
  let current = await build();
  return {
    models: () => current.models,
    credentials,
    customProviders: () => current.custom,
    problems: () => current.problems,
    async reload() {
      current = await build();
    },
  };
}
