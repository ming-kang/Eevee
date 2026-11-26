import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const ALL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const DEFAULT_ENABLED_LEVELS = new Set(["off", "minimal", "low", "medium", "high"]);
export const OPENAI_RESPONSES_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

export type ThinkingLevelRule = {
  readonly enabled: boolean;
  readonly mappedTo?: string;
  readonly inherited?: boolean;
};

export type ThinkingLevelConfig = Record<ModelThinkingLevel, ThinkingLevelRule>;

export type EncodeThinkingLevelOptions = {
  readonly builtinMap?: ThinkingLevelMap;
  readonly api?: string;
};

export function decodeThinkingLevelConfig(
  effectiveMap: ThinkingLevelMap | undefined,
  builtinMap?: ThinkingLevelMap,
  ownMap?: ThinkingLevelMap,
): ThinkingLevelConfig {
  const config = {} as ThinkingLevelConfig;
  for (const level of ALL_THINKING_LEVELS) {
    const value = effectiveMap?.[level];
    const extended = level === "xhigh" || level === "max";
    const rule: ThinkingLevelRule = {
      enabled: extended ? typeof value === "string" : value !== null,
      ...(typeof value === "string" && value !== level ? { mappedTo: value } : {}),
      ...(builtinMap === undefined
        ? {}
        : { inherited: ownMap === undefined || ownMap[level] === undefined }),
    };
    config[level] = rule;
  }
  return config;
}

export function encodeThinkingLevelConfig(
  config: ThinkingLevelConfig,
  opts?: EncodeThinkingLevelOptions,
): ThinkingLevelMap | undefined {
  const encoded: Record<string, string | null> = {};
  const hasBaseline = opts?.builtinMap !== undefined;

  for (const level of ALL_THINKING_LEVELS) {
    const rule = config[level];
    const builtinValue = opts?.builtinMap?.[level];
    const extended = level === "xhigh" || level === "max";

    if (!rule.enabled) {
      if (extended) {
        if (typeof builtinValue === "string") encoded[level] = null;
      } else if (!hasBaseline || builtinValue !== null) {
        encoded[level] = null;
      }
      continue;
    }

    const mappedTo = rule.mappedTo?.trim();
    if (mappedTo) {
      const target =
        level === "off" && mappedTo === "off" && OPENAI_RESPONSES_APIS.has(opts?.api ?? "")
          ? "none"
          : mappedTo;
      if (builtinValue !== target) encoded[level] = target;
      continue;
    }

    if (extended) {
      if (builtinValue !== level) encoded[level] = level;
      continue;
    }

    if (level !== "off") {
      if (hasBaseline && builtinValue !== undefined && builtinValue !== level) {
        encoded[level] = level;
      }
      continue;
    }

    const requiresOverride =
      hasBaseline && (builtinValue === null || typeof builtinValue === "string");
    if (!requiresOverride) continue;
    encoded[level] = OPENAI_RESPONSES_APIS.has(opts?.api ?? "") ? "none" : "";
  }

  return Object.keys(encoded).length === 0 ? undefined : (encoded as ThinkingLevelMap);
}

export function normalizeThinkingLevelMapForRuntime(
  base: ThinkingLevelMap | undefined,
  override: ThinkingLevelMap | undefined,
): ThinkingLevelMap | undefined {
  if (base === undefined && override === undefined) return undefined;
  const merged: Record<string, string | null> = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (key === "off" && value === "") {
      delete merged.off;
    } else {
      merged[key] = value;
    }
  }
  if (merged.off === "") delete merged.off;
  return Object.keys(merged).length === 0 ? undefined : (merged as ThinkingLevelMap);
}
