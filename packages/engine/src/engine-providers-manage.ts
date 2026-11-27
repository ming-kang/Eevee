import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type ModelAuth,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  compatFieldsForApi,
  computeBuiltinFieldDiffs,
  decodeThinkingLevelConfig,
  deleteCustomModel,
  deleteModelOverride,
  deleteProviderConfig,
  describeConnectionUrl,
  encodeThinkingLevelConfig,
  getBuiltinProviderIds,
  getBuiltinProviderInfo,
  isBuiltinProviderId,
  type ModelEntryConfig,
  type ModelOverridePatch,
  type ModelRuntime,
  matchBuiltinModels,
  modelCatalogUrl,
  mutateModelsJson,
  type ProviderConfig,
  type ProviderConfigPatch,
  probeProviderModels,
  runModelSmokeTest,
  SUPPORTED_CHAT_APIS,
  upsertCustomModel,
  upsertModelOverride,
  upsertProviderConfig,
  validateBaseUrl,
} from "@eevee/agent/models";
import type {
  BuiltinModelMatchRequest,
  BuiltinModelMatchResponse,
  ImportProviderModelsRequest,
  ImportProviderModelsResponse,
  ModelDetail,
  ProbeProviderRequest,
  ProbeProviderResponse,
  ProviderCatalogResponse,
  ProviderDetail,
  ProviderDetailResponse,
  ProviderSummary,
  ReloadModelsResponse,
  SmokeTestModelRequest,
  SmokeTestModelResponse,
  UpsertProviderModelRequest,
  UpsertProviderRequest,
} from "@eevee/protocol";
import { EngineError } from "./engine-error.ts";
import { listProviders, type ProviderDeps, summarizeProvider } from "./engine-providers.ts";

function runtime(deps: ProviderDeps): ModelRuntime {
  const value = deps.runtime?.();
  if (value === undefined) {
    throw new EngineError(503, "models_runtime_unavailable", "Models runtime is unavailable");
  }
  return value;
}

function modelsFile(deps: ProviderDeps): string {
  const value = deps.modelsFile?.();
  if (value === undefined) {
    throw new EngineError(503, "models_runtime_unavailable", "Models file is unavailable");
  }
  return value;
}

function providerOrThrow(deps: ProviderDeps, providerId: string): Provider {
  const provider = deps.models().getProvider(providerId);
  if (provider === undefined) {
    throw new EngineError(404, "provider_not_found", `Unknown provider ${providerId}`);
  }
  return provider;
}

function modelOrThrow(deps: ProviderDeps, providerId: string, modelId: string): Model<Api> {
  providerOrThrow(deps, providerId);
  const model = deps.models().getModel(providerId, modelId);
  if (model === undefined) {
    throw new EngineError(
      404,
      "model_not_found",
      `Unknown model ${modelId} on provider ${providerId}`,
    );
  }
  return model;
}

function providerModels(provider: Provider): readonly Model<Api>[] {
  try {
    return provider.getModels();
  } catch {
    return [];
  }
}

function optionalObject(value: object | undefined): Record<string, unknown> | undefined {
  return value === undefined ? undefined : (value as Record<string, unknown>);
}

function modelDetail(
  model: Model<Api>,
  available: boolean,
  config: ProviderConfig | undefined,
  builtin: boolean,
): ModelDetail {
  const custom = config?.models?.find((entry) => entry.id === model.id);
  const override = config?.modelOverrides?.[model.id];
  const reference = getBuiltinProviderInfo(model.provider)?.models.find(
    (candidate) => candidate.id === model.id,
  );
  const isCustom = custom !== undefined;
  const baseline = !isCustom && builtin ? reference?.thinkingLevelMap : undefined;
  const ownMap = isCustom ? custom.thinkingLevelMap : override?.thinkingLevelMap;
  const headers = model.headers ?? custom?.headers ?? override?.headers;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
    available,
    isCustom,
    isBuiltin: builtin && reference !== undefined && !isCustom,
    hasOverride: override !== undefined,
    supportedThinkingLevels: getSupportedThinkingLevels(model),
    thinkingLevels: decodeThinkingLevelConfig(model.thinkingLevelMap, baseline, ownMap),
    ...(headers === undefined ? {} : { headers: { ...headers } }),
    ...(optionalObject(model.compat) === undefined ? {} : { compat: optionalObject(model.compat) }),
    ...(optionalObject(model.promptCache) === undefined
      ? {}
      : { promptCache: optionalObject(model.promptCache) }),
    ...(optionalObject(model.inputLimits) === undefined
      ? {}
      : { inputLimits: optionalObject(model.inputLimits) }),
    ...(optionalObject(model.samplingParams) === undefined
      ? {}
      : { samplingParams: optionalObject(model.samplingParams) }),
    ...(optionalObject(model.samplingParamsByThinkingLevel) === undefined
      ? {}
      : { samplingParamsByThinkingLevel: optionalObject(model.samplingParamsByThinkingLevel) }),
    ...(override === undefined ? {} : { override: optionalObject(override) }),
  };
}

