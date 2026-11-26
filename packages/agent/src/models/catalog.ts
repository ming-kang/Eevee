import type { Api, KnownApi, Model, ModelCost, Provider } from "@earendil-works/pi-ai";
import {
  builtinProviders,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { CompatSchemasByApi } from "@earendil-works/pi-ai/providers/compat-schema";
import type { ModelEntryConfig, ModelOverrideConfig } from "./model-config.ts";
import { CHAT_API_STREAMS } from "./provider-composer.ts";

export const SUPPORTED_CHAT_APIS: readonly KnownApi[] = Object.freeze(
  Object.keys(CHAT_API_STREAMS) as KnownApi[],
);

export type BuiltinProviderInfo = {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly models: readonly Model<KnownApi>[];
  readonly apis: readonly string[];
};

export function getBuiltinProviderIds(): readonly string[] {
  return [
    ...new Set([...getBuiltinProviders(), ...builtinProviders().map((provider) => provider.id)]),
  ];
}

export function isBuiltinProviderId(id: string): boolean {
  return getBuiltinProviderIds().includes(id);
}

export function getBuiltinProviderInfo(id: string): BuiltinProviderInfo | undefined {
  const provider: Provider | undefined = builtinProviders().find((entry) => entry.id === id);
  if (!provider) return undefined;
  const models = getBuiltinModels(
    id as Parameters<typeof getBuiltinModels>[0],
  ) as Model<KnownApi>[];
  return {
    id: provider.id,
    name: provider.name,
    ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
    models,
    apis: [...new Set(models.map((model) => model.api))],
  };
}

export function validateBaseUrl(value: string): string | undefined {
  if (value.trim().length === 0) return "Base URL is required";
  if (value !== value.trim()) return "Base URL must not have leading or trailing whitespace";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Base URL must be an absolute URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Base URL must use http or https";
  }
  if (url.username || url.password) return "Base URL must not contain credentials";
  if (url.search || url.hash) return "Base URL must not contain a query string or fragment";
  return undefined;
}

export function baseUrlPlaceholder(api: string | undefined): string {
  switch (api) {
    case "anthropic-messages":
      return "https://api.anthropic.com";
    case "azure-openai-responses":
      return "https://RESOURCE.openai.azure.com/openai/v1";
    case "google-generative-ai":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "google-vertex":
      return "https://REGION-aiplatform.googleapis.com/v1";
    case "bedrock-converse-stream":
      return "https://bedrock-runtime.REGION.amazonaws.com";
    default:
      return "https://api.example.com/v1";
  }
}

