import type {
  ModelCost,
  ModelInputLimits,
  ModelInputModality,
  ModelPromptCache,
  SamplingParams,
  SamplingParamsByThinkingLevel,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { stripBom, stripJsonComments, stripJsonTrailingCommas } from "../shared/json.ts";

export type CompatConfig = Record<string, unknown>;

export type ModelEntryConfig = {
  readonly id: string;
  readonly name?: string;
  readonly api?: string;
  readonly baseUrl?: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  readonly input?: readonly ModelInputModality[];
  readonly inputLimits?: ModelInputLimits;
  readonly cost?: ModelCost;
  readonly promptCache?: ModelPromptCache;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly samplingParams?: SamplingParams;
  readonly samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
  readonly headers?: Readonly<Record<string, string>>;
  readonly compat?: CompatConfig;
};

export type ModelOverrideConfig = Omit<ModelEntryConfig, "id" | "api" | "baseUrl" | "cost"> & {
  readonly cost?: Partial<ModelCost>;
};

export type ProviderConfig = {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly api?: string;
  readonly oauth?: "radius";
  readonly headers?: Readonly<Record<string, string>>;
  readonly compat?: CompatConfig;
  readonly authHeader?: boolean;
  readonly models?: readonly ModelEntryConfig[];
  readonly modelOverrides?: Readonly<Record<string, ModelOverrideConfig>>;
};

export type ModelsConfig = {
  readonly providers: Readonly<Record<string, ProviderConfig>>;
};

export class ModelsConfigError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`models.json ${path}: ${message}`);
    this.name = "ModelsConfigError";
    this.path = path;
  }
}

const THINKING_LEVEL_KEYS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const INPUT_MODALITIES = new Set(["text", "image"]);

