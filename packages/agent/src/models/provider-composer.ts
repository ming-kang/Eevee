import {
  type AnyModel,
  type Api,
  type ApiKeyAuth,
  type AuthCheck,
  type AuthResult,
  type ClassifierApi,
  type ClassifierModel,
  createProvider,
  type Model,
  type ModelAuth,
  type ModelInputLimits,
  type Provider,
  type ProviderHeaders,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import {
  builtinProviders,
  getAllBuiltinModels,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import {
  isConfigValueConfigured,
  resolveConfigValue,
  resolveHeadersStrict,
} from "../shared/config-value.ts";
import { isRecord } from "../shared/guards.ts";
import { AUTH_HEADERS, REQUEST_AUTH_HEADER_NAMES } from "./auth-headers.ts";
import {
  type CompatConfig,
  type ModelEntryConfig,
  type ModelOverrideConfig,
  type ModelsConfig,
  ModelsConfigError,
  type ProviderConfig,
} from "./model-config.ts";
import { normalizeThinkingLevelMapForRuntime } from "./thinking-map.ts";

export type ComposeEnvironment = Readonly<Record<string, string | undefined>>;

export type ComposeOptions = {
  readonly env?: ComposeEnvironment;
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const AUTH_HEADER_SUPPORTED_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);

export const CHAT_API_STREAMS: Readonly<Record<string, () => ProviderStreams>> = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "azure-openai-responses": azureOpenAIResponsesApi,
  "openai-codex-responses": openAICodexResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "google-vertex": googleVertexApi,
  "mistral-conversations": mistralConversationsApi,
  "bedrock-converse-stream": bedrockConverseStreamApi,
  "pi-messages": piMessagesApi,
};

function isChatModel(model: AnyModel): model is Model<Api> {
  return model.type === undefined || model.type === "chat";
}

function mergeHeaders(
  base: Readonly<Record<string, string>> | undefined,
  override: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined;
function mergeHeaders(
  base: Readonly<ProviderHeaders> | undefined,
  override: Readonly<ProviderHeaders> | undefined,
): ProviderHeaders | undefined;
function mergeHeaders(
  base: Readonly<ProviderHeaders> | undefined,
  override: Readonly<ProviderHeaders> | undefined,
): ProviderHeaders | undefined {
  if (!base && !override) return undefined;
  const merged: ProviderHeaders = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    const lower = name.toLowerCase();
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === lower && existing !== name) delete merged[existing];
    }
    merged[name] = value;
  }
  return merged;
}

const COMPAT_NESTED_KEYS = [
  "openRouterRouting",
  "vercelGatewayRouting",
  "chatTemplateKwargs",
  "chatTemplateArgs",
] as const;

function mergeCompat(
  base: CompatConfig | undefined,
  override: CompatConfig | undefined,
): CompatConfig | undefined {
  if (!override) return base === undefined ? undefined : { ...base };
  if (!base) return { ...override };
  const merged: CompatConfig = { ...base, ...override };
  for (const key of COMPAT_NESTED_KEYS) {
    const baseValue = base[key];
    const overrideValue = override[key];
    if (isRecord(baseValue) || isRecord(overrideValue)) {
      merged[key] = {
        ...(isRecord(baseValue) ? baseValue : {}),
        ...(isRecord(overrideValue) ? overrideValue : {}),
      };
    }
  }
  return merged;
}

function mergeDefined<T extends object>(
  base: T | undefined,
  override: Partial<T> | undefined,
): T | undefined {
  if (!base && !override) return undefined;
  return { ...base, ...override } as T;
}

function mergeInputLimits(
  base: ModelInputLimits | undefined,
  override: ModelInputLimits | undefined,
): ModelInputLimits | undefined {
  if (!base && !override) return undefined;
  if (!base || !override) return structuredClone(base ?? override);
  const merged: ModelInputLimits = { ...base, ...override };
  if (base.images !== undefined || override.images !== undefined) {
    const images: NonNullable<ModelInputLimits["images"]> = {
      ...base.images,
      ...override.images,
    };
    if (base.images?.resize !== undefined || override.images?.resize !== undefined) {
      images.resize = {
        ...base.images?.resize,
        ...override.images?.resize,
      };
    }
    merged.images = images;
  }
  return merged;
}