function previewCatalogUrl(baseUrl: string, api?: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (api === "anthropic-messages" && !/\/v1(?:\/anthropic)?$/i.test(path)) {
    url.pathname = `${path}/v1/models`.replace(/^\/\//, "/");
  } else {
    url.pathname = `${path}/models`.replace(/^\/\//, "/");
  }
  return url;
}

export function describeConnectionUrl(
  api: string | undefined,
  baseUrl: string | undefined,
): { readonly text: string; readonly warning?: boolean } | undefined {
  if (baseUrl === undefined || validateBaseUrl(baseUrl) !== undefined) return undefined;
  const url = previewCatalogUrl(baseUrl, api);
  const doubledV1 = /\/v1\/v1(?:\/|$)/i.test(url.pathname);
  return {
    text: url.toString(),
    ...(doubledV1 ? { warning: true } : {}),
  };
}

export type CompatFieldInfo = {
  readonly key: string;
  readonly kind: "boolean" | "enum" | "number" | "stringMap" | "json";
  readonly options?: readonly string[];
  readonly note?: string;
};

type JsonSchemaShape = {
  readonly type?: string;
  readonly const?: unknown;
  readonly anyOf?: readonly JsonSchemaShape[];
  readonly properties?: Readonly<Record<string, JsonSchemaShape>>;
  readonly patternProperties?: Readonly<Record<string, JsonSchemaShape>>;
  readonly description?: string;
};

function enumOptions(schema: JsonSchemaShape): readonly string[] | undefined {
  const choices = schema.anyOf ?? [schema];
  const values = choices.map((choice) => choice.const);
  return values.length > 0 && values.every((value) => typeof value === "string")
    ? (values as string[])
    : undefined;
}

export function compatFieldsForApi(api: string): readonly CompatFieldInfo[] {
  const schema = (CompatSchemasByApi as Readonly<Record<string, JsonSchemaShape>>)[api];
  if (!schema?.properties) return [];
  return Object.entries(schema.properties).map(([key, field]) => {
    const options = enumOptions(field);
    const kind: CompatFieldInfo["kind"] = options
      ? "enum"
      : field.type === "boolean"
        ? "boolean"
        : field.type === "number" || field.type === "integer"
          ? "number"
          : field.type === "object" && field.patternProperties
            ? "stringMap"
            : "json";
    return {
      key,
      kind,
      ...(options ? { options } : {}),
      ...(field.description ? { note: field.description } : {}),
    };
  });
}

export type BuiltinModelMatch = {
  readonly model: Model<KnownApi>;
  readonly providerId: string;
  readonly tier: "exact" | "normalized" | "fuzzy";
  readonly score: number;
};

function normalizedModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function fuzzyScore(query: string, candidate: string): number {
  if (!query) return 0;
  if (candidate === query) return 10_000;
  const substring = candidate.indexOf(query);
  if (substring >= 0) return 5_000 - substring * 10 - (candidate.length - query.length);
  let queryIndex = 0;
  let gaps = 0;
  let previous = -2;
  for (let index = 0; index < candidate.length && queryIndex < query.length; index++) {
    if (candidate[index] !== query[queryIndex]) continue;
    if (previous !== index - 1) gaps++;
    previous = index;
    queryIndex++;
  }
  return queryIndex === query.length ? 1_000 - gaps * 20 - candidate.length : 0;
}

export function matchBuiltinModels(
  query: string,
  preferredApi?: string,
  max = 10,
): readonly BuiltinModelMatch[] {
  if (max <= 0) return [];
  const trimmed = query.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  const normalized = normalizedModelName(trimmed);
  const matches: BuiltinModelMatch[] = [];

  for (const providerId of getBuiltinProviders()) {
    const models = getBuiltinModels(providerId) as Model<KnownApi>[];
    for (const model of models) {
      const id = model.id.toLowerCase();
      const name = model.name.toLowerCase();
      const normalizedId = normalizedModelName(model.id);
      const tier =
        id === lower || name === lower
          ? "exact"
          : normalizedId === normalized || normalizedModelName(model.name) === normalized
            ? "normalized"
            : "fuzzy";
      const score = Math.max(
        fuzzyScore(lower, id),
        fuzzyScore(lower, name),
        fuzzyScore(normalized, normalizedId),
      );
      if (tier === "fuzzy" && score <= 0) continue;
      matches.push({
        model,
        providerId,
        tier,
        score: score + (model.api === preferredApi ? 100 : 0),
      });
    }
  }

  const tierRank = { exact: 0, normalized: 1, fuzzy: 2 };
  return matches
    .sort(
      (left, right) =>
        tierRank[left.tier] - tierRank[right.tier] ||
        right.score - left.score ||
        left.model.id.localeCompare(right.model.id),
    )
    .slice(0, max);
}

export type BuiltinFieldDiff = {
  readonly field: string;
  readonly applicable: boolean;
  readonly checked: boolean;
  readonly same: boolean;
  readonly currentText: string;
  readonly referenceText: string;
  readonly value?: unknown;
};

function withoutCostTiers(cost: Partial<ModelCost> | undefined): Partial<ModelCost> | undefined {
  if (!cost) return undefined;
  return {
    ...(cost.input === undefined ? {} : { input: cost.input }),
    ...(cost.output === undefined ? {} : { output: cost.output }),
    ...(cost.cacheRead === undefined ? {} : { cacheRead: cost.cacheRead }),
    ...(cost.cacheWrite === undefined ? {} : { cacheWrite: cost.cacheWrite }),
  };
}

function diffText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function computeBuiltinFieldDiffs(
  current: Partial<Model<Api>> | ModelEntryConfig | ModelOverrideConfig,
  referenceModel: Model<Api>,
  effectiveApi: string,
): readonly BuiltinFieldDiff[] {
  const source = current as Readonly<Record<string, unknown>>;
  const reference = referenceModel as unknown as Readonly<Record<string, unknown>>;
  const fields = [
    "name",
    "reasoning",
    "contextWindow",
    "maxTokens",
    "input",
    "inputLimits",
    "cost",
    "promptCache",
    "samplingParams",
    "samplingParamsByThinkingLevel",
    "thinkingLevelMap",
    "compat",
  ] as const;

  return fields.map((field) => {
    const apiSpecific = field === "thinkingLevelMap" || field === "compat";
    const applicable = !apiSpecific || effectiveApi === referenceModel.api;
    const currentValue =
      field === "cost"
        ? withoutCostTiers(source.cost as Partial<ModelCost> | undefined)
        : source[field];
    const referenceValue =
      field === "cost" ? withoutCostTiers(referenceModel.cost) : reference[field];
    const same = applicable && isDeepEqual(currentValue, referenceValue);
    return {
      field,
      applicable,
      checked: applicable && !same && currentValue === undefined && referenceValue !== undefined,
      same,
      currentText: diffText(currentValue),
      referenceText: applicable ? diffText(referenceValue) : "",
      ...(applicable && referenceValue !== undefined ? { value: referenceValue } : {}),
    };
  });
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => isDeepEqual(entry, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightRecord, key) && isDeepEqual(leftRecord[key], rightRecord[key]),
    )
  );
}