function fail(path: string, message: string): never {
  throw new ModelsConfigError(path, message);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function optString(source: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(`${path}.${key}`, "expected a string");
  return value;
}

function optBoolean(
  source: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(`${path}.${key}`, "expected a boolean");
  return value;
}

function optNumber(source: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path}.${key}`, "expected a finite number");
  }
  return value;
}

function optStringRecord(
  source: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, string> | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  const object = asObject(value, `${path}.${key}`);
  const record: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(object)) {
    if (typeof entryValue !== "string") {
      fail(`${path}.${key}.${entryKey}`, "expected a string");
    }
    record[entryKey] = entryValue;
  }
  return record;
}

function optJsonObject(
  source: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  return asObject(value, `${path}.${key}`);
}

function parseThinkingLevelMap(value: unknown, path: string): ThinkingLevelMap {
  const object = asObject(value, path);
  const map: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (!THINKING_LEVEL_KEYS.has(key)) fail(`${path}.${key}`, "unknown thinking level");
    if (typeof entry !== "string" && entry !== null) {
      fail(`${path}.${key}`, "expected a string or null");
    }
    map[key] = entry;
  }
  return map as ThinkingLevelMap;
}

function parseInput(value: unknown, path: string): ModelInputModality[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  const input: ModelInputModality[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index];
    if (typeof entry !== "string" || !INPUT_MODALITIES.has(entry)) {
      fail(`${path}[${index}]`, 'expected "text" or "image"');
    }
    input.push(entry as ModelInputModality);
  }
  return input;
}

function parseCostRates(
  value: unknown,
  path: string,
): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  const object = asObject(value, path);
  const rates: Record<string, number> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    const entry = object[key];
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      fail(`${path}.${key}`, "expected a finite number");
    }
    rates[key] = entry;
  }
  return rates as { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function parseCostTiers(tiersValue: unknown, path: string): ModelCost["tiers"] {
  if (!Array.isArray(tiersValue)) fail(path, "expected an array");
  return tiersValue.map((tier: unknown, index: number) => {
    const tierPath = `${path}[${index}]`;
    const tierObject = asObject(tier, tierPath);
    const threshold = tierObject.inputTokensAbove;
    if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
      fail(`${tierPath}.inputTokensAbove`, "expected a finite number");
    }
    return { ...parseCostRates(tierObject, tierPath), inputTokensAbove: threshold };
  });
}

function parseCost(value: unknown, path: string): ModelCost {
  const object = asObject(value, path);
  const rates = parseCostRates(object, path);
  const tiersValue = object.tiers;
  if (tiersValue === undefined) return rates;
  return { ...rates, tiers: parseCostTiers(tiersValue, `${path}.tiers`) };
}

function parsePartialCost(value: unknown, path: string): Partial<ModelCost> {
  const object = asObject(value, path);
  const rates: Partial<ModelCost> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const entry = object[key];
    if (entry === undefined) continue;
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      fail(`${path}.${key}`, "expected a finite number");
    }
    rates[key] = entry;
  }
  const tiersValue = object.tiers;
  if (tiersValue === undefined) return rates;
  return { ...rates, tiers: parseCostTiers(tiersValue, `${path}.tiers`) };
}

function parsePromptCache(value: unknown, path: string): ModelPromptCache {
  const object = asObject(value, path);
  const cache: { short?: number; long?: number } = {};
  for (const key of ["short", "long"] as const) {
    const entry = object[key];
    if (entry === undefined) continue;
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      fail(`${path}.${key}`, "expected a finite number");
    }
    cache[key] = entry;
  }
  return cache;
}

function parseInputLimits(value: unknown, path: string): ModelInputLimits {
  const object = asObject(value, path);
  const limits: {
    maxRequestBytes?: number;
    images?: {
      resize?: { maxWidth?: number; maxHeight?: number; maxBytes?: number; jpegQuality?: number };
      maxPerMessage?: number;
      maxPerRequest?: number;
    };
  } = {};
  const maxRequestBytes = optNumber(object, "maxRequestBytes", path);
  if (maxRequestBytes !== undefined) limits.maxRequestBytes = maxRequestBytes;
  const imagesValue = object.images;
  if (imagesValue !== undefined) {
    const imagesPath = `${path}.images`;
    const imagesObject = asObject(imagesValue, imagesPath);
    const images: NonNullable<ModelInputLimits["images"]> = {};
    const maxPerMessage = optNumber(imagesObject, "maxPerMessage", imagesPath);
    if (maxPerMessage !== undefined) images.maxPerMessage = maxPerMessage;
    const maxPerRequest = optNumber(imagesObject, "maxPerRequest", imagesPath);
    if (maxPerRequest !== undefined) images.maxPerRequest = maxPerRequest;
    const resizeValue = imagesObject.resize;
    if (resizeValue !== undefined) {
      const resizePath = `${imagesPath}.resize`;
      const resizeObject = asObject(resizeValue, resizePath);
      const resize: NonNullable<NonNullable<ModelInputLimits["images"]>["resize"]> = {};
      for (const key of ["maxWidth", "maxHeight", "maxBytes", "jpegQuality"] as const) {
        const entry = optNumber(resizeObject, key, resizePath);
        if (entry !== undefined) resize[key] = entry;
      }
      images.resize = resize;
    }
    limits.images = images;
  }
  return limits;
}

function parseModelFields(
  object: Record<string, unknown>,
  path: string,
  includeEndpoint: boolean,
  partial: boolean,
): Omit<ModelEntryConfig, "id"> {
  const result: {
    -readonly [K in keyof Omit<ModelEntryConfig, "id">]?: Omit<ModelEntryConfig, "id">[K];
  } = {};
  const name = optString(object, "name", path);
  if (name !== undefined) {
    if (name.length === 0) fail(`${path}.name`, "expected a non-empty string");
    result.name = name;
  }
  if (includeEndpoint) {
    const api = optString(object, "api", path);
    if (api !== undefined) {
      if (api.length === 0) fail(`${path}.api`, "expected a non-empty string");
      result.api = api;
    }
    const baseUrl = optString(object, "baseUrl", path);
    if (baseUrl !== undefined) {
      if (baseUrl.length === 0) fail(`${path}.baseUrl`, "expected a non-empty string");
      result.baseUrl = baseUrl;
    }
  }
  const reasoning = optBoolean(object, "reasoning", path);
  if (reasoning !== undefined) result.reasoning = reasoning;
  if (object.thinkingLevelMap !== undefined) {
    result.thinkingLevelMap = parseThinkingLevelMap(
      object.thinkingLevelMap,
      `${path}.thinkingLevelMap`,
    );
  }
  if (object.input !== undefined) result.input = parseInput(object.input, `${path}.input`);
  if (object.inputLimits !== undefined) {
    result.inputLimits = parseInputLimits(object.inputLimits, `${path}.inputLimits`);
  }
  if (object.cost !== undefined) {
    if (partial) {
      (result as { cost?: Partial<ModelCost> }).cost = parsePartialCost(
        object.cost,
        `${path}.cost`,
      );
    } else {
      result.cost = parseCost(object.cost, `${path}.cost`);
    }
  }
  if (object.promptCache !== undefined) {
    result.promptCache = parsePromptCache(object.promptCache, `${path}.promptCache`);
  }
  const contextWindow = optNumber(object, "contextWindow", path);
  if (contextWindow !== undefined) {
    if (contextWindow <= 0) fail(`${path}.contextWindow`, "expected a positive number");
    result.contextWindow = contextWindow;
  }
  const maxTokens = optNumber(object, "maxTokens", path);
  if (maxTokens !== undefined) {
    if (maxTokens <= 0) fail(`${path}.maxTokens`, "expected a positive number");
    result.maxTokens = maxTokens;
  }
  const samplingParams = optJsonObject(object, "samplingParams", path);
  if (samplingParams !== undefined) result.samplingParams = samplingParams as SamplingParams;
  const byLevel = optJsonObject(object, "samplingParamsByThinkingLevel", path);
  if (byLevel !== undefined) {
    for (const key of Object.keys(byLevel)) {
      if (!THINKING_LEVEL_KEYS.has(key)) {
        fail(`${path}.samplingParamsByThinkingLevel.${key}`, "unknown thinking level");
      }
      asObject(byLevel[key], `${path}.samplingParamsByThinkingLevel.${key}`);
    }
    result.samplingParamsByThinkingLevel = byLevel as SamplingParamsByThinkingLevel;
  }
  const headers = optStringRecord(object, "headers", path);
  if (headers !== undefined) result.headers = headers;
  const compat = optJsonObject(object, "compat", path);
  if (compat !== undefined) result.compat = compat;
  return result;
}

function parseModelEntry(value: unknown, path: string): ModelEntryConfig {
  const object = asObject(value, path);
  const id = object.id;
  if (typeof id !== "string" || id.length === 0) fail(`${path}.id`, "expected a non-empty string");
  return { id, ...parseModelFields(object, path, true, false) };
}

function parseProviderConfig(value: unknown, path: string): ProviderConfig {
  const object = asObject(value, path);
  const result: {
    -readonly [K in keyof ProviderConfig]?: ProviderConfig[K];
  } = {};
  const name = optString(object, "name", path);
  if (name !== undefined) result.name = name;
  const baseUrl = optString(object, "baseUrl", path);
  if (baseUrl !== undefined) result.baseUrl = baseUrl;
  const apiKey = optString(object, "apiKey", path);
  if (apiKey !== undefined) result.apiKey = apiKey;
  const api = optString(object, "api", path);
  if (api !== undefined) result.api = api;
  const oauth = object.oauth;
  if (oauth !== undefined) {
    if (oauth !== "radius") fail(`${path}.oauth`, 'expected "radius"');
    result.oauth = oauth;
  }
  const headers = optStringRecord(object, "headers", path);
  if (headers !== undefined) result.headers = headers;
  const compat = optJsonObject(object, "compat", path);
  if (compat !== undefined) result.compat = compat;
  const authHeader = optBoolean(object, "authHeader", path);
  if (authHeader !== undefined) result.authHeader = authHeader;
  const modelsValue = object.models;
  if (modelsValue !== undefined) {
    if (!Array.isArray(modelsValue)) fail(`${path}.models`, "expected an array");
    result.models = modelsValue.map((entry: unknown, index: number) =>
      parseModelEntry(entry, `${path}.models[${index}]`),
    );
  }
  const overridesValue = object.modelOverrides;
  if (overridesValue !== undefined) {
    const overridesPath = `${path}.modelOverrides`;
    const overridesObject = asObject(overridesValue, overridesPath);
    const overrides: Record<string, ModelOverrideConfig> = {};
    for (const [modelId, override] of Object.entries(overridesObject)) {
      overrides[modelId] = parseModelFields(
        asObject(override, `${overridesPath}.${modelId}`),
        `${overridesPath}.${modelId}`,
        false,
        true,
      );
    }
    result.modelOverrides = overrides;
  }
  return result;
}

export function parseModelsConfig(text: string): ModelsConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonTrailingCommas(stripJsonComments(stripBom(text))));
  } catch (error) {
    throw new ModelsConfigError(
      "",
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = asObject(parsed, "");
  const providersValue = root.providers;
  if (providersValue === undefined) return { providers: {} };
  const providersObject = asObject(providersValue, "providers");
  const providers: Record<string, ProviderConfig> = {};
  for (const [providerId, providerValue] of Object.entries(providersObject)) {
    providers[providerId] = parseProviderConfig(providerValue, `providers.${providerId}`);
  }
  return { providers };
}