function resolveProviderConfigHeaders(
  config: ProviderConfig,
  env?: ComposeEnvironment,
): Record<string, string> | undefined {
  return resolveHeadersStrict(config.headers, env, { cacheCommands: false });
}

function withConfigHeaders(
  auth: ModelAuth,
  config: ProviderConfig,
  env?: ComposeEnvironment,
): ModelAuth {
  const configHeaders = resolveProviderConfigHeaders(config, env);
  let headers = mergeHeaders(auth.headers, configHeaders);
  let apiKey = auth.apiKey;
  if (config.authHeader === true && apiKey !== undefined) {
    headers = { ...headers, [AUTH_HEADERS.authorization]: `Bearer ${apiKey}` };
    apiKey = undefined;
  }
  if (!headers) return apiKey === auth.apiKey ? auth : { ...auth, apiKey };
  const result: ModelAuth = { ...auth, headers };
  if (apiKey === undefined) delete result.apiKey;
  return result;
}

function apiKeyAuthResult(
  config: ProviderConfig,
  key: string,
  source: string,
  credentialEnv?: Record<string, string>,
  env?: ComposeEnvironment,
): AuthResult {
  const auth = withConfigHeaders({ apiKey: key }, config, env);
  return {
    auth,
    ...(credentialEnv === undefined ? {} : { env: credentialEnv }),
    source,
  };
}

function configApiKeyConfigured(config: ProviderConfig, env?: ComposeEnvironment): boolean {
  return config.apiKey !== undefined && isConfigValueConfigured(config.apiKey, env);
}

function hasRecognizedAuthHeader(headers: Readonly<Record<string, string>> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((name) => REQUEST_AUTH_HEADER_NAMES.has(name.toLowerCase()));
}

function hasConfiguredAuthHeader(
  headers: Readonly<Record<string, string>> | undefined,
  env?: ComposeEnvironment,
): boolean {
  if (!headers) return false;
  return Object.entries(headers).some(
    ([name, value]) =>
      REQUEST_AUTH_HEADER_NAMES.has(name.toLowerCase()) &&
      value.trim().length > 0 &&
      isConfigValueConfigured(value, env),
  );
}

function validateAuthHeaderApisForSet(providerId: string, apis: ReadonlySet<string>): void {
  for (const api of apis) {
    if (!AUTH_HEADER_SUPPORTED_APIS.has(api)) {
      throw new ModelsConfigError(
        `providers.${providerId}.authHeader`,
        `authHeader is not supported for api "${api}"; supported APIs: ${[...AUTH_HEADER_SUPPORTED_APIS].join(", ")}`,
      );
    }
  }
}

function validateAuthHeaderApis(
  providerId: string,
  config: ProviderConfig,
  models: readonly AnyModel[],
): void {
  if (config.authHeader !== true) return;
  const apis = new Set<string>();
  if (config.api !== undefined) apis.add(config.api);
  for (const model of models) {
    if (isChatModel(model)) apis.add(model.api);
  }
  validateAuthHeaderApisForSet(providerId, apis);
}

function wrapOAuthAuth(
  delegate: NonNullable<Provider["auth"]["oauth"]>,
  config: ProviderConfig,
  env?: ComposeEnvironment,
): NonNullable<Provider["auth"]["oauth"]> {
  return {
    ...delegate,
    toAuth: async (credential) => {
      const auth = await delegate.toAuth(credential);
      return withConfigHeaders(auth, config, env);
    },
  };
}

