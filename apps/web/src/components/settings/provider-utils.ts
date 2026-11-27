import {
  type ConnectionNote,
  describeProviderConnectionNote,
  type ImportProviderModelsRequest,
  type ProbedModel,
  type ProviderSummary,
  THINKING_LEVELS,
  type ThinkingLevel,
  type ThinkingLevelConfig,
  type ThinkingLevelRule,
  validateProviderBaseUrl,
} from "@eevee/protocol";
import { type LocaleKey, t } from "../../lib/i18n.ts";
import { isRecord } from "../../lib/object.ts";

const BASE_URL_ERROR_KEYS: Readonly<Record<string, LocaleKey>> = {
  "Base URL is required": "baseUrl.error.required",
  "Base URL must not have leading or trailing whitespace": "baseUrl.error.whitespace",
  "Base URL must be an absolute URL": "baseUrl.error.absolute",
  "Base URL must use http or https": "baseUrl.error.protocol",
  "Base URL must not contain credentials": "baseUrl.error.credentials",
  "Base URL must not contain a query string or fragment": "baseUrl.error.queryOrFragment",
};

export function defaultThinkingLevels(): ThinkingLevelConfig {
  return {
    off: { enabled: true },
    minimal: { enabled: true },
    low: { enabled: true },
    medium: { enabled: true },
    high: { enabled: true },
    xhigh: { enabled: false },
    max: { enabled: false },
  };
}

export function cloneThinkingLevels(value: ThinkingLevelConfig): ThinkingLevelConfig {
  return {
    off: { ...value.off },
    minimal: { ...value.minimal },
    low: { ...value.low },
    medium: { ...value.medium },
    high: { ...value.high },
    xhigh: { ...value.xhigh },
    max: { ...value.max },
  };
}

export function setThinkingRule(
  value: ThinkingLevelConfig,
  level: ThinkingLevel,
  rule: ThinkingLevelRule,
): ThinkingLevelConfig {
  return { ...value, [level]: rule } as ThinkingLevelConfig;
}

export function thinkingLevelsFromMap(value: unknown): ThinkingLevelConfig {
  const source =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const config = defaultThinkingLevels();
  for (const level of THINKING_LEVELS) {
    const raw = source[level];
    const extended = level === "xhigh" || level === "max";
    config[level] = {
      enabled: extended ? typeof raw === "string" : raw !== null,
      ...(typeof raw === "string" && raw !== level ? { mappedTo: raw } : {}),
    };
  }
  return config;
}

export function formatJson(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

export function parseJsonObject(text: string, label: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      t("providers.error.invalidJson", {
        label,
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  if (!isRecord(parsed)) throw new Error(t("providers.error.jsonObjectRequired", { label }));
  return parsed;
}

export function formatKeyValueLines(value: unknown): string {
  if (!isRecord(value)) return "";
  return Object.entries(value)
    .map(([key, entry]) => `${key}=${typeof entry === "string" ? entry : JSON.stringify(entry)}`)
    .join("\n");
}

export function parseKeyValueLines(
  text: string,
  label: string,
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) {
      throw new Error(t("providers.error.kvLineFormat", { label, row: index + 1 }));
    }
    const key = line.slice(0, equals).trim();
    if (!key) throw new Error(t("providers.error.kvMissingKey", { label, row: index + 1 }));
    result[key] = line.slice(equals + 1).trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseFiniteNumber(text: string, label: string): number {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(t("providers.error.requiredField", { label }));
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error(t("providers.error.numberRequired", { label }));
  return value;
}

export function validateBaseUrl(value: string): string | undefined {
  const err = validateProviderBaseUrl(value);
  if (err === undefined) return undefined;
  const key = BASE_URL_ERROR_KEYS[err];
  return key ? t(key) : err;
}

export function describeConnectionUrl(
  api: string | undefined,
  baseUrl: string | undefined,
): ConnectionNote | undefined {
  return describeProviderConnectionNote(baseUrl, api);
}

export function normalizeHeaderObject(
  value: Record<string, unknown>,
  label: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(t("providers.error.stringRequired", { label, key }));
    }
    result[key] = entry;
  }
  return result;
}

export function modelInputWithImage(image: boolean): ("text" | "image")[] {
  return image ? ["text", "image"] : ["text"];
}

export function toImportModelPayload(
  model: ProbedModel,
): ImportProviderModelsRequest["models"][number] {
  const trimmedName = model.name?.trim();
  return {
    id: model.id,
    ...(trimmedName ? { name: trimmedName } : {}),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.input === undefined ? {} : { input: [...model.input] }),
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
  };
}

export function filterProbedModels(
  models: readonly ProbedModel[],
  filter: string,
): readonly ProbedModel[] {
  const query = filter.trim().toLowerCase();
  if (!query) return models;
  return models.filter((model) => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query));
}

export function formatAuthMeta(provider: ProviderSummary, translate: typeof t = t): string {
  if (!provider.configured) return translate("providers.auth.notConfigured");
  const parts: string[] = [];
  parts.push(provider.authSource ?? provider.authType ?? translate("providers.auth.configured"));
  if (provider.authAccountLabel) parts.push(provider.authAccountLabel);
  if (provider.authPreview) parts.push(provider.authPreview);
  return parts.join(" · ");
}