async function providerDetail(
  deps: ProviderDeps,
  providerId: string,
): Promise<ProviderDetailResponse> {
  const provider = providerOrThrow(deps, providerId);
  const summary = await summarizeProvider(deps, provider);
  const config = deps.runtime?.().config().providers[providerId];
  const available = new Set(
    (await deps.models().getAvailable(providerId)).map((model) => model.id),
  );
  const models = providerModels(provider).map((model) =>
    modelDetail(model, available.has(model.id), config, isBuiltinProviderId(providerId)),
  );
  const apiKeyRef =
    config?.apiKey !== undefined && /^[$!]/.test(config.apiKey) ? config.apiKey : undefined;
  const detail: ProviderDetail = {
    ...summary,
    ...(config === undefined
      ? {}
      : {
          config: {
            ...(config.name === undefined ? {} : { name: config.name }),
            ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
            ...(config.api === undefined ? {} : { api: config.api }),
            ...(config.authHeader === undefined ? {} : { authHeader: config.authHeader }),
            ...(config.oauth === undefined ? {} : { oauth: config.oauth }),
            hasApiKey: config.apiKey !== undefined,
            ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
            ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
            ...(config.compat === undefined
              ? {}
              : { compat: config.compat as Record<string, unknown> }),
          },
        }),
    ...(describeConnectionUrl(config?.api, provider.baseUrl) === undefined
      ? {}
      : { connectionNote: describeConnectionUrl(config?.api, provider.baseUrl) }),
    models,
  };
  return { provider: detail };
}

export async function reloadModels(deps: ProviderDeps): Promise<ReloadModelsResponse> {
  const currentRuntime = runtime(deps);
  await currentRuntime.reload();
  return {
    reloaded: true,
    providerCount: deps.models().getProviders().length,
    modelCount: deps.models().getModels().length,
    diagnostics: [...currentRuntime.configDiagnostics()],
  };
}

export async function getProviderCatalog(deps: ProviderDeps): Promise<ProviderCatalogResponse> {
  const summaries = new Map((await listProviders(deps)).providers.map((item) => [item.id, item]));
  const config = deps.runtime?.().config();
  const providers = getBuiltinProviderIds().map((id) => {
    const info = getBuiltinProviderInfo(id);
    const summary: ProviderSummary | undefined = summaries.get(id);
    const provider = deps.models().getProvider(id);
    return {
      id,
      name: info?.name ?? provider?.name ?? id,
      ...(info?.baseUrl === undefined ? {} : { baseUrl: info.baseUrl }),
      apis: [...(info?.apis ?? [])],
      modelCount: info?.models.length ?? 0,
      configured: summary?.configured ?? false,
      hasConfigOverride: config?.providers[id] !== undefined,
      authMethods: summary?.authMethods ?? {
        apiKey: provider?.auth.apiKey !== undefined,
        apiKeyLogin: provider?.auth.apiKey?.login !== undefined,
        oauth: provider?.auth.oauth !== undefined,
        ...(provider?.auth.oauth?.name === undefined
          ? {}
          : { oauthName: provider.auth.oauth.name }),
        ...(provider?.auth.oauth?.loginLabel === undefined
          ? {}
          : { oauthLabel: provider.auth.oauth.loginLabel }),
      },
    };
  });
  return {
    providers,
    supportedApis: [...SUPPORTED_CHAT_APIS],
    compatSchemas: Object.fromEntries(
      SUPPORTED_CHAT_APIS.map((api) => [
        api,
        compatFieldsForApi(api).map((field) => ({
          key: field.key,
          kind: field.kind,
          ...(field.options === undefined ? {} : { options: [...field.options] }),
          ...(field.note === undefined ? {} : { note: field.note }),
        })),
      ]),
    ),
  };
}