function wrapApiKeyAuth(
  delegate: ApiKeyAuth | undefined,
  config: ProviderConfig,
  env?: ComposeEnvironment,
): ApiKeyAuth {
  const auth: ApiKeyAuth = {
    name: delegate?.name ?? config.name ?? "API key",
    resolve: async (input) => {
      input.signal.throwIfAborted();
      if (typeof input.credential?.key === "string" && input.credential.key.length > 0) {
        if (delegate) {
          const result = await delegate.resolve(input);
          if (result) {
            return { ...result, auth: withConfigHeaders(result.auth, config, env) };
          }
        }
        return apiKeyAuthResult(
          config,
          input.credential.key,
          "stored credential",
          input.credential.env,
          env,
        );
      }
      const configKey =
        config.apiKey === undefined
          ? undefined
          : resolveConfigValue(config.apiKey, env, { cacheCommands: false });
      if (configKey !== undefined) {
        return apiKeyAuthResult(config, configKey, "models.json", undefined, env);
      }
      if (delegate) {
        const result = await delegate.resolve(input);
        if (result) {
          return { ...result, auth: withConfigHeaders(result.auth, config, env) };
        }
      }
      if (hasRecognizedAuthHeader(config.headers)) {
        const resolvedHeaders = resolveProviderConfigHeaders(config, env);
        if (
          resolvedHeaders &&
          Object.entries(resolvedHeaders).some(
            ([name, value]) =>
              REQUEST_AUTH_HEADER_NAMES.has(name.toLowerCase()) && value.trim().length > 0,
          )
        ) {
          return {
            auth: { headers: resolvedHeaders },
            source: "models.json",
          };
        }
      }
      return undefined;
    },
    check: async (input): Promise<AuthCheck | undefined> => {
      input.signal.throwIfAborted();
      if (typeof input.credential?.key === "string" && input.credential.key.length > 0) {
        return { type: "api_key", source: "stored credential" };
      }
      if (configApiKeyConfigured(config, env)) {
        return { type: "api_key", source: "models.json" };
      }
      if (delegate?.check) {
        const checked = await delegate.check(input);
        if (checked) return checked;
      } else if (delegate) {
        const result = await delegate.resolve(input);
        if (result) return { type: "api_key", source: result.source };
      }
      if (hasConfiguredAuthHeader(config.headers, env)) {
        return { type: "api_key", source: "models.json" };
      }
      return undefined;
    },
  };
  if (delegate?.login) {
    auth.login = delegate.login;
  } else if (!delegate) {
    auth.login = async (interaction) => {
      interaction.signal.throwIfAborted();
      const key = await interaction.prompt({
        type: "secret",
        message: `Enter ${config.name ?? "provider"} API key`,
      });
      interaction.signal.throwIfAborted();
      return { type: "api_key", key };
    };
  }
  return auth;
}

function entryEndpoint(
  entry: ModelEntryConfig,
  config: ProviderConfig,
  providerId: string,
  replaced: AnyModel | undefined,
): { api: string; baseUrl: string } {
  const api = entry.api ?? config.api ?? replaced?.api;
  if (api === undefined) {
    throw new ModelsConfigError(
      `providers.${providerId}.models`,
      `model "${entry.id}" has no api; set it on the entry or the provider`,
    );
  }
  const baseUrl = entry.baseUrl ?? config.baseUrl ?? replaced?.baseUrl;
  if (baseUrl === undefined) {
    throw new ModelsConfigError(
      `providers.${providerId}.models`,
      `model "${entry.id}" has no baseUrl; set it on the entry or the provider`,
    );
  }
  return { api, baseUrl };
}

function buildEntryModel(
  entry: ModelEntryConfig,
  config: ProviderConfig,
  providerId: string,
  replaced: AnyModel | undefined,
): Model<Api> {
  const { api, baseUrl } = entryEndpoint(entry, config, providerId, replaced);
  const thinkingLevelMap = normalizeThinkingLevelMapForRuntime(undefined, entry.thinkingLevelMap);
  const compat = mergeCompat(config.compat, entry.compat);
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: entry.reasoning ?? false,
    input: [...(entry.input ?? ["text"])],
    cost: entry.cost ?? { ...ZERO_COST },
    contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: entry.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(entry.inputLimits === undefined ? {} : { inputLimits: entry.inputLimits }),
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(entry.promptCache === undefined ? {} : { promptCache: entry.promptCache }),
    ...(entry.samplingParams === undefined ? {} : { samplingParams: entry.samplingParams }),
    ...(entry.samplingParamsByThinkingLevel === undefined
      ? {}
      : { samplingParamsByThinkingLevel: entry.samplingParamsByThinkingLevel }),
    ...(compat === undefined ? {} : { compat: compat as Model<Api>["compat"] }),
  };
}

