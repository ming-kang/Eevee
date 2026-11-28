import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BuiltinFieldDiff,
  CompatFieldInfo,
  ModelDetail,
  ProbedModel,
  ProviderDetail,
  ProviderSummary,
} from "@eevee/protocol";
import {
  applyCandidateDiffs,
  buildModelUpsertRequest,
  createModelEditorDraft,
  filterCompatFields,
  hasModelDraftChanges,
  isCompatFieldConfigured,
  modelEditorReducer,
} from "../src/components/settings/model-editor/state.ts";
import {
  defaultThinkingLevels,
  describeConnectionUrl,
  sortProvidersForSidebar,
  toImportModelPayload,
  validateBaseUrl,
} from "../src/components/settings/provider-utils.ts";
import {
  addProviderReducer,
  buildBuiltinOverrideRequest,
  buildCustomProviderRequest,
  createAddProviderState,
} from "../src/components/settings/providers/add-provider-state.ts";
import {
  buildProviderPatch,
  createProviderConfigDraft,
} from "../src/components/settings/providers/provider-config.ts";

function makeProviderDetail(overrides: Partial<ProviderDetail> = {}): ProviderDetail {
  return {
    id: "custom-openai",
    name: "Custom OpenAI",
    kind: "custom",
    api: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    authMethods: { apiKey: true, apiKeyLogin: false, oauth: false },
    configured: true,
    modelCount: 1,
    models: [],
    config: {
      name: "Custom OpenAI",
      api: "openai-completions",
      baseUrl: "https://api.example.com/v1",
      authHeader: true,
      hasApiKey: true,
      apiKeyRef: "$OPENAI_KEY",
      headers: { "X-Org": "acme" },
    },
    ...overrides,
  };
}

function makeModelDetail(overrides: Partial<ModelDetail> = {}): ModelDetail {
  return {
    provider: "custom-openai",
    id: "gpt-4o",
    name: "GPT-4o",
    api: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
    available: true,
    isCustom: true,
    isBuiltin: false,
    hasOverride: false,
    supportedThinkingLevels: ["off"],
    thinkingLevels: defaultThinkingLevels(),
    ...overrides,
  };
}

const COMPAT_FIELDS: readonly CompatFieldInfo[] = [
  { key: "supportsStore", kind: "boolean" },
  { key: "maxTokensField", kind: "enum", options: ["max_tokens", "max_completion_tokens"] },
  { key: "customDelayMs", kind: "number" },
  { key: "extraHeaders", kind: "stringMap" },
  { key: "rawCompat", kind: "json" },
];

const COMPAT_SCHEMAS: Record<string, CompatFieldInfo[]> = {
  "openai-completions": [...COMPAT_FIELDS],
};

test("toImportModelPayload maps probed model fields cleanly and omits empty/undefined values", () => {
  const full: ProbedModel = {
    id: "anthropic/claude-sonnet-4",
    name: "  Claude Sonnet 4  ",
    contextWindow: 200000,
    maxTokens: 16384,
    input: ["text", "image"],
    reasoning: true,
    exists: false,
  };
  assert.deepEqual(toImportModelPayload(full), {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    contextWindow: 200000,
    maxTokens: 16384,
    input: ["text", "image"],
    reasoning: true,
  });

  const minimal: ProbedModel = {
    id: "gpt-4o-mini",
    name: "   ",
    exists: true,
  };
  assert.deepEqual(toImportModelPayload(minimal), {
    id: "gpt-4o-mini",
  });
});

