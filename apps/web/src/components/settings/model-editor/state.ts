import type {
  BuiltinFieldDiff,
  CompatFieldInfo,
  ModelDetail,
  ThinkingLevelConfig,
  UpsertProviderModelRequest,
} from "@eevee/protocol";
import { t } from "../../../lib/i18n.ts";
import { deepEqualJson, isRecord } from "../../../lib/object.ts";
import {
  cloneThinkingLevels,
  defaultThinkingLevels,
  formatJson,
  formatKeyValueLines,
  modelInputWithImage,
  normalizeHeaderObject,
  parseFiniteNumber,
  parseJsonObject,
  parseKeyValueLines,
  thinkingLevelsFromMap,
} from "../provider-utils.ts";

export const ADVANCED_KEYS = [
  "headers",
  "samplingParams",
  "promptCache",
  "inputLimits",
  "samplingParamsByThinkingLevel",
] as const;

export type AdvancedKey = (typeof ADVANCED_KEYS)[number];
export type AdvancedTextState = Record<AdvancedKey, string>;

export type ModelEditorTarget = {
  readonly providerId: string;
  readonly providerApi?: string;
  readonly providerBaseUrl?: string;
  readonly model?: ModelDetail;
};

export type ModelEditorDraft = {
  readonly modelId: string;
  readonly name: string;
  readonly apiValue: string;
  readonly baseUrlValue: string;
  readonly apiTouched: boolean;
  readonly baseUrlTouched: boolean;
  readonly contextWindow: string;
  readonly maxTokens: string;
  readonly reasoning: boolean;
  readonly imageInput: boolean;
  readonly costInput: string;
  readonly costOutput: string;
  readonly costCacheRead: string;
  readonly costCacheWrite: string;
  readonly thinkingLevels: ThinkingLevelConfig;
  readonly compatValues: Record<string, unknown>;
  readonly compatText: Record<string, string>;
  readonly compatTouched: Record<string, boolean>;
  readonly advancedText: AdvancedTextState;
};

export type ModelEditorPatch = Partial<
  Pick<
    ModelEditorDraft,
    | "modelId"
    | "name"
    | "apiValue"
    | "baseUrlValue"
    | "apiTouched"
    | "baseUrlTouched"
    | "contextWindow"
    | "maxTokens"
    | "reasoning"
    | "imageInput"
    | "costInput"
    | "costOutput"
    | "costCacheRead"
    | "costCacheWrite"
    | "thinkingLevels"
  >
>;

export type ModelEditorAction =
  | { readonly type: "reset"; readonly draft: ModelEditorDraft }
  | { readonly type: "patch"; readonly patch: ModelEditorPatch }
  | {
      readonly type: "setCompatBoolean";
      readonly key: string;
      readonly enabled: boolean | undefined;
    }
  | { readonly type: "setCompatEnum"; readonly key: string; readonly value: string }
  | { readonly type: "setCompatText"; readonly key: string; readonly value: string }
  | { readonly type: "setAdvancedText"; readonly key: AdvancedKey; readonly value: string }
  | {
      readonly type: "applyCandidateDiffs";
      readonly diffs: readonly BuiltinFieldDiff[];
      readonly compatFields: readonly CompatFieldInfo[];
    };

export function serializeCompatField(field: CompatFieldInfo, value: unknown): string {
  if (value === undefined) return "";
  if (field.kind === "number") return typeof value === "number" ? String(value) : String(value);
  if (field.kind === "enum") return typeof value === "string" ? value : String(value);
  if (field.kind === "stringMap") return formatKeyValueLines(value) || formatJson(value);
  if (field.kind === "json") return formatJson(value);
  return "";
}

export function isCompatFieldConfigured(
  field: CompatFieldInfo,
  draft: Pick<ModelEditorDraft, "compatValues" | "compatText">,
): boolean {
  const value = draft.compatValues[field.key];
  if (field.kind === "boolean") return typeof value === "boolean";
  if (field.kind === "enum") return typeof value === "string" && value.length > 0;
  const text = draft.compatText[field.key] ?? serializeCompatField(field, value);
  return text.trim().length > 0;
}