function mergeSamplingByLevel(
  base: Model<Api>["samplingParamsByThinkingLevel"],
  override: Model<Api>["samplingParamsByThinkingLevel"],
): Model<Api>["samplingParamsByThinkingLevel"] {
  if (!base && !override) return undefined;
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [level, params] of Object.entries(base ?? {})) {
    if (params) merged[level] = { ...params };
  }
  for (const [level, params] of Object.entries(override ?? {})) {
    if (params) merged[level] = { ...(merged[level] ?? {}), ...params };
  }
  return merged as Model<Api>["samplingParamsByThinkingLevel"];
}

function applyModelOverride(model: AnyModel, override: ModelOverrideConfig): AnyModel {
  const inputLimits =
    override.inputLimits === undefined
      ? model.inputLimits
      : mergeInputLimits(model.inputLimits, override.inputLimits);
  const cost = override.cost === undefined ? model.cost : mergeDefined(model.cost, override.cost);
  const base: AnyModel = {
    ...model,
    ...(override.name === undefined ? {} : { name: override.name }),
    ...(override.input === undefined ? {} : { input: [...override.input] }),
    ...(inputLimits === undefined ? {} : { inputLimits }),
    ...(cost === undefined ? {} : { cost }),
  };
  if (!isChatModel(base)) {
    if (base.type === "classifier") {
      const compat = mergeCompat(base.compat as CompatConfig | undefined, override.compat);
      return {
        ...base,
        ...(override.contextWindow === undefined ? {} : { contextWindow: override.contextWindow }),
        ...(compat === undefined
          ? {}
          : { compat: compat as ClassifierModel<ClassifierApi>["compat"] }),
      };
    }
    return base;
  }
  const compat = mergeCompat(base.compat as CompatConfig | undefined, override.compat);
  const { thinkingLevelMap: baseThinkingLevelMap, ...baseWithoutThinkingMap } = base;
  const thinkingLevelMap =
    override.thinkingLevelMap === undefined
      ? baseThinkingLevelMap
      : normalizeThinkingLevelMapForRuntime(baseThinkingLevelMap, override.thinkingLevelMap);
  const promptCache =
    override.promptCache === undefined
      ? base.promptCache
      : mergeDefined(base.promptCache, override.promptCache);
  const samplingParams =
    override.samplingParams === undefined
      ? base.samplingParams
      : mergeDefined(base.samplingParams, override.samplingParams);
  const samplingParamsByThinkingLevel =
    override.samplingParamsByThinkingLevel === undefined
      ? base.samplingParamsByThinkingLevel
      : mergeSamplingByLevel(
          base.samplingParamsByThinkingLevel,
          override.samplingParamsByThinkingLevel,
        );
  return {
    ...baseWithoutThinkingMap,
    ...(override.reasoning === undefined ? {} : { reasoning: override.reasoning }),
    ...(override.contextWindow === undefined ? {} : { contextWindow: override.contextWindow }),
    ...(override.maxTokens === undefined ? {} : { maxTokens: override.maxTokens }),
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(promptCache === undefined ? {} : { promptCache }),
    ...(samplingParams === undefined ? {} : { samplingParams }),
    ...(samplingParamsByThinkingLevel === undefined ? {} : { samplingParamsByThinkingLevel }),
    ...(compat === undefined ? {} : { compat: compat as Model<Api>["compat"] }),
  };
}

function applyProviderModelDefaults(model: AnyModel, config: ProviderConfig): AnyModel {
  const baseUrl = config.baseUrl ?? model.baseUrl;
  if (model.type === "image") {
    return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
  }
  const compat = mergeCompat(model.compat as CompatConfig | undefined, config.compat);
  if (model.type === "classifier") {
    return {
      ...model,
      baseUrl,
      ...(compat === undefined
        ? {}
        : { compat: compat as ClassifierModel<ClassifierApi>["compat"] }),
    };
  }
  return {
    ...model,
    baseUrl,
    ...(compat === undefined ? {} : { compat: compat as Model<Api>["compat"] }),
  };
}

