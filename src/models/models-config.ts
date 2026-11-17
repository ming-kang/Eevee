import type { MutableModels } from "@earendil-works/pi-ai";
import { readJson } from "../shared/fs.ts";

export type ModelOverride = {
  contextWindow?: number;
  maxTokens?: number;
  promptCache?: { short?: number; long?: number };
};

export type ProviderConfig = {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  modelOverrides?: Record<string, ModelOverride>;
};

export type ModelsConfig = {
  providers?: Record<string, ProviderConfig>;
};

export async function loadModelsConfig(path: string): Promise<ModelsConfig> {
  return (await readJson<ModelsConfig>(path)) ?? {};
}

export function applyModelsConfig(_models: MutableModels, config: ModelsConfig): void {
  if (Object.keys(config.providers ?? {}).length === 0) return;
}