export function filterCompatFields(
  fields: readonly CompatFieldInfo[],
  query: string,
  onlyConfigured: boolean,
  draft: Pick<ModelEditorDraft, "compatValues" | "compatText">,
): readonly CompatFieldInfo[] {
  const needle = query.trim().toLowerCase();
  return fields.filter((field) => {
    if (onlyConfigured && !isCompatFieldConfigured(field, draft)) return false;
    if (!needle) return true;
    return (
      field.key.toLowerCase().includes(needle) ||
      (field.note?.toLowerCase().includes(needle) ?? false)
    );
  });
}

function initialAdvancedText(model: ModelDetail | undefined): AdvancedTextState {
  return {
    headers: formatJson(model?.headers),
    samplingParams: formatJson(model?.samplingParams),
    promptCache: formatJson(model?.promptCache),
    inputLimits: formatJson(model?.inputLimits),
    samplingParamsByThinkingLevel: formatJson(model?.samplingParamsByThinkingLevel),
  };
}

function initialCompatText(
  model: ModelDetail | undefined,
  effectiveApi: string,
  compatSchemas: Readonly<Record<string, readonly CompatFieldInfo[]>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const compat = isRecord(model?.compat) ? model.compat : undefined;
  for (const field of compatSchemas[effectiveApi] ?? []) {
    result[field.key] = serializeCompatField(field, compat?.[field.key]);
  }
  return result;
}

function removeKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = { ...value };
  delete next[key];
  return next;
}

function costNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function createModelEditorDraft(
  target: ModelEditorTarget,
  compatSchemas: Readonly<Record<string, readonly CompatFieldInfo[]>>,
): ModelEditorDraft {
  const model = target.model;
  const effectiveApi = model?.api ?? target.providerApi ?? "";
  const apiValue =
    model?.isCustom && model.api && model.api !== target.providerApi ? model.api : "";
  const baseUrlValue =
    model?.isCustom && model.baseUrl && model.baseUrl !== target.providerBaseUrl
      ? model.baseUrl
      : "";
  return {
    modelId: model?.id ?? "",
    name: model?.name ?? "",
    apiValue,
    baseUrlValue,
    apiTouched: false,
    baseUrlTouched: false,
    contextWindow: String(model?.contextWindow ?? 128000),
    maxTokens: String(model?.maxTokens ?? 8192),
    reasoning: model?.reasoning ?? false,
    imageInput: model?.input.includes("image") ?? false,
    costInput: String(model?.cost.input ?? 0),
    costOutput: String(model?.cost.output ?? 0),
    costCacheRead: String(model?.cost.cacheRead ?? 0),
    costCacheWrite: String(model?.cost.cacheWrite ?? 0),
    thinkingLevels: model ? cloneThinkingLevels(model.thinkingLevels) : defaultThinkingLevels(),
    compatValues: { ...(model?.compat ?? {}) },
    compatText: initialCompatText(model, effectiveApi, compatSchemas),
    compatTouched: {},
    advancedText: initialAdvancedText(model),
  };
}

export function applyCandidateDiffs(
  draft: ModelEditorDraft,
  diffs: readonly BuiltinFieldDiff[],
  compatFields: readonly CompatFieldInfo[],
): ModelEditorDraft {
  let next = draft;
  for (const diff of diffs) {
    if (!diff.applicable) continue;
    const value = diff.value;
    if (diff.field === "name" && typeof value === "string") {
      next = { ...next, name: value };
    } else if (diff.field === "reasoning" && typeof value === "boolean") {
      next = { ...next, reasoning: value };
    } else if (diff.field === "contextWindow" && typeof value === "number") {
      next = { ...next, contextWindow: String(value) };
    } else if (diff.field === "maxTokens" && typeof value === "number") {
      next = { ...next, maxTokens: String(value) };
    } else if (diff.field === "input" && Array.isArray(value)) {
      next = { ...next, imageInput: value.includes("image") };
    } else if (diff.field === "cost" && isRecord(value)) {
      const input = costNumber(value.input);
      const output = costNumber(value.output);
      const cacheRead = costNumber(value.cacheRead);
      const cacheWrite = costNumber(value.cacheWrite);
      next = {
        ...next,
        ...(input === undefined ? {} : { costInput: String(input) }),
        ...(output === undefined ? {} : { costOutput: String(output) }),
        ...(cacheRead === undefined ? {} : { costCacheRead: String(cacheRead) }),
        ...(cacheWrite === undefined ? {} : { costCacheWrite: String(cacheWrite) }),
      };
    } else if (diff.field === "thinkingLevelMap") {
      next = { ...next, thinkingLevels: thinkingLevelsFromMap(value) };
    } else if (diff.field === "compat") {
      const nextCompat = isRecord(value) ? { ...value } : {};
      const nextCompatText: Record<string, string> = {};
      for (const field of compatFields) {
        nextCompatText[field.key] = serializeCompatField(field, nextCompat[field.key]);
      }
      next = {
        ...next,
        compatValues: nextCompat,
        compatText: nextCompatText,
        compatTouched: {},
      };
    } else if (
      diff.field === "inputLimits" ||
      diff.field === "promptCache" ||
      diff.field === "samplingParams" ||
      diff.field === "samplingParamsByThinkingLevel"
    ) {
      next = {
        ...next,
        advancedText: {
          ...next.advancedText,
          [diff.field]: formatJson(value),
        },
      };
    }
  }
  return next;
}