test("buildProviderPatch emits minimal typed diff and validates Base URL and headers", () => {
  const detail = makeProviderDetail();
  const initial = createProviderConfigDraft(detail);
  assert.deepEqual(buildProviderPatch(detail, initial), {});

  const edited = {
    ...initial,
    name: "  ",
    api: "openai-responses",
    baseUrl: "https://proxy.example.com/v1",
    authHeader: false,
    headers: [{ uid: 1, key: "X-Org", value: "beta" }],
    clearApiKey: true,
  };
  assert.deepEqual(buildProviderPatch(detail, edited), {
    name: null,
    api: "openai-responses",
    baseUrl: "https://proxy.example.com/v1",
    authHeader: null,
    headers: { "X-Org": "beta" },
    apiKey: null,
  });

  const clearedKeyByEdit = {
    ...initial,
    apiKey: "   ",
    apiKeyTouched: true,
  };
  assert.deepEqual(buildProviderPatch(detail, clearedKeyByEdit), {
    apiKey: null,
  });

  const replacedKey = {
    ...initial,
    apiKey: " sk-new-key ",
    apiKeyTouched: true,
  };
  assert.deepEqual(buildProviderPatch(detail, replacedKey), {
    apiKey: "sk-new-key",
  });

  assert.throws(
    () => buildProviderPatch(detail, { ...initial, baseUrl: "not-a-url" }),
    /必须是完整的绝对 URL/,
  );
  assert.throws(
    () => buildProviderPatch(detail, { ...initial, headers: [{ uid: 2, key: "", value: "1" }] }),
    /缺少 Header 名称/,
  );
});

test("createModelEditorDraft initializes create and edit drafts including compat and advanced JSON", () => {
  const createDraft = createModelEditorDraft(
    { providerId: "custom-openai", providerApi: "openai-completions" },
    COMPAT_SCHEMAS,
  );
  assert.equal(createDraft.modelId, "");
  assert.equal(createDraft.contextWindow, "128000");
  assert.equal(createDraft.maxTokens, "8192");
  assert.equal(createDraft.imageInput, false);

  const existing = makeModelDetail({
    input: ["text", "image"],
    reasoning: true,
    compat: {
      supportsStore: false,
      maxTokensField: "max_completion_tokens",
      customDelayMs: 50,
      extraHeaders: { "X-Mode": "fast" },
      rawCompat: { nested: true },
    },
    headers: { Authorization: "Bearer $TOKEN" },
    promptCache: { enabled: true },
  });
  const editDraft = createModelEditorDraft(
    { providerId: "custom-openai", providerApi: "openai-completions", model: existing },
    COMPAT_SCHEMAS,
  );
  assert.equal(editDraft.modelId, "gpt-4o");
  assert.equal(editDraft.reasoning, true);
  assert.equal(editDraft.imageInput, true);
  assert.equal(editDraft.compatText.customDelayMs, "50");
  assert.equal(editDraft.compatText.extraHeaders, "X-Mode=fast");
  assert.match(editDraft.compatText.rawCompat ?? "", /"nested": true/);
  assert.match(editDraft.advancedText.headers, /"Authorization": "Bearer \$TOKEN"/);
  assert.match(editDraft.advancedText.promptCache, /"enabled": true/);
});

test("buildModelUpsertRequest handles create payloads, edit diffs, compat parsing, and validation", () => {
  const target = { providerId: "custom-openai", providerApi: "openai-completions" };
  let draft = createModelEditorDraft(target, COMPAT_SCHEMAS);
  assert.throws(() => buildModelUpsertRequest(target, draft, COMPAT_FIELDS), /Model ID 不能为空/);

  draft = modelEditorReducer(draft, {
    type: "patch",
    patch: {
      modelId: " deepseek-r1 ",
      reasoning: true,
      imageInput: true,
      contextWindow: "65536",
      maxTokens: "8192",
      costInput: "0.55",
      costOutput: "2.19",
    },
  });
  draft = modelEditorReducer(draft, {
    type: "setCompatBoolean",
    key: "supportsStore",
    enabled: false,
  });
  draft = modelEditorReducer(draft, {
    type: "setCompatEnum",
    key: "maxTokensField",
    value: "max_completion_tokens",
  });
  draft = modelEditorReducer(draft, {
    type: "setCompatText",
    key: "extraHeaders",
    value: "X-Trace=1",
  });
  draft = modelEditorReducer(draft, {
    type: "setAdvancedText",
    key: "headers",
    value: '{"X-App":"eevee"}',
  });

  const createPayload = buildModelUpsertRequest(target, draft, COMPAT_FIELDS);
  assert.deepEqual(createPayload, {
    id: "deepseek-r1",
    name: "deepseek-r1",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 65536,
    maxTokens: 8192,
    cost: { input: 0.55, output: 2.19, cacheRead: 0, cacheWrite: 0 },
    thinkingLevels: draft.thinkingLevels,
    compat: {
      supportsStore: false,
      maxTokensField: "max_completion_tokens",
      extraHeaders: { "X-Trace": "1" },
    },
    headers: { "X-App": "eevee" },
  });

  const builtinModel = makeModelDetail({
    isCustom: false,
    isBuiltin: true,
    compat: { supportsStore: true },
    headers: { "X-Old": "1" },
  });
  const builtinTarget = {
    providerId: "openai",
    providerApi: "openai-completions",
    model: builtinModel,
  };
  let editDraft = createModelEditorDraft(builtinTarget, COMPAT_SCHEMAS);
  assert.deepEqual(buildModelUpsertRequest(builtinTarget, editDraft, COMPAT_FIELDS), {});

  editDraft = modelEditorReducer(editDraft, {
    type: "patch",
    patch: { costOutput: "12.5" },
  });
  editDraft = modelEditorReducer(editDraft, {
    type: "setAdvancedText",
    key: "headers",
    value: "",
  });
  const editPayload = buildModelUpsertRequest(builtinTarget, editDraft, COMPAT_FIELDS);
  assert.deepEqual(editPayload, {
    cost: { output: 12.5 },
    headers: null,
  });
});

