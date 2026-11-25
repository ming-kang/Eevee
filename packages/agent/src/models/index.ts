import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

export const AUTH_FILE = "auth.json";
export const MODELS_FILE = "models.json";
export const MODELS_STORE_FILE = "models-store.json";

export type ModelChoice = ModelRef & {
  readonly thinkingLevel?: ModelThinkingLevel;
};