function transformModels(
  baseModels: readonly AnyModel[],
  config: ProviderConfig,
  providerId: string,
): AnyModel[] {
  const out: AnyModel[] = baseModels.map((model) => applyProviderModelDefaults(model, config));

  for (const entry of config.models ?? []) {
    const index = out.findIndex((model) => isChatModel(model) && model.id === entry.id);
    const replaced = index >= 0 ? out[index] : undefined;
    const built = buildEntryModel(entry, config, providerId, replaced);
    if (index >= 0) {
      out[index] = built;
    } else {
      out.push(built);
    }
  }

  for (const [modelId, override] of Object.entries(config.modelOverrides ?? {})) {
    const index = out.findIndex((model) => model.id === modelId);
    if (index >= 0) {
      const current = out[index];
      if (current !== undefined) out[index] = applyModelOverride(current, override);
    }
  }

  return out;
}

function sameModelArray(left: readonly AnyModel[], right: readonly AnyModel[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

type WrapProviderOptions = {
  readonly ensureApiKeyAuth?: boolean;
  readonly transform?: boolean;
};

function resolveModelConfigHeaders(
  config: ProviderConfig,
  modelId: string,
  env?: ComposeEnvironment,
): Record<string, string> | undefined {
  const entry = config.models?.find((candidate) => candidate.id === modelId);
  const override = config.modelOverrides?.[modelId];
  const raw = mergeHeaders(entry?.headers, override?.headers);
  return resolveHeadersStrict(raw, env, { cacheCommands: false });
}

function wrapProvider(
  base: Provider,
  config: ProviderConfig,
  env?: ComposeEnvironment,
  options: WrapProviderOptions = {},
): Provider {
  const inject = <TOptions>(model: AnyModel, streamOptions: TOptions): TOptions => {
    const headers = resolveModelConfigHeaders(config, model.id, env);
    if (!headers) return streamOptions;
    const current = isRecord(streamOptions) ? streamOptions : undefined;
    const existing = isRecord(current?.headers) ? (current.headers as ProviderHeaders) : undefined;
    return { ...current, headers: mergeHeaders(headers, existing) } as TOptions;
  };
  const baseUrl = config.baseUrl ?? base.baseUrl;
  const includeApiKey =
    (options.ensureApiKeyAuth ?? false) ||
    base.auth.apiKey !== undefined ||
    config.apiKey !== undefined ||
    hasRecognizedAuthHeader(config.headers);
  const { getAllModels, fetchDeferred, cancelDeferred, generateImages, classify } = base;

  let cachedAll:
    | {
        readonly raw: readonly AnyModel[];
        readonly all: readonly AnyModel[];
        readonly rawChat: readonly Model<Api>[];
        readonly chat: readonly Model<Api>[];
      }
    | undefined;
  let cachedChat:
    | {
        readonly raw: readonly Model<Api>[];
        readonly chat: readonly Model<Api>[];
      }
    | undefined;

  const shouldTransform = options.transform ?? true;
  const wrappedGetAllModels =
    getAllModels === undefined || !shouldTransform
      ? undefined
      : (): readonly AnyModel[] => {
          const raw = getAllModels.call(base);
          if (cachedAll !== undefined && sameModelArray(raw, cachedAll.raw)) {
            return cachedAll.all;
          }
          const all = transformModels(raw, config, base.id);
          cachedAll = {
            raw,
            all,
            rawChat: raw.filter(isChatModel),
            chat: all.filter(isChatModel),
          };
          return all;
        };
  const wrappedGetModels = !shouldTransform
    ? undefined
    : (): readonly Model<Api>[] => {
        const raw = base.getModels();
        if (cachedChat !== undefined && sameModelArray(raw, cachedChat.raw)) {
          return cachedChat.chat;
        }
        if (cachedAll !== undefined && sameModelArray(raw, cachedAll.rawChat)) {
          cachedChat = { raw, chat: cachedAll.chat };
          return cachedAll.chat;
        }
        const chat = transformModels(raw, config, base.id).filter(isChatModel);
        cachedChat = { raw, chat };
        return chat;
      };

  return {
    ...base,
    name: config.name ?? base.name,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    auth: {
      ...(includeApiKey ? { apiKey: wrapApiKeyAuth(base.auth.apiKey, config, env) } : {}),
      ...(base.auth.oauth === undefined
        ? {}
        : { oauth: wrapOAuthAuth(base.auth.oauth, config, env) }),
    },
    ...(wrappedGetModels === undefined ? {} : { getModels: wrappedGetModels }),
    ...(wrappedGetAllModels === undefined ? {} : { getAllModels: wrappedGetAllModels }),
    stream: (model, context, streamOptions) =>
      base.stream(model, context, inject(model, streamOptions)),
    streamSimple: (model, context, streamOptions) =>
      base.streamSimple(model, context, inject(model, streamOptions)),
    ...(fetchDeferred === undefined
      ? {}
      : {
          fetchDeferred: (model, handle, streamOptions) =>
            fetchDeferred(model, handle, inject(model, streamOptions)),
        }),
    ...(cancelDeferred === undefined
      ? {}
      : {
          cancelDeferred: async (model, handle, streamOptions) => {
            await cancelDeferred(model, handle, inject(model, streamOptions));
          },
        }),
    ...(generateImages === undefined
      ? {}
      : {
          generateImages: (model, context, streamOptions) =>
            generateImages(model, context, inject(model, streamOptions)),
        }),
    ...(classify === undefined
      ? {}
      : {
          classify: (model, context, streamOptions) =>
            classify(model, context, inject(model, streamOptions)),
        }),
  };
}

function requireEndpoint(config: ProviderConfig, providerId: string): void {
  if (config.baseUrl === undefined) {
    const missing = (config.models ?? []).some((entry) => entry.baseUrl === undefined);
    if (missing || (config.models ?? []).length === 0) {
      throw new ModelsConfigError(
        `providers.${providerId}`,
        "custom providers need a baseUrl at provider or model level",
      );
    }
  }
  if (config.api === undefined) {
    const missing = (config.models ?? []).some((entry) => entry.api === undefined);
    if (missing || (config.models ?? []).length === 0) {
      throw new ModelsConfigError(
        `providers.${providerId}`,
        "custom providers need an api at provider or model level",
      );
    }
  }
}

function resolveCustomProviderApis(id: string, config: ProviderConfig): Set<string> {
  requireEndpoint(config, id);
  const apis = new Set<string>();
  const authApis = new Set<string>();
  if (config.api !== undefined) authApis.add(config.api);
  for (const entry of config.models ?? []) {
    const { api } = entryEndpoint(entry, config, id, undefined);
    apis.add(api);
    authApis.add(api);
  }
  if (apis.size === 0 && config.api !== undefined) apis.add(config.api);
  for (const api of apis) {
    if (!Object.hasOwn(CHAT_API_STREAMS, api)) {
      throw new ModelsConfigError(
        `providers.${id}`,
        `unknown api "${api}"; supported: ${Object.keys(CHAT_API_STREAMS).join(", ")}`,
      );
    }
  }
  if (config.authHeader === true) {
    validateAuthHeaderApisForSet(id, authApis);
  }
  return apis;
}

function createCustomProvider(
  id: string,
  config: ProviderConfig,
  env?: ComposeEnvironment,
): Provider {
  const apis = resolveCustomProviderApis(id, config);
  const models = transformModels([], config, id);

  const streams = new Map<string, ProviderStreams>();
  for (const api of apis) {
    const factory = CHAT_API_STREAMS[api];
    if (factory !== undefined) streams.set(api, factory());
  }
  const single = streams.size === 1 ? [...streams.values()][0] : undefined;
  const apiMap: Partial<Record<Api, ProviderStreams>> | undefined =
    single === undefined ? Object.fromEntries(streams) : undefined;

  const base = createProvider({
    id,
    ...(config.name === undefined ? {} : { name: config.name }),
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    auth: {},
    models,
    ...(single === undefined ? {} : { api: single }),
    ...(apiMap === undefined ? {} : { api: apiMap }),
  });
  return wrapProvider(base, config, env, { ensureApiKeyAuth: true, transform: false });
}

function validateRadiusConfig(id: string, config: ProviderConfig): void {
  if (config.baseUrl === undefined) {
    throw new ModelsConfigError(`providers.${id}`, 'oauth "radius" requires a baseUrl');
  }
  if (config.authHeader === true) {
    throw new ModelsConfigError(
      `providers.${id}.authHeader`,
      `authHeader is not supported for oauth "radius" (api "pi-messages"); supported APIs: ${[...AUTH_HEADER_SUPPORTED_APIS].join(", ")}`,
    );
  }
}

function createRadiusProvider(id: string, config: ProviderConfig): Provider {
  validateRadiusConfig(id, config);
  return radiusProvider({
    id,
    ...(config.name === undefined ? {} : { name: config.name }),
    gateway: config.baseUrl,
  });
}

function validateBuiltinProviderConfig(
  providerId: string,
  config: ProviderConfig,
  builtinModels: readonly AnyModel[],
): void {
  const effectiveApiById = new Map<string, string>();
  for (const model of builtinModels) {
    if (isChatModel(model)) effectiveApiById.set(model.id, model.api);
  }
  for (const entry of config.models ?? []) {
    const replaced = builtinModels.find((model) => isChatModel(model) && model.id === entry.id);
    const { api } = entryEndpoint(entry, config, providerId, replaced);
    effectiveApiById.set(entry.id, api);
  }
  if (config.authHeader === true) {
    const apis = new Set<string>(effectiveApiById.values());
    if (config.api !== undefined) apis.add(config.api);
    validateAuthHeaderApisForSet(providerId, apis);
  }
}

export function validateComposedModelsConfig(config: ModelsConfig): void {
  const builtinIds = new Map(getBuiltinProviders().map((id) => [id as string, id]));
  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    const builtinId = builtinIds.get(providerId);
    if (builtinId !== undefined) {
      const models = getAllBuiltinModels(builtinId);
      validateBuiltinProviderConfig(providerId, providerConfig, models);
      continue;
    }
    if (providerConfig.oauth === "radius") {
      validateRadiusConfig(providerId, providerConfig);
      const normalizedGateway = /^https?:\/\//iu.test(providerConfig.baseUrl ?? "")
        ? (providerConfig.baseUrl ?? "").replace(/\/+$/u, "")
        : `https://${(providerConfig.baseUrl ?? "").replace(/\/+$/u, "")}`;
      const baseline =
        normalizedGateway === "https://radius.pi.dev" ? getBuiltinModels("radius") : [];
      for (const entry of providerConfig.models ?? []) {
        const replaced = baseline.find((model) => model.id === entry.id);
        entryEndpoint(entry, providerConfig, providerId, replaced);
      }
      continue;
    }
    resolveCustomProviderApis(providerId, providerConfig);
  }
}

export function composeProviders(config: ModelsConfig, options?: ComposeOptions): Provider[] {
  const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider]));
  const configured = new Map<string, Provider>();

  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    const builtin = builtins.get(providerId);
    if (builtin) {
      const wrapped = wrapProvider(builtin, providerConfig, options?.env);
      const transformed = wrapped.getAllModels?.() ?? wrapped.getModels();
      validateAuthHeaderApis(providerId, providerConfig, transformed);
      configured.set(providerId, wrapped);
      builtins.delete(providerId);
      continue;
    }
    if (providerConfig.oauth === "radius") {
      const base = createRadiusProvider(providerId, providerConfig);
      const wrapped = wrapProvider(base, providerConfig, options?.env);
      wrapped.getModels();
      configured.set(providerId, wrapped);
      continue;
    }
    configured.set(providerId, createCustomProvider(providerId, providerConfig, options?.env));
  }

  return [...builtins.values(), ...configured.values()];
}