test("applyCandidateDiffs applies only applicable diffs and updates compat/thinking/cost", () => {
  const model = makeModelDetail({
    compat: { supportsStore: true },
  });
  const target = {
    providerId: "custom-openai",
    providerApi: "openai-completions",
    model,
  };
  const draft = createModelEditorDraft(target, COMPAT_SCHEMAS);

  const diffs: BuiltinFieldDiff[] = [
    {
      field: "name",
      applicable: true,
      checked: true,
      same: false,
      currentText: "GPT-4o",
      referenceText: "GPT-4o Reference",
      value: "GPT-4o Reference",
    },
    {
      field: "contextWindow",
      applicable: false,
      checked: false,
      same: false,
      currentText: "128000",
      referenceText: "999999",
      value: 999999,
    },
    {
      field: "input",
      applicable: true,
      checked: true,
      same: false,
      currentText: "text",
      referenceText: "text, image",
      value: ["text", "image"],
    },
    {
      field: "cost",
      applicable: true,
      checked: true,
      same: false,
      currentText: "2.5/10",
      referenceText: "3/15",
      value: { input: 3, output: 15, cacheRead: 1.5, cacheWrite: 0.25 },
    },
    {
      field: "thinkingLevelMap",
      applicable: true,
      checked: true,
      same: false,
      currentText: "{}",
      referenceText: '{"high":"xhigh","xhigh":"xhigh"}',
      value: { high: "xhigh", xhigh: "xhigh" },
    },
    {
      field: "compat",
      applicable: true,
      checked: true,
      same: false,
      currentText: "",
      referenceText: "",
      value: { customDelayMs: 25 },
    },
    {
      field: "samplingParams",
      applicable: true,
      checked: true,
      same: false,
      currentText: "",
      referenceText: '{"temperature":0.7}',
      value: { temperature: 0.7 },
    },
  ];

  const updated = applyCandidateDiffs(draft, diffs, COMPAT_FIELDS);
  assert.equal(updated.name, "GPT-4o Reference");
  assert.equal(updated.contextWindow, "128000");
  assert.equal(updated.imageInput, true);
  assert.equal(updated.costInput, "3");
  assert.equal(updated.costOutput, "15");
  assert.equal(updated.costCacheRead, "1.5");
  assert.equal(updated.costCacheWrite, "0.25");
  assert.equal(updated.thinkingLevels.high.mappedTo, "xhigh");
  assert.equal(updated.thinkingLevels.xhigh.enabled, true);
  assert.deepEqual(updated.compatValues, { customDelayMs: 25 });
  assert.equal(updated.compatText.customDelayMs, "25");
  assert.match(updated.advancedText.samplingParams, /"temperature": 0\.7/);
});