export async function getProviderDetail(
  deps: ProviderDeps,
  providerId: string,
): Promise<ProviderDetailResponse> {
  return providerDetail(deps, providerId);
}

const PROVIDER_PATCH_FIELDS = [
  "name",
  "baseUrl",
  "api",
  "apiKey",
  "authHeader",
  "oauth",
  "headers",
  "compat",
] as const;

function providerPatch(input: UpsertProviderRequest): ProviderConfigPatch {
  const patch: Record<string, unknown> = {};
  for (const key of PROVIDER_PATCH_FIELDS) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (input.models !== undefined) patch.models = input.models;
  return patch as ProviderConfigPatch;
}

function validateProviderInput(input: UpsertProviderRequest): void {
  if (typeof input.baseUrl === "string") {
    const error = validateBaseUrl(input.baseUrl);
    if (error !== undefined) throw new EngineError(400, "invalid_request", error);
  }
}

async function finishProviderMutation(deps: ProviderDeps, providerId: string) {
  await runtime(deps).reload();
  return providerDetail(deps, providerId);
}

export async function createProvider(
  deps: ProviderDeps,
  input: UpsertProviderRequest,
): Promise<ProviderDetailResponse> {
  const id = input.id?.trim();
  if (!id) throw new EngineError(400, "invalid_request", "Provider id is required");
  if (deps.models().getProvider(id) !== undefined) {
    throw new EngineError(409, "provider_exists", `Provider ${id} already exists`);
  }
  validateProviderInput(input);
  await upsertProviderConfig(modelsFile(deps), id, providerPatch(input));
  return finishProviderMutation(deps, id);
}

export async function updateProvider(
  deps: ProviderDeps,
  providerId: string,
  input: UpsertProviderRequest,
): Promise<ProviderDetailResponse> {
  providerOrThrow(deps, providerId);
  if (input.id !== undefined && input.id !== providerId) {
    throw new EngineError(400, "invalid_request", "Provider id cannot be changed");
  }
  validateProviderInput(input);
  await upsertProviderConfig(modelsFile(deps), providerId, providerPatch(input));
  return finishProviderMutation(deps, providerId);
}

export async function deleteProvider(
  deps: ProviderDeps,
  providerId: string,
): Promise<{ ok: true }> {
  providerOrThrow(deps, providerId);
  await deleteProviderConfig(modelsFile(deps), providerId);
  await runtime(deps).reload();
  return { ok: true };
}

const CUSTOM_MODEL_FIELDS = [
  "name",
  "api",
  "baseUrl",
  "reasoning",
  "input",
  "contextWindow",
  "maxTokens",
  "cost",
  "promptCache",
  "inputLimits",
  "samplingParams",
  "samplingParamsByThinkingLevel",
  "headers",
  "compat",
] as const;

function customModelInput(
  modelId: string,
  input: UpsertProviderModelRequest,
  current?: ModelEntryConfig,
  builtinMap?: Model<Api>["thinkingLevelMap"],
  effectiveApi?: string,
): ModelEntryConfig {
  const model: Record<string, unknown> = current === undefined ? {} : structuredClone(current);
  model.id = modelId;
  for (const key of CUSTOM_MODEL_FIELDS) {
    const value = input[key];
    if (value === null) delete model[key];
    else if (value !== undefined) model[key] = value;
  }
  if (input.thinkingLevels !== undefined) {
    if (input.thinkingLevels === null) delete model.thinkingLevelMap;
    else {
      const encoded = encodeThinkingLevelConfig(input.thinkingLevels, {
        ...(builtinMap === undefined ? {} : { builtinMap }),
        ...(effectiveApi === undefined ? {} : { api: effectiveApi }),
      });
      if (encoded === undefined) delete model.thinkingLevelMap;
      else model.thinkingLevelMap = encoded;
    }
  }
  return model as ModelEntryConfig;
}

