/**
 * Applies `~/.eevee/models.json` to pi-ai's models: composes the providers it adds and changes. The file's format
 * and schema are its contract, in `src/config/models.ts`.
 */
import {
  type Api,
  type ApiKeyAuth,
  type AuthContext,
  type AuthResult,
  isModelType,
  type Model,
  type ModelAuth,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import {
  ConfigError,
  configIssue,
  loadConfig,
  processEnv,
  resolveConfigValue,
} from "../../config/load.ts";
import {
  type ModelDefinition,
  type ModelOverride,
  type ModelsConfig,
  ModelsConfigSchema,
  type ProviderConfig,
} from "../../config/models.ts";
import type { ConfigIssue, ConfigProblem } from "../../domain/index.ts";

export const loadModelsConfig = (path: string): Promise<ModelsConfig> =>
  loadConfig(ModelsConfigSchema, path, {});

/** Chat API implementations a custom model can name in `api`. */
const APIS: Record<string, () => ProviderStreams> = {
  "anthropic-messages": anthropicMessagesApi,
  "azure-openai-responses": azureOpenAIResponsesApi,
  "bedrock-converse-stream": bedrockConverseStreamApi,
  "google-generative-ai": googleGenerativeAIApi,
  "google-vertex": googleVertexApi,
  "mistral-conversations": mistralConversationsApi,
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "pi-messages": piMessagesApi,
};

/**
 * Applies the config to `models`. A provider whose entry is broken keeps its built-in form (or is not added)
 * and its problem is returned, so one mistake does not take every model away.
 */
export function applyModelsConfig(
  models: MutableModels,
  config: ModelsConfig,
  applied?: Set<string>,
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  for (const [id, entry] of Object.entries(config.providers ?? {})) {
    try {
      models.setProvider(composeProvider(id, models.getProvider(id), entry));
      applied?.add(id);
    } catch (error) {
      problems.push({ ...configIssue(error), file: "models.json", entry: id });
    }
  }
  return problems;
}

export function composeProvider(
  id: string,
  base: Provider | undefined,
  config: ProviderConfig,
): Provider {
  const chatModels = (): Model<Api>[] => {
    const models = (base?.getModels() ?? []).map((m) => ({
      ...m,
      baseUrl: config.baseUrl ?? m.baseUrl,
    }));
    for (const definition of config.models ?? []) {
      const model = fromDefinition(id, definition, config, models);
      const at = models.findIndex((m) => m.id === model.id);
      if (at >= 0) models[at] = model;
      else models.push(model);
    }
    return models.map((m) => withOverride(m, config.modelOverrides?.[m.id]));
  };
  const known = chatModels();
  if (base === undefined && known.length === 0) throw issue(id, { code: "needs_models" });
  for (const model of known) {
    if (!supports(base, model) && APIS[model.api] === undefined) {
      throw issue(id, { code: "unsupported_api", model: model.id, api: model.api });
    }
  }

  const streamsOf = (model: Model<Api>): ProviderStreams => {
    if (base !== undefined && supports(base, model)) return base;
    const api = APIS[model.api];
    if (api === undefined) throw new Error(`Model ${model.id}: api “${model.api}” isn't supported`);
    return api();
  };
  const apiKey = composeApiKeyAuth(base, config);
  const oauth = base?.auth.oauth;

  const provider: Provider = {
    id,
    name: config.name ?? base?.name ?? id,
    ...((config.baseUrl ?? base?.baseUrl) ? { baseUrl: config.baseUrl ?? base?.baseUrl } : {}),
    ...(base?.headers === undefined ? {} : { headers: base.headers }),
    auth: {
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(oauth === undefined
        ? {}
        : {
            oauth: {
              ...oauth,
              toAuth: async (credential) =>
                withConfiguredAuth(await oauth.toAuth(credential), config, processEnv),
            },
          }),
    },
    getModels: chatModels,
    stream: (model, context, options) => streamsOf(model).stream(model, context, options),
    streamSimple: (model, context, options) =>
      streamsOf(model).streamSimple(model, context, options),
  };
  if (provider.auth.apiKey === undefined && provider.auth.oauth === undefined) {
    throw issue(id, { code: "no_auth" });
  }
  if (base?.getAllModels !== undefined) {
    const all = base.getAllModels.bind(base);
    provider.getAllModels = () => [
      ...chatModels(),
      ...all()
        .filter((m) => !isModelType(m, "chat"))
        .map((m) => ({ ...m, baseUrl: config.baseUrl ?? m.baseUrl })),
    ];
  }
  if (base?.refreshModels !== undefined) {
    const refresh = base.refreshModels.bind(base);
    Object.assign(provider, {
      refreshModels: refresh,
      ...(base.refreshModelsAuth === undefined
        ? {}
        : { refreshModelsAuth: base.refreshModelsAuth }),
    });
  }
  if (base?.filterModels !== undefined) provider.filterModels = base.filterModels.bind(base);
  if (base?.filterAllModels !== undefined)
    provider.filterAllModels = base.filterAllModels.bind(base);
  if (base?.fetchDeferred !== undefined) provider.fetchDeferred = base.fetchDeferred.bind(base);
  if (base?.cancelDeferred !== undefined) provider.cancelDeferred = base.cancelDeferred.bind(base);
  if (base?.generateImages !== undefined) provider.generateImages = base.generateImages.bind(base);
  if (base?.classify !== undefined) provider.classify = base.classify.bind(base);
  return provider;
}

const issue = (provider: string, what: ConfigIssue): ConfigError =>
  new ConfigError([{ ...what, file: "models.json", entry: provider }]);

const supports = (base: Provider | undefined, model: Model<Api>): boolean =>
  base?.getModels().some((m) => m.api === model.api) ?? false;

function fromDefinition(
  providerId: string,
  definition: ModelDefinition,
  config: ProviderConfig,
  existing: readonly Model<Api>[],
): Model<Api> {
  const template = existing.find((m) => m.id === definition.id);
  const api = definition.api ?? config.api ?? template?.api;
  if (api === undefined) throw issue(providerId, { code: "needs_api", model: definition.id });
  const baseUrl = definition.baseUrl ?? config.baseUrl ?? template?.baseUrl;
  if (baseUrl === undefined) {
    throw issue(providerId, { code: "needs_base_url", model: definition.id });
  }
  const model: Model<Api> = {
    id: definition.id,
    name: definition.id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  return withOverride(model, definition);
}

function withOverride(model: Model<Api>, override: ModelOverride | undefined): Model<Api> {
  if (override === undefined) return model;
  return {
    ...model,
    ...(override.name === undefined ? {} : { name: override.name }),
    ...(override.reasoning === undefined ? {} : { reasoning: override.reasoning }),
    ...(override.input === undefined ? {} : { input: [...override.input] }),
    ...(override.contextWindow === undefined ? {} : { contextWindow: override.contextWindow }),
    ...(override.maxTokens === undefined ? {} : { maxTokens: override.maxTokens }),
    ...(override.cost === undefined ? {} : { cost: { ...model.cost, ...override.cost } }),
    ...(override.promptCache === undefined
      ? {}
      : { promptCache: { ...model.promptCache, ...override.promptCache } }),
    ...(override.headers === undefined
      ? {}
      : { headers: { ...model.headers, ...override.headers } }),
  };
}

type Env = (name: string) => Promise<string | undefined>;

/**
 * The provider's api-key auth with the config layered on: a stored key wins, then `apiKey`, then the
 * built-in resolution (environment variables and the like); configured headers go on every result.
 */
function composeApiKeyAuth(
  base: Provider | undefined,
  config: ProviderConfig,
): ApiKeyAuth | undefined {
  const inherited = base?.auth.apiKey;
  const raw = config.apiKey;
  if (inherited === undefined && raw === undefined && base?.auth.oauth !== undefined)
    return undefined;
  const configured = async (ctx: AuthContext) =>
    raw === undefined ? undefined : resolveConfigValue(raw, (name) => ctx.env(name));

  const resolveBase = async (
    input: Parameters<ApiKeyAuth["resolve"]>[0],
  ): Promise<AuthResult | undefined> => {
    if (input.credential?.key) {
      return inherited
        ? inherited.resolve(input)
        : { auth: { apiKey: input.credential.key }, source: "auth.json" };
    }
    const key = await configured(input.ctx);
    if (key !== undefined) {
      return inherited
        ? inherited.resolve({ ...input, credential: { type: "api_key", key } })
        : { auth: { apiKey: key }, source: "models.json" };
    }
    return inherited?.resolve(input);
  };

  return {
    name: inherited?.name ?? "API key",
    login:
      inherited?.login ??
      (async (interaction) => ({
        type: "api_key",
        key: await interaction.prompt({ type: "secret", message: "API key" }),
      })),
    async check(input) {
      if (input.credential?.key) return { type: "api_key", source: "auth.json" };
      if ((await configured(input.ctx)) !== undefined)
        return { type: "api_key", source: "models.json" };
      if (inherited?.check) return inherited.check(input);
      const resolved = await inherited?.resolve(input);
      return resolved === undefined
        ? undefined
        : { type: "api_key", source: resolved.source ?? "" };
    },
    async resolve(input) {
      const result = await resolveBase(input);
      if (result === undefined) return undefined;
      return {
        ...result,
        auth: await withConfiguredAuth(result.auth, config, (n) => input.ctx.env(n)),
      };
    },
  };
}

async function withConfiguredAuth(
  auth: ModelAuth,
  config: ProviderConfig,
  env: Env,
): Promise<ModelAuth> {
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(config.headers ?? {})) {
    const value = await resolveConfigValue(raw, env);
    if (value === undefined)
      throw new Error(`Header ${name} refers to an environment variable that isn't set`);
    headers[name] = value;
  }
  if (config.authHeader) {
    if (!auth.apiKey) throw new Error("authHeader needs an API key");
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  return Object.keys(headers).length === 0
    ? auth
    : { ...auth, headers: { ...auth.headers, ...headers } };
}