test("add-provider payload builders produce typed UpsertProviderRequest payloads", () => {
  assert.equal(
    buildBuiltinOverrideRequest({
      filter: "",
      selectedId: "openai",
      apiKey: "",
      revealKey: false,
      baseUrl: "   ",
      headers: [],
    }),
    undefined,
  );
  assert.deepEqual(
    buildBuiltinOverrideRequest({
      filter: "",
      selectedId: "openai",
      apiKey: "",
      revealKey: false,
      baseUrl: "https://gateway.example.com/v1",
      headers: [{ uid: 1, key: "X-Proxy", value: "yes" }],
    }),
    {
      baseUrl: "https://gateway.example.com/v1",
      headers: { "X-Proxy": "yes" },
    },
  );

  const customPayload = buildCustomProviderRequest(
    {
      id: " my-proxy ",
      name: " My Proxy ",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
      apiKey: "$PROXY_KEY",
      revealKey: false,
      authHeader: true,
      headers: [{ uid: 2, key: "X-Team", value: "core" }],
    },
    [{ id: "qwen-max", name: "Qwen Max", contextWindow: 32768, exists: false }],
  );
  assert.deepEqual(customPayload, {
    id: "my-proxy",
    name: "My Proxy",
    api: "openai-completions",
    baseUrl: "https://proxy.example.com/v1",
    apiKey: "$PROXY_KEY",
    authHeader: true,
    headers: { "X-Team": "core" },
    models: [{ id: "qwen-max", name: "Qwen Max", contextWindow: 32768 }],
  });
});

test("validateBaseUrl and describeConnectionUrl delegate cleanly to @eevee/protocol with localized messages", () => {
  assert.equal(validateBaseUrl(""), "Base URL 不能为空");
  assert.equal(validateBaseUrl(" https://api.example.com "), "Base URL 首尾不能有空白字符");
  assert.equal(validateBaseUrl("not-a-url"), "Base URL 必须是完整的绝对 URL");
  assert.equal(validateBaseUrl("ftp://example.com"), "Base URL 必须使用 http 或 https");
  assert.equal(validateBaseUrl("https://user:pass@example.com"), "Base URL 不能包含用户名或密码");
  assert.equal(validateBaseUrl("https://example.com?x=1"), "Base URL 不能包含查询参数或锚点");
  assert.equal(validateBaseUrl("https://api.example.com/v1"), undefined);

  assert.deepEqual(describeConnectionUrl("openai-completions", "https://api.example.com/v1"), {
    text: "https://api.example.com/v1/models",
  });
  assert.deepEqual(describeConnectionUrl("anthropic-messages", "https://api.anthropic.com"), {
    text: "https://api.anthropic.com/v1/models",
  });
  assert.deepEqual(describeConnectionUrl("openai-completions", "https://proxy.example.com/v1/v1"), {
    text: "https://proxy.example.com/v1/v1/models",
    warning: true,
  });
  assert.equal(describeConnectionUrl("openai-completions", "invalid"), undefined);
});

test("sortProvidersForSidebar prioritizes configured and custom providers above unconfigured builtins", () => {
  const mk = (id: string, name: string, opts: Partial<ProviderSummary> = {}): ProviderSummary => ({
    id,
    name,
    authMethods: { apiKey: true, apiKeyLogin: false, oauth: false },
    configured: false,
    modelCount: 1,
    kind: "builtin",
    ...opts,
  });

  const sorted = sortProvidersForSidebar([
    mk("amazon-bedrock", "Amazon Bedrock"),
    mk("anthropic", "Anthropic", { configured: true }),
    mk("openai", "OpenAI", { hasConfigOverride: true }),
    mk("local-ollama", "Local Ollama", { kind: "custom" }),
    mk("my-proxy", "My Proxy", { kind: "custom", configured: true }),
    mk("azure", "Azure"),
  ]);

  assert.deepEqual(
    sorted.map((item) => item.id),
    ["my-proxy", "anthropic", "local-ollama", "openai", "amazon-bedrock", "azure"],
  );
});

test("addProviderReducer clears previous builtin gateway draft on selectBuiltin", () => {
  let state = createAddProviderState(undefined);
  state = addProviderReducer(state, {
    type: "patchBuiltin",
    patch: {
      selectedId: "openai",
      apiKey: "sk-old",
      baseUrl: "https://old.example.com/v1",
      headers: [{ uid: 1, key: "X-Old", value: "1" }],
    },
  });
  state = addProviderReducer(state, { type: "selectBuiltin", id: "anthropic" });
  assert.equal(state.builtin.selectedId, "anthropic");
  assert.equal(state.builtin.apiKey, "");
  assert.equal(state.builtin.baseUrl, "");
  assert.deepEqual(state.builtin.headers, []);
});