export function modelEditorReducer(
  state: ModelEditorDraft,
  action: ModelEditorAction,
): ModelEditorDraft {
  switch (action.type) {
    case "reset":
      return action.draft;
    case "patch":
      return { ...state, ...action.patch };
    case "setCompatBoolean":
      return {
        ...state,
        compatTouched: { ...state.compatTouched, [action.key]: true },
        compatValues:
          action.enabled === undefined
            ? removeKey(state.compatValues, action.key)
            : { ...state.compatValues, [action.key]: action.enabled },
      };
    case "setCompatEnum":
      return {
        ...state,
        compatTouched: { ...state.compatTouched, [action.key]: true },
        compatValues: action.value
          ? { ...state.compatValues, [action.key]: action.value }
          : removeKey(state.compatValues, action.key),
      };
    case "setCompatText":
      return {
        ...state,
        compatTouched: { ...state.compatTouched, [action.key]: true },
        compatText: { ...state.compatText, [action.key]: action.value },
      };
    case "setAdvancedText":
      return {
        ...state,
        advancedText: { ...state.advancedText, [action.key]: action.value },
      };
    case "applyCandidateDiffs":
      return applyCandidateDiffs(state, action.diffs, action.compatFields);
  }
}

type CostKey = "input" | "output" | "cacheRead" | "cacheWrite";

function buildCompatPayload(
  draft: ModelEditorDraft,
  compatFields: readonly CompatFieldInfo[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...draft.compatValues };
  for (const field of compatFields) {
    if (draft.compatTouched[field.key] !== true) continue;
    const raw = draft.compatText[field.key] ?? serializeCompatField(field, next[field.key]);
    if (field.kind === "boolean") {
      if (typeof next[field.key] === "boolean") continue;
      delete next[field.key];
    } else if (field.kind === "enum") {
      const value = next[field.key];
      if (typeof value === "string" && value) continue;
      delete next[field.key];
    } else if (!raw.trim()) {
      delete next[field.key];
    } else if (field.kind === "number") {
      next[field.key] = parseFiniteNumber(raw, `compat.${field.key}`);
    } else if (field.kind === "stringMap") {
      const parsed = parseKeyValueLines(raw, `compat.${field.key}`);
      if (parsed) next[field.key] = parsed;
      else delete next[field.key];
    } else {
      const parsed = parseJsonObject(raw, `compat.${field.key}`);
      if (parsed) next[field.key] = parsed;
      else delete next[field.key];
    }
  }
  return next;
}

export function hasModelDraftChanges(
  target: ModelEditorTarget,
  draft: ModelEditorDraft,
  compatFields: readonly CompatFieldInfo[],
): boolean {
  if (target.model === undefined) return true;
  try {
    return Object.keys(buildModelUpsertRequest(target, draft, compatFields)).length > 0;
  } catch {
    return true;
  }
}

