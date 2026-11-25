import {
  type AnyModel,
  type Api,
  type ApiKeyAuth,
  type AuthCheck,
  type AuthResult,
  createProvider,
  type Model,
  type ModelAuth,
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
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import {
  isConfigValueConfigured,
  resolveConfigValue,
  resolveHeaders,
} from "../shared/config-value.ts";
import {
  type CompatConfig,
  type ModelEntryConfig,
  type ModelOverrideConfig,
  type ModelsConfig,
  ModelsConfigError,
  type ProviderConfig,
} from "./model-config.ts";

export type ComposeEnvironment = Readonly<Record<string, string | undefined>>;

export type ComposeOptions = {
  readonly env?: ComposeEnvironment;
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const CHAT_API_STREAMS: Readonly<Record<string, () => ProviderStreams>> = {
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
): Record<string, string> | undefined {
  if (!base && !override) return undefined;
  const merged: Record<string, string> = { ...base };
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
  const merged: Record<string, unknown> = { ...base, ...override };
  for (const key of COMPAT_NESTED_KEYS) {
    const baseValue = (base as Record<string, unknown>)[key];
    const overrideValue = (override as Record<string, unknown>)[key];
    if (
      (typeof baseValue === "object" && baseValue !== null) ||
      (typeof overrideValue === "object" && overrideValue !== null)
    ) {
      merged[key] = {
        ...(baseValue as object | undefined),
        ...(overrideValue as object | undefined),
      };
    }
  }
  return merged as CompatConfig;
}

function mergeDefined<T extends object>(
  base: T | undefined,
  override: Partial<T> | undefined,
): T | undefined {
  if (!base && !override) return undefined;
  return { ...base, ...override } as T;
}

type InputLimitsShape = {
  images?: {
    resize?: { maxWidth?: number; maxHeight?: number; maxBytes?: number };
    supportedTypes?: readonly string[];
  };
};

function mergeInputLimits(
  base: InputLimitsShape | undefined,
  override: InputLimitsShape | undefined,
): InputLimitsShape | undefined {
  if (!base && !override) return undefined;
  if (!base || !override) return { ...(base ?? override) } as InputLimitsShape;
  const merged: InputLimitsShape = { ...base, ...override };
  if (base.images !== undefined || override.images !== undefined) {
    merged.images = {
      ...(base.images ?? {}),
      ...(override.images ?? {}),
    } as NonNullable<InputLimitsShape["images"]>;
    if (base.images?.resize !== undefined || override.images?.resize !== undefined) {
      merged.images.resize = {
        ...(base.images?.resize ?? {}),
        ...(override.images?.resize ?? {}),
      };
    }
  }
  return merged;
}

function resolveProviderConfigHeaders(
  config: ProviderConfig,
  env?: ComposeEnvironment,
): Record<string, string> | undefined {
  return resolveHeaders(config.headers, env);
}

function withConfigHeaders(
  auth: ModelAuth,
  config: ProviderConfig,
  env?: ComposeEnvironment,
): ModelAuth {
  const configHeaders = resolveProviderConfigHeaders(config, env);
  let headers = mergeHeaders(auth.headers as Record<string, string> | undefined, configHeaders);
  let apiKey = auth.apiKey;
  if (config.authHeader === true && apiKey !== undefined) {
    headers = { ...headers, Authorization: `Bearer ${apiKey}` };
    apiKey = undefined;
  }
  if (!headers) return apiKey === auth.apiKey ? auth : { ...auth, apiKey };
  const result: ModelAuth = { ...auth, headers: headers as ProviderHeaders };
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
        config.apiKey === undefined ? undefined : resolveConfigValue(config.apiKey, env);
      if (configKey !== undefined) {
        return apiKeyAuthResult(config, configKey, "models.json", undefined, env);
      }
      if (delegate) {
        const result = await delegate.resolve(input);
        if (!result) return undefined;
        return { ...result, auth: withConfigHeaders(result.auth, config, env) };
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
      if (delegate?.check) return delegate.check(input);
      if (delegate) {
        const result = await delegate.resolve(input);
        return result === undefined ? undefined : { type: "api_key", source: result.source };
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
  const model: Model<Api> = {
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
  };
  if (entry.inputLimits !== undefined) model.inputLimits = entry.inputLimits;
  if (entry.thinkingLevelMap !== undefined) model.thinkingLevelMap = entry.thinkingLevelMap;
  if (entry.promptCache !== undefined) model.promptCache = entry.promptCache;
  if (entry.samplingParams !== undefined) model.samplingParams = entry.samplingParams;
  if (entry.samplingParamsByThinkingLevel !== undefined) {
    model.samplingParamsByThinkingLevel = entry.samplingParamsByThinkingLevel;
  }
  const compat = mergeCompat(config.compat, entry.compat);
  if (compat !== undefined) {
    (model as { compat?: unknown }).compat = compat;
  }
  return model;
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

function applyModelOverride(
  model: AnyModel,
  override: ModelOverrideConfig,
  config: ProviderConfig,
): AnyModel {
  const merged: Record<string, unknown> = { ...model };
  if (override.name !== undefined) merged.name = override.name;
  if (override.reasoning !== undefined) merged.reasoning = override.reasoning;
  if (override.contextWindow !== undefined) merged.contextWindow = override.contextWindow;
  if (override.maxTokens !== undefined) merged.maxTokens = override.maxTokens;
  if (override.input !== undefined) merged.input = [...override.input];
  if (override.inputLimits !== undefined) {
    merged.inputLimits = mergeInputLimits(
      model.inputLimits as InputLimitsShape | undefined,
      override.inputLimits as InputLimitsShape | undefined,
    );
  }
  if (override.cost !== undefined) {
    merged.cost = mergeDefined(model.cost, override.cost);
  }
  if (override.promptCache !== undefined) {
    merged.promptCache = mergeDefined(
      (model as { promptCache?: object }).promptCache as never,
      override.promptCache as never,
    );
  }
  if (override.thinkingLevelMap !== undefined) {
    merged.thinkingLevelMap = mergeDefined(
      (model as { thinkingLevelMap?: object }).thinkingLevelMap as never,
      override.thinkingLevelMap as never,
    );
  }
  if (isChatModel(model)) {
    if (override.samplingParams !== undefined) {
      merged.samplingParams = mergeDefined(model.samplingParams, override.samplingParams);
    }
    if (override.samplingParamsByThinkingLevel !== undefined) {
      merged.samplingParamsByThinkingLevel = mergeSamplingByLevel(
        model.samplingParamsByThinkingLevel,
        override.samplingParamsByThinkingLevel,
      );
    }
  }
  const baseCompat = (model as { compat?: CompatConfig }).compat;
  const compat = mergeCompat(mergeCompat(baseCompat, config.compat), override.compat);
  if (compat !== undefined) merged.compat = compat;
  return merged as unknown as AnyModel;
}

function transformModels(
  baseModels: readonly AnyModel[],
  config: ProviderConfig,
  providerId: string,
): AnyModel[] {
  const out: AnyModel[] = baseModels.map((model) => {
    const copy = { ...model } as Record<string, unknown>;
    if (config.baseUrl !== undefined) copy.baseUrl = config.baseUrl;
    const compat = mergeCompat((model as { compat?: CompatConfig }).compat, config.compat);
    if (compat !== undefined) copy.compat = compat;
    return copy as unknown as AnyModel;
  });

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
      if (current !== undefined) out[index] = applyModelOverride(current, override, config);
    }
  }

  return out;
}

function resolveModelConfigHeaders(
  config: ProviderConfig,
  modelId: string,
  env?: ComposeEnvironment,
): Record<string, string> | undefined {
  const entry = config.models?.find((candidate) => candidate.id === modelId);
  const override = config.modelOverrides?.[modelId];
  const raw = mergeHeaders(entry?.headers, override?.headers);
  return resolveHeaders(raw, env);
}

function wrapProvider(base: Provider, config: ProviderConfig, env?: ComposeEnvironment): Provider {
  const inject = <TOptions>(model: AnyModel, options: TOptions): TOptions => {
    const headers = resolveModelConfigHeaders(config, model.id, env);
    if (!headers) return options;
    const existing =
      typeof options === "object" && options !== null
        ? (options as { headers?: Record<string, string> }).headers
        : undefined;
    const merged = mergeHeaders(headers, existing);
    return { ...(options as object), headers: merged as ProviderHeaders } as TOptions;
  };
  const transform = (models: readonly AnyModel[]): AnyModel[] =>
    transformModels(models, config, base.id);
  const chatOnly = (models: readonly AnyModel[]): Model<Api>[] =>
    transform(models).filter(isChatModel);

  const provider: Provider = {
    id: base.id,
    name: config.name ?? base.name,
    auth: {
      ...(base.auth.apiKey || config.apiKey !== undefined
        ? { apiKey: wrapApiKeyAuth(base.auth.apiKey, config, env) }
        : {}),
      ...(base.auth.oauth === undefined
        ? {}
        : { oauth: wrapOAuthAuth(base.auth.oauth, config, env) }),
    },
    getModels: () => {
      try {
        return chatOnly(base.getModels());
      } catch {
        return [];
      }
    },
    stream: (model, context, options) =>
      base.stream(model, context, inject(model, options) as typeof options),
    streamSimple: (model, context, options) =>
      base.streamSimple(model, context, inject(model, options) as typeof options),
  };

  if (config.baseUrl !== undefined || base.baseUrl !== undefined) {
    (provider as { baseUrl?: string }).baseUrl = config.baseUrl ?? base.baseUrl;
  }
  if (base.headers !== undefined) {
    (provider as { headers?: ProviderHeaders }).headers = base.headers;
  }

  const baseAll = base.getAllModels;
  if (baseAll) {
    provider.getAllModels = () => {
      try {
        return transform(baseAll.call(base));
      } catch {
        return [];
      }
    };
  }
  if (base.refreshModels) {
    const refresh = base.refreshModels;
    provider.refreshModels = (context) => refresh.call(base, context);
  }
  if (base.refreshModelsAuth !== undefined) {
    (provider as { refreshModelsAuth?: "credential" | "configured" }).refreshModelsAuth =
      base.refreshModelsAuth;
  }
  if (base.filterModels) {
    const filter = base.filterModels;
    provider.filterModels = (models, credential) => filter(models, credential);
  }
  if (base.filterAllModels) {
    const filter = base.filterAllModels;
    provider.filterAllModels = (models, credential) => filter(models, credential);
  }
  if (base.fetchDeferred) {
    const fetchDeferred = base.fetchDeferred;
    provider.fetchDeferred = (model, handle, options) =>
      fetchDeferred(model, handle, inject(model, options) as typeof options);
  }
  if (base.cancelDeferred) {
    const cancelDeferred = base.cancelDeferred;
    provider.cancelDeferred = async (model, handle, options) => {
      await cancelDeferred(model, handle, inject(model, options) as typeof options);
    };
  }
  if (base.generateImages) {
    const generateImages = base.generateImages;
    provider.generateImages = (model, context, options) =>
      generateImages(model, context, inject(model, options) as typeof options);
  }
  if (base.classify) {
    const classify = base.classify;
    provider.classify = (model, context, options) =>
      classify(model, context, inject(model, options) as typeof options);
  }
  return provider;
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

function createCustomProvider(
  id: string,
  config: ProviderConfig,
  env?: ComposeEnvironment,
): Provider {
  requireEndpoint(config, id);
  const placeholder = transformModels([], config, id).filter(isChatModel);
  const apis = new Set<string>();
  for (const model of placeholder) apis.add(model.api);
  if (apis.size === 0 && config.api !== undefined) apis.add(config.api);

  const streams = new Map<string, ProviderStreams>();
  for (const api of apis) {
    const factory = CHAT_API_STREAMS[api];
    if (factory === undefined) {
      throw new ModelsConfigError(
        `providers.${id}`,
        `unknown api "${api}"; supported: ${Object.keys(CHAT_API_STREAMS).join(", ")}`,
      );
    }
    streams.set(api, factory());
  }
  const single = streams.size === 1 ? [...streams.values()][0] : undefined;
  const apiMap = single === undefined ? Object.fromEntries(streams) : undefined;

  return createProvider({
    id,
    ...(config.name === undefined ? {} : { name: config.name }),
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    auth: { apiKey: wrapApiKeyAuth(undefined, config, env) },
    models: [],
    ...(single === undefined ? {} : { api: single }),
    ...(apiMap === undefined ? {} : { api: apiMap as never }),
  });
}

function createRadiusProvider(id: string, config: ProviderConfig): Provider {
  if (config.baseUrl === undefined) {
    throw new ModelsConfigError(`providers.${id}`, 'oauth "radius" requires a baseUrl');
  }
  return radiusProvider({
    id,
    ...(config.name === undefined ? {} : { name: config.name }),
    gateway: config.baseUrl,
  });
}

export function composeProviders(config: ModelsConfig, options?: ComposeOptions): Provider[] {
  const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider]));
  const configured = new Map<string, Provider>();

  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    const builtin = builtins.get(providerId);
    if (builtin) {
      const wrapped = wrapProvider(builtin, providerConfig, options?.env);
      transformModels(builtin.getAllModels?.() ?? builtin.getModels(), providerConfig, providerId);
      configured.set(providerId, wrapped);
      builtins.delete(providerId);
      continue;
    }
    const base =
      providerConfig.oauth === "radius"
        ? createRadiusProvider(providerId, providerConfig)
        : createCustomProvider(providerId, providerConfig, options?.env);
    configured.set(providerId, wrapProvider(base, providerConfig, options?.env));
  }

  return [...builtins.values(), ...configured.values()];
}