function overrideInput(
  input: UpsertProviderModelRequest,
  builtinMap: Model<Api>["thinkingLevelMap"],
  effectiveApi: string,
): ModelOverridePatch {
  if (input.api != null || input.baseUrl != null) {
    throw new EngineError(
      400,
      "invalid_request",
      "api and baseUrl can only be changed on custom model entries",
    );
  }
  const patch: Record<string, unknown> = {};
  for (const key of CUSTOM_MODEL_FIELDS) {
    if (key === "api" || key === "baseUrl") continue;
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (input.thinkingLevels !== undefined) {
    patch.thinkingLevelMap =
      input.thinkingLevels === null
        ? null
        : (encodeThinkingLevelConfig(input.thinkingLevels, {
            ...(builtinMap === undefined ? {} : { builtinMap }),
            api: effectiveApi,
          }) ?? null);
  }
  return patch as ModelOverridePatch;
}

export async function createProviderModel(
  deps: ProviderDeps,
  providerId: string,
  input: UpsertProviderModelRequest,
): Promise<ProviderDetailResponse> {
  providerOrThrow(deps, providerId);
  const modelId = input.id?.trim();
  if (!modelId) throw new EngineError(400, "invalid_request", "Model id is required");
  if (deps.models().getModel(providerId, modelId) !== undefined) {
    throw new EngineError(
      409,
      "model_exists",
      `Model ${modelId} already exists on provider ${providerId}`,
    );
  }
  const config = runtime(deps).config().providers[providerId];
  const model = customModelInput(
    modelId,
    input,
    undefined,
    undefined,
    input.api ?? config?.api ?? undefined,
  );
  await upsertCustomModel(modelsFile(deps), providerId, model);
  return finishProviderMutation(deps, providerId);
}

export async function updateProviderModel(
  deps: ProviderDeps,
  providerId: string,
  modelId: string,
  input: UpsertProviderModelRequest,
): Promise<ProviderDetailResponse> {
  const currentModel = modelOrThrow(deps, providerId, modelId);
  if (input.id !== undefined && input.id !== modelId) {
    throw new EngineError(400, "invalid_request", "Model id cannot be changed");
  }
  const config = runtime(deps).config().providers[providerId];
  const custom = config?.models?.find((entry) => entry.id === modelId);
  if (custom !== undefined) {
    const next = customModelInput(modelId, input, custom, undefined, input.api ?? currentModel.api);
    await upsertCustomModel(modelsFile(deps), providerId, next);
  } else {
    const reference = getBuiltinProviderInfo(providerId)?.models.find(
      (candidate) => candidate.id === modelId,
    );
    await upsertModelOverride(
      modelsFile(deps),
      providerId,
      modelId,
      overrideInput(input, reference?.thinkingLevelMap, currentModel.api),
    );
  }
  return finishProviderMutation(deps, providerId);
}

export async function deleteProviderModel(
  deps: ProviderDeps,
  providerId: string,
  modelId: string,
): Promise<ProviderDetailResponse> {
  modelOrThrow(deps, providerId, modelId);
  const config = runtime(deps).config().providers[providerId];
  if (config?.models?.some((entry) => entry.id === modelId)) {
    await deleteCustomModel(modelsFile(deps), providerId, modelId);
  } else {
    await deleteModelOverride(modelsFile(deps), providerId, modelId);
  }
  return finishProviderMutation(deps, providerId);
}

function draftAuth(input: ProbeProviderRequest, saved?: ModelAuth): ModelAuth | undefined {
  const auth: ModelAuth = {
    ...(saved?.apiKey === undefined ? {} : { apiKey: saved.apiKey }),
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    headers: { ...(saved?.headers ?? {}), ...(input.headers ?? {}) },
  };
  if (input.authHeader === true && auth.apiKey !== undefined) {
    auth.headers = { ...(auth.headers ?? {}), Authorization: `Bearer ${auth.apiKey}` };
    delete auth.apiKey;
  }
  if (auth.apiKey === undefined && Object.keys(auth.headers ?? {}).length === 0) return undefined;
  return auth;
}

async function probe(
  deps: ProviderDeps,
  input: ProbeProviderRequest,
  signal: AbortSignal | undefined,
  providerId?: string,
): Promise<ProbeProviderResponse> {
  const provider = providerId === undefined ? undefined : providerOrThrow(deps, providerId);
  const config =
    providerId === undefined ? undefined : runtime(deps).config().providers[providerId];
  const currentModels = provider === undefined ? [] : providerModels(provider);
  const saved =
    providerId === undefined
      ? undefined
      : (
          await deps.models().getAuth(providerId, {
            ...(signal === undefined ? {} : { signal }),
            ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
          })
        )?.auth;
  const baseUrl = input.baseUrl ?? provider?.baseUrl ?? currentModels[0]?.baseUrl;
  const api =
    input.api ?? config?.api ?? (currentModels.length === 1 ? currentModels[0]?.api : undefined);
  const connectionNote = describeConnectionUrl(api, baseUrl);
  if (baseUrl === undefined) {
    return {
      ok: false,
      ...(connectionNote === undefined ? {} : { connectionNote }),
      models: [],
      truncated: false,
      error: "Provider base URL is required",
    };
  }
  try {
    const result = await probeProviderModels({
      baseUrl,
      ...(api === undefined ? {} : { api }),
      auth: draftAuth(input, saved),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(signal === undefined ? {} : { signal }),
    });
    const existing = new Set(currentModels.map((model) => model.id));
    return {
      ok: true,
      catalogUrl: result.url,
      ...(connectionNote === undefined ? {} : { connectionNote }),
      models: result.models.map((model) => ({
        id: model.id,
        ...(model.name === undefined ? {} : { name: model.name }),
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        ...(model.input === undefined ? {} : { input: [...model.input] }),
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        exists: existing.has(model.id),
      })),
      truncated: result.truncated,
    };
  } catch (error) {
    let catalogUrl: string | undefined;
    try {
      catalogUrl = modelCatalogUrl(new URL(baseUrl), api).toString();
    } catch {}
    return {
      ok: false,
      ...(catalogUrl === undefined ? {} : { catalogUrl }),
      ...(connectionNote === undefined ? {} : { connectionNote }),
      models: [],
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeDraftProvider(
  deps: ProviderDeps,
  input: ProbeProviderRequest,
  signal?: AbortSignal,
): Promise<ProbeProviderResponse> {
  return probe(deps, input, signal);
}

export async function probeProvider(
  deps: ProviderDeps,
  providerId: string,
  input: ProbeProviderRequest = {},
  signal?: AbortSignal,
): Promise<ProbeProviderResponse> {
  return probe(deps, input, signal, providerId);
}

export async function importProviderModels(
  deps: ProviderDeps,
  providerId: string,
  input: ImportProviderModelsRequest,
): Promise<ImportProviderModelsResponse> {
  providerOrThrow(deps, providerId);
  await mutateModelsJson(modelsFile(deps), (draft) => {
    const provider = (draft.providers[providerId] ?? {}) as ProviderConfig;
    const models = [...(provider.models ?? [])];
    for (const imported of input.models) {
      const index = models.findIndex((model) => model.id === imported.id);
      const current = index < 0 ? undefined : models[index];
      const next = {
        ...(current ?? {}),
        ...structuredClone(imported),
      } as ModelEntryConfig;
      if (index < 0) models.push(next);
      else models[index] = next;
    }
    draft.providers[providerId] = { ...provider, models };
  });
  await runtime(deps).reload();
  return {
    imported: input.models.length,
    provider: (await providerDetail(deps, providerId)).provider,
  };
}

export async function matchBuiltinModel(
  deps: ProviderDeps,
  providerId: string,
  modelId: string,
  input: BuiltinModelMatchRequest = {},
): Promise<BuiltinModelMatchResponse> {
  const model = modelOrThrow(deps, providerId, modelId);
  const config = deps.runtime?.().config().providers[providerId];
  const current =
    config?.models?.find((entry) => entry.id === modelId) ??
    config?.modelOverrides?.[modelId] ??
    model;
  const candidates = matchBuiltinModels(input.query ?? modelId, model.api, input.limit ?? 10).map(
    (match) => ({
      providerId: match.providerId,
      modelId: match.model.id,
      name: match.model.name,
      api: match.model.api,
      reasoning: match.model.reasoning,
      contextWindow: match.model.contextWindow,
      maxTokens: match.model.maxTokens,
      input: [...match.model.input],
      tier: match.tier,
      diffs: computeBuiltinFieldDiffs(current, match.model, model.api).map((diff) => ({
        ...diff,
        value: diff.value ?? null,
      })),
    }),
  );
  return { candidates };
}

export async function testProviderModel(
  deps: ProviderDeps,
  providerId: string,
  modelId: string,
  input: SmokeTestModelRequest = {},
  signal?: AbortSignal,
): Promise<SmokeTestModelResponse> {
  modelOrThrow(deps, providerId, modelId);
  return runModelSmokeTest({
    models: deps.models(),
    providerId,
    modelId,
    ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
    ...(input.testTools === undefined ? {} : { testTools: input.testTools }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
  });
}