test("createModelEditorDraft preserves explicit custom model api and baseUrl overrides without false diffs", () => {
  const customModel = makeModelDetail({
    api: "anthropic-messages",
    baseUrl: "https://custom-endpoint.example.com/v1",
  });
  const target = {
    providerId: "custom-openai",
    providerApi: "openai-completions",
    providerBaseUrl: "https://api.example.com/v1",
    model: customModel,
  };
  const draft = createModelEditorDraft(target, COMPAT_SCHEMAS);
  assert.equal(draft.apiValue, "anthropic-messages");
  assert.equal(draft.baseUrlValue, "https://custom-endpoint.example.com/v1");
  assert.deepEqual(buildModelUpsertRequest(target, draft, COMPAT_FIELDS), {});

  const inherited = createModelEditorDraft(
    {
      ...target,
      model: makeModelDetail({
        api: "openai-completions",
        baseUrl: "https://api.example.com/v1",
      }),
    },
    COMPAT_SCHEMAS,
  );
  assert.equal(inherited.apiValue, "");
  assert.equal(inherited.baseUrlValue, "");
});

test("tri-state compat booleans distinguish default, true, and false and support filtering", () => {
  const tempField: CompatFieldInfo = {
    key: "supportsTemperature",
    kind: "boolean",
    note: "Whether the model accepts Anthropic temperature.",
  };
  const sigField: CompatFieldInfo = {
    key: "allowEmptySignature",
    kind: "boolean",
    note: "Replay empty thinking signatures.",
  };
  const affinityField: CompatFieldInfo = {
    key: "sessionAffinityFormat",
    kind: "enum",
    options: ["openrouter"],
    note: "Session affinity header format.",
  };
  const fields: readonly CompatFieldInfo[] = [tempField, sigField, affinityField];
  const schemas = { "anthropic-messages": [...fields] };
  const model = makeModelDetail({
    api: "anthropic-messages",
    compat: { allowEmptySignature: true },
  });
  const target = {
    providerId: "custom-anthropic",
    providerApi: "anthropic-messages",
    model,
  };

  let draft = createModelEditorDraft(target, schemas);
  assert.equal(hasModelDraftChanges(target, draft, fields), false);
  assert.equal(isCompatFieldConfigured(tempField, draft), false);
  assert.equal(isCompatFieldConfigured(sigField, draft), true);
  assert.deepEqual(
    filterCompatFields(fields, "", true, draft).map((f) => f.key),
    ["allowEmptySignature"],
  );
  assert.deepEqual(
    filterCompatFields(fields, "signature", false, draft).map((f) => f.key),
    ["allowEmptySignature"],
  );
  assert.deepEqual(
    filterCompatFields(fields, "temperature", false, draft).map((f) => f.key),
    ["supportsTemperature"],
  );

  draft = modelEditorReducer(draft, {
    type: "setCompatBoolean",
    key: "supportsTemperature",
    enabled: false,
  });
  assert.equal(hasModelDraftChanges(target, draft, fields), true);
  assert.equal(isCompatFieldConfigured(tempField, draft), true);
  assert.deepEqual(buildModelUpsertRequest(target, draft, fields), {
    compat: { allowEmptySignature: true, supportsTemperature: false },
  });

  draft = modelEditorReducer(draft, {
    type: "setCompatBoolean",
    key: "supportsTemperature",
    enabled: undefined,
  });
  assert.equal(hasModelDraftChanges(target, draft, fields), false);
  assert.equal(isCompatFieldConfigured(tempField, draft), false);
  assert.deepEqual(buildModelUpsertRequest(target, draft, fields), {});

  draft = modelEditorReducer(draft, {
    type: "setCompatBoolean",
    key: "allowEmptySignature",
    enabled: undefined,
  });
  assert.deepEqual(buildModelUpsertRequest(target, draft, fields), {
    compat: null,
  });
});
