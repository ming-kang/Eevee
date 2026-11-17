import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { EeveePaths } from "../shared/paths.ts";
import { FileCredentialStore } from "./auth-store.ts";
import { applyModelsConfig, loadModelsConfig } from "./models-config.ts";

export type ModelRuntime = {
  models: () => Models;
  credentials: FileCredentialStore;
  reload(): Promise<void>;
};

export async function createModelRuntime(paths: EeveePaths): Promise<ModelRuntime> {
  const credentials = new FileCredentialStore(paths.auth);
  const build = async () => {
    const models = builtinModels({ credentials });
    applyModelsConfig(models, await loadModelsConfig(paths.models));
    return models;
  };
  let current = await build();
  return {
    models: () => current,
    credentials,
    async reload() {
      current = await build();
    },
  };
}
