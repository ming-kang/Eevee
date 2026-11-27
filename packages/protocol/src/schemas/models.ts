import {
  arr,
  bool,
  int,
  lit,
  map,
  num,
  obj,
  oneOf,
  opt,
  type Static,
  str,
  unknown,
} from "@earendil-works/pi-schema";
import { ModelChoiceSchema, ThinkingLevelSchema } from "./common.ts";

export const InputModalitiesSchema = arr(oneOf(["text", "image"]));

export const ThinkingLevelRuleSchema = obj({
  enabled: bool(),
  mappedTo: opt(str()),
  inherited: opt(bool()),
});
export type ThinkingLevelRule = Static<typeof ThinkingLevelRuleSchema>;

export const ThinkingLevelConfigSchema = obj({
  off: ThinkingLevelRuleSchema,
  minimal: ThinkingLevelRuleSchema,
  low: ThinkingLevelRuleSchema,
  medium: ThinkingLevelRuleSchema,
  high: ThinkingLevelRuleSchema,
  xhigh: ThinkingLevelRuleSchema,
  max: ThinkingLevelRuleSchema,
});
export type ThinkingLevelConfig = Static<typeof ThinkingLevelConfigSchema>;

export const ModelsConfigDiagnosticSchema = obj({
  path: str(),
  message: str(),
  line: opt(int({ minimum: 1 })),
  column: opt(int({ minimum: 1 })),
});
export type ModelsConfigDiagnostic = Static<typeof ModelsConfigDiagnosticSchema>;

export const CompatFieldInfoSchema = obj({
  key: str({ minLength: 1 }),
  kind: oneOf(["boolean", "enum", "number", "stringMap", "json"]),
  options: opt(arr(str())),
  note: opt(str()),
});
export type CompatFieldInfo = Static<typeof CompatFieldInfoSchema>;

export const ModelCostTierSchema = obj({
  input: num(),
  output: num(),
  cacheRead: num(),
  cacheWrite: num(),
  inputTokensAbove: num(),
});
export type ModelCostTier = Static<typeof ModelCostTierSchema>;

export const ModelCostSchema = obj({
  input: num(),
  output: num(),
  cacheRead: num(),
  cacheWrite: num(),
  tiers: opt(arr(ModelCostTierSchema)),
});
export type ModelCostPayload = Static<typeof ModelCostSchema>;

export const ModelInfoSchema = obj({
  provider: str({ minLength: 1 }),
  id: str({ minLength: 1 }),
  name: str({ minLength: 1 }),
  api: str({ minLength: 1 }),
  reasoning: bool(),
  contextWindow: num({ minimum: 0 }),
  maxTokens: num({ minimum: 0 }),
  cost: ModelCostSchema,
  available: bool(),
  input: opt(InputModalitiesSchema),
  supportedThinkingLevels: opt(arr(ThinkingLevelSchema)),
  isCustom: opt(bool()),
  hasOverride: opt(bool()),
});
export type ModelInfo = Static<typeof ModelInfoSchema>;

export const ListModelsResponseSchema = obj({ models: arr(ModelInfoSchema) });
export type ListModelsResponse = Static<typeof ListModelsResponseSchema>;

export const RefreshModelsRequestSchema = obj({
  providers: opt(arr(str({ minLength: 1 }))),
  force: opt(bool()),
});
export type RefreshModelsRequest = Static<typeof RefreshModelsRequestSchema>;

export const RefreshModelsResponseSchema = obj({
  refreshed: lit(true),
  errors: map(str()),
});
export type RefreshModelsResponse = Static<typeof RefreshModelsResponseSchema>;

export const ConnectionNoteSchema = obj({ text: str(), warning: opt(bool()) });
export type ConnectionNote = Static<typeof ConnectionNoteSchema>;