export function buildModelUpsertRequest(
  target: ModelEditorTarget,
  draft: ModelEditorDraft,
  compatFields: readonly CompatFieldInfo[],
): UpsertProviderModelRequest {
  const model = target.model;
  const isCreate = model === undefined;
  const isCustom = isCreate || model.isCustom;
  const effectiveApi = (draft.apiValue.trim() || model?.api || target.providerApi || "").trim();

  const trimmedId = draft.modelId.trim();
  if (!trimmedId) throw new Error(t("modelEditor.error.emptyId"));
  if (isCreate && !effectiveApi) throw new Error(t("modelEditor.error.missingApi"));

  const nextContextWindow = parseFiniteNumber(
    draft.contextWindow,
    t("modelEditor.error.contextWindow"),
  );
  const nextMaxTokens = parseFiniteNumber(draft.maxTokens, t("modelEditor.error.maxTokens"));
  const fullCost: Record<CostKey, number> = {
    input: parseFiniteNumber(draft.costInput, t("modelEditor.error.costInput")),
    output: parseFiniteNumber(draft.costOutput, t("modelEditor.error.costOutput")),
    cacheRead: parseFiniteNumber(draft.costCacheRead, t("modelEditor.error.costCacheRead")),
    cacheWrite: parseFiniteNumber(draft.costCacheWrite, t("modelEditor.error.costCacheWrite")),
  };

  const input: UpsertProviderModelRequest = {};
  if (isCreate) input.id = trimmedId;

  const trimmedName = draft.name.trim();
  if (isCreate) input.name = trimmedName || trimmedId;
  else if (trimmedName !== (model?.name ?? "")) input.name = trimmedName ? trimmedName : null;

  if (isCustom) {
    const trimmedApi = draft.apiValue.trim();
    const trimmedBaseUrl = draft.baseUrlValue.trim();
    if (isCreate) {
      if (trimmedApi) input.api = trimmedApi;
      if (trimmedBaseUrl) input.baseUrl = trimmedBaseUrl;
    } else {
      if (draft.apiTouched) input.api = trimmedApi ? trimmedApi : null;
      if (draft.baseUrlTouched) input.baseUrl = trimmedBaseUrl ? trimmedBaseUrl : null;
    }
  }

  if (isCreate || draft.reasoning !== model?.reasoning) input.reasoning = draft.reasoning;
  const initialInput = model?.input ?? ["text"];
  const nextInput = modelInputWithImage(draft.imageInput);
  if (isCreate || !deepEqualJson(nextInput, initialInput)) input.input = nextInput;
  if (isCreate || nextContextWindow !== model?.contextWindow) {
    input.contextWindow = nextContextWindow;
  }
  if (isCreate || nextMaxTokens !== model?.maxTokens) input.maxTokens = nextMaxTokens;

  const initialCost: Record<CostKey, number> = {
    input: model?.cost.input ?? 0,
    output: model?.cost.output ?? 0,
    cacheRead: model?.cost.cacheRead ?? 0,
    cacheWrite: model?.cost.cacheWrite ?? 0,
  };
  const costChanged = !deepEqualJson(fullCost, initialCost);
  if (isCreate || (costChanged && isCustom)) {
    input.cost = fullCost;
  } else if (costChanged) {
    const patch: Partial<Record<CostKey, number>> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (!Object.is(fullCost[key], initialCost[key])) patch[key] = fullCost[key];
    }
    input.cost = patch;
  }

  if (isCreate || !deepEqualJson(draft.thinkingLevels, model?.thinkingLevels)) {
    input.thinkingLevels = draft.thinkingLevels;
  }

  const initialCompat = isRecord(model?.compat) ? model.compat : {};
  const nextCompat = buildCompatPayload(draft, compatFields);
  if (isCreate) {
    if (Object.keys(nextCompat).length > 0) input.compat = nextCompat;
  } else if (!deepEqualJson(nextCompat, initialCompat)) {
    input.compat = Object.keys(nextCompat).length > 0 ? nextCompat : null;
  }

  for (const key of ADVANCED_KEYS) {
    const parsed = parseJsonObject(draft.advancedText[key], key);
    const initialValue = model?.[key];
    if (isCreate) {
      if (parsed !== undefined) {
        if (key === "headers") input.headers = normalizeHeaderObject(parsed, "headers");
        else input[key] = parsed;
      }
    } else if (!deepEqualJson(parsed, initialValue)) {
      if (parsed === undefined) input[key] = null;
      else if (key === "headers") input.headers = normalizeHeaderObject(parsed, "headers");
      else input[key] = parsed;
    }
  }

  return input;
}
