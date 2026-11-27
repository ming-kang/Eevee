import {
  type ModelChoice,
  type ModelInfo,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@eevee/protocol";
import type { LocaleKey } from "./i18n.ts";

export const PINNED_MODELS_STORAGE_KEY = "eevee-pinned-models";

export function modelKey(choice: { readonly provider: string; readonly modelId: string }): string {
  return `${choice.provider}/${choice.modelId}`;
}

export function modelInfoKey(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function sameModelChoice(
  a: { readonly provider: string; readonly modelId?: string; readonly id?: string } | undefined,
  b: { readonly provider: string; readonly modelId?: string; readonly id?: string } | undefined,
): boolean {
  if (!a || !b) return false;
  const aId = a.modelId ?? a.id;
  const bId = b.modelId ?? b.id;
  return a.provider === b.provider && aId !== undefined && aId === bId;
}

export function findModelInfo(
  models: readonly ModelInfo[],
  choice: ModelChoice | undefined,
): ModelInfo | undefined {
  if (!choice) return undefined;
  return models.find((m) => m.provider === choice.provider && m.id === choice.modelId);
}

export function supportedThinkingLevelsOf(
  models: readonly ModelInfo[],
  choice: ModelChoice | undefined,
): readonly ThinkingLevel[] {
  const info = findModelInfo(models, choice);
  if (!info) return [];
  if (info.supportedThinkingLevels && info.supportedThinkingLevels.length > 0) {
    return info.supportedThinkingLevels;
  }
  return info.reasoning ? THINKING_LEVELS : [];
}

export function switchModelChoice(
  current: ModelChoice | undefined,
  nextModel: ModelInfo,
): ModelChoice {
  const levels =
    nextModel.supportedThinkingLevels && nextModel.supportedThinkingLevels.length > 0
      ? nextModel.supportedThinkingLevels
      : nextModel.reasoning
        ? THINKING_LEVELS
        : [];
  const prevLevel = current?.thinkingLevel;
  const keepLevel =
    prevLevel !== undefined && levels.length > 0 && levels.includes(prevLevel)
      ? prevLevel
      : undefined;
  return {
    provider: nextModel.provider,
    modelId: nextModel.id,
    ...(keepLevel === undefined ? {} : { thinkingLevel: keepLevel }),
  };
}

export function withThinkingLevel(
  choice: ModelChoice,
  level: ThinkingLevel | undefined,
): ModelChoice {
  return {
    provider: choice.provider,
    modelId: choice.modelId,
    ...(level === undefined ? {} : { thinkingLevel: level }),
  };
}

export function groupModelsByProvider(
  models: readonly ModelInfo[],
  query: string,
): readonly (readonly [string, readonly ModelInfo[]])[] {
  const needle = query.trim().toLowerCase();
  const byProvider = new Map<string, ModelInfo[]>();
  for (const model of models) {
    if (needle.length > 0) {
      const hay = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    const bucket = byProvider.get(model.provider);
    if (bucket) bucket.push(model);
    else byProvider.set(model.provider, [model]);
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, list]) => [
      provider,
      list.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    ]);
}

export function readPinnedModelKeys(storage?: Pick<Storage, "getItem">): string[] {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  try {
    const raw = store?.getItem(PINNED_MODELS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.includes("/"));
  } catch {
    return [];
  }
}

export function writePinnedModelKeys(
  keys: readonly string[],
  storage?: Pick<Storage, "setItem">,
): void {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  try {
    store?.setItem(PINNED_MODELS_STORAGE_KEY, JSON.stringify(keys));
  } catch {}
}

export function togglePinnedKey(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key];
}

export function resolvePinnedModels(
  keys: readonly string[],
  models: readonly ModelInfo[],
): ModelInfo[] {
  const byKey = new Map(models.map((m) => [modelInfoKey(m), m]));
  const out: ModelInfo[] = [];
  for (const key of keys) {
    const found = byKey.get(key);
    if (found) out.push(found);
  }
  return out;
}

export function thinkingLevelLocaleKey(level: ThinkingLevel): LocaleKey {
  switch (level) {
    case "off":
      return "modelMenu.thinking.off";
    case "minimal":
      return "modelMenu.thinking.minimal";
    case "low":
      return "modelMenu.thinking.low";
    case "medium":
      return "modelMenu.thinking.medium";
    case "high":
      return "modelMenu.thinking.high";
    case "xhigh":
      return "modelMenu.thinking.xhigh";
    case "max":
      return "modelMenu.thinking.max";
  }
}