export const ModelDetailSchema = obj({
  provider: str({ minLength: 1 }),
  id: str({ minLength: 1 }),
  name: str({ minLength: 1 }),
  api: str({ minLength: 1 }),
  baseUrl: str(),
  reasoning: bool(),
  input: InputModalitiesSchema,
  contextWindow: num({ minimum: 0 }),
  maxTokens: num({ minimum: 0 }),
  cost: ModelCostSchema,
  available: bool(),
  isCustom: bool(),
  isBuiltin: bool(),
  hasOverride: bool(),
  supportedThinkingLevels: arr(ThinkingLevelSchema),
  thinkingLevels: ThinkingLevelConfigSchema,
  headers: opt(map(str())),
  compat: opt(obj({}, { open: true })),
  promptCache: opt(obj({}, { open: true })),
  inputLimits: opt(obj({}, { open: true })),
  samplingParams: opt(obj({}, { open: true })),
  samplingParamsByThinkingLevel: opt(obj({}, { open: true })),
  override: opt(obj({}, { open: true })),
});
export type ModelDetail = Static<typeof ModelDetailSchema>;

export const BuiltinModelMatchRequestSchema = obj({
  query: opt(str()),
  limit: opt(int({ minimum: 1, maximum: 50 })),
});
export type BuiltinModelMatchRequest = Static<typeof BuiltinModelMatchRequestSchema>;

export const BuiltinFieldDiffSchema = obj({
  field: str(),
  applicable: bool(),
  checked: bool(),
  same: bool(),
  currentText: str(),
  referenceText: str(),
  value: unknown(),
});
export type BuiltinFieldDiff = Static<typeof BuiltinFieldDiffSchema>;

export const BuiltinModelCandidateSchema = obj({
  providerId: str({ minLength: 1 }),
  modelId: str({ minLength: 1 }),
  name: str({ minLength: 1 }),
  api: str({ minLength: 1 }),
  reasoning: bool(),
  contextWindow: num({ minimum: 0 }),
  maxTokens: num({ minimum: 0 }),
  input: InputModalitiesSchema,
  tier: oneOf(["exact", "normalized", "fuzzy"]),
  diffs: arr(BuiltinFieldDiffSchema),
});
export type BuiltinModelCandidate = Static<typeof BuiltinModelCandidateSchema>;

export const BuiltinModelMatchResponseSchema = obj({
  candidates: arr(BuiltinModelCandidateSchema),
});
export type BuiltinModelMatchResponse = Static<typeof BuiltinModelMatchResponseSchema>;

export const SmokeTestModelRequestSchema = obj({
  thinkingLevel: opt(ThinkingLevelSchema),
  testTools: opt(bool()),
  timeoutMs: opt(int({ minimum: 1000, maximum: 60000 })),
});
export type SmokeTestModelRequest = Static<typeof SmokeTestModelRequestSchema>;

export const SmokeTestModelResponseSchema = obj({
  ok: bool(),
  ttftMs: opt(num()),
  totalMs: num(),
  sawReasoning: bool(),
  sawToolCall: bool(),
  usage: opt(
    obj({
      input: num({ minimum: 0 }),
      output: num({ minimum: 0 }),
      totalTokens: num({ minimum: 0 }),
    }),
  ),
  replyPreview: str(),
  error: opt(str()),
});
export type SmokeTestModelResponse = Static<typeof SmokeTestModelResponseSchema>;

export const ReloadModelsResponseSchema = obj({
  reloaded: lit(true),
  providerCount: int({ minimum: 0 }),
  modelCount: int({ minimum: 0 }),
  diagnostics: arr(ModelsConfigDiagnosticSchema),
});
export type ReloadModelsResponse = Static<typeof ReloadModelsResponseSchema>;

export const ModelProfileSchema = obj({
  id: str({ minLength: 1 }),
  model: ModelChoiceSchema,
  description: str({ minLength: 1 }),
});
export type ModelProfile = Static<typeof ModelProfileSchema>;

export const ModelProfilesDocumentSchema = obj({
  profiles: arr(ModelProfileSchema),
  notes: opt(str()),
});
export type ModelProfilesDocument = Static<typeof ModelProfilesDocumentSchema>;
