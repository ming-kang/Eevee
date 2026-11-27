import {
  type CredentialStore,
  getSupportedThinkingLevels,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";
import { isBuiltinProviderId, type ModelRuntime, type ModelsConfig } from "@eevee/agent/models";
import type {
  ListModelsResponse,
  ListProvidersResponse,
  ModelInfo,
  OkResponse,
  ProviderSummary,
  RefreshModelsRequest,
  RefreshModelsResponse,
  SetApiKeyRequest,
} from "@eevee/protocol";
import { EngineError } from "./engine-error.ts";

export type ProviderDeps = {
  readonly models: () => Models;
  readonly credentials: () => CredentialStore | undefined;
  readonly runtime?: () => ModelRuntime;
  readonly modelsFile?: () => string;
  readonly fetch?: typeof globalThis.fetch;
};

export type ProviderSummaryContext = {
  readonly models?: Models;
  readonly runtime?: ModelRuntime;
  readonly config?: ModelsConfig;
};

export async function summarizeProvider(
  deps: ProviderDeps,
  provider: Provider,
  context?: ProviderSummaryContext,
): Promise<ProviderSummary> {
  const models = context?.models ?? deps.models();
  const runtime = context?.runtime ?? deps.runtime?.();
  const config = context?.config ?? runtime?.config();
  const check = await models.checkAuth(provider.id);
  const auth = runtime ? await runtime.getAuthSummary(provider.id) : undefined;
  const providerConfig = config?.providers[provider.id];
  let modelCount = 0;
  try {
    modelCount = provider.getModels().length;
  } catch {
    modelCount = 0;
  }
  return {
    id: provider.id,
    name: provider.name,
    ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
    authMethods: {
      apiKey: provider.auth.apiKey !== undefined,
      apiKeyLogin: provider.auth.apiKey?.login !== undefined,
      oauth: provider.auth.oauth !== undefined,
      ...(provider.auth.oauth?.name === undefined ? {} : { oauthName: provider.auth.oauth.name }),
      ...(provider.auth.oauth?.loginLabel === undefined
        ? {}
        : { oauthLabel: provider.auth.oauth.loginLabel }),
    },
    configured: auth?.configured ?? check !== undefined,
    ...((auth?.type ?? check?.type) === undefined ? {} : { authType: auth?.type ?? check?.type }),
    ...((auth?.source ?? check?.source) === undefined
      ? {}
      : { authSource: auth?.source ?? check?.source }),
    modelCount,
    kind: isBuiltinProviderId(provider.id) ? ("builtin" as const) : ("custom" as const),
    ...(providerConfig?.api === undefined ? {} : { api: providerConfig.api }),
    hasConfigOverride: providerConfig !== undefined,
    customModelCount: providerConfig?.models?.length ?? 0,
    overrideCount: Object.keys(providerConfig?.modelOverrides ?? {}).length,
    ...(auth?.preview === undefined ? {} : { authPreview: auth.preview }),
    ...(auth?.accountLabel === undefined ? {} : { authAccountLabel: auth.accountLabel }),
    ...(auth?.expiresAt === undefined ? {} : { authExpiresAt: auth.expiresAt }),
  };
}

export async function listProviders(deps: ProviderDeps): Promise<ListProvidersResponse> {
  const models = deps.models();
  const runtime = deps.runtime?.();
  const config = runtime?.config();
  const providers = await Promise.all(
    models
      .getProviders()
      .map((provider) => summarizeProvider(deps, provider, { models, runtime, config })),
  );
  return { providers, diagnostics: [...(runtime?.configDiagnostics() ?? [])] };
}

export async function setProviderApiKey(
  deps: ProviderDeps,
  providerId: string,
  input: SetApiKeyRequest,
): Promise<OkResponse> {
  const models = deps.models();
  const provider = models.getProvider(providerId);
  if (provider === undefined) {
    throw new EngineError(404, "provider_not_found", `Unknown provider ${providerId}`);
  }
  if (provider.auth.apiKey === undefined) {
    throw new EngineError(
      400,
      "auth_unsupported",
      `Provider ${providerId} does not support API key authentication`,
    );
  }
  if (
    (input.key === undefined && input.env === undefined) ||
    (input.key !== undefined && input.key.length === 0 && input.env === undefined)
  ) {
    throw new EngineError(400, "invalid_request", "API key request must provide key or env");
  }

  const credentials = deps.credentials();
  if (credentials !== undefined) {
    await credentials.modify(providerId, async () => ({
      type: "api_key",
      ...(input.key === undefined ? {} : { key: input.key }),
      ...(input.env === undefined ? {} : { env: input.env }),
    }));
    return { ok: true };
  }

  if (provider.auth.apiKey.login !== undefined && input.key !== undefined) {
    await models.login(providerId, "api_key", {
      prompt: async () => input.key ?? "",
      notify: () => {},
    });
    return { ok: true };
  }

  throw new EngineError(
    500,
    "credentials_unavailable",
    `Credential store is unavailable for provider ${providerId}`,
  );
}

export async function logoutProvider(deps: ProviderDeps, providerId: string): Promise<OkResponse> {
  const models = deps.models();
  if (models.getProvider(providerId) === undefined) {
    throw new EngineError(404, "provider_not_found", `Unknown provider ${providerId}`);
  }
  await models.logout(providerId);
  return { ok: true };
}

export async function listModels(
  deps: ProviderDeps,
  opts?: {
    readonly provider?: string;
    readonly available?: boolean;
  },
): Promise<ListModelsResponse> {
  const models = deps.models();
  const [catalog, availableModels] = await Promise.all([
    Promise.resolve(models.getModels(opts?.provider)),
    models.getAvailable(opts?.provider),
  ]);
  const availableKeys = new Set(availableModels.map((model) => `${model.provider}\0${model.id}`));
  const config = deps.runtime?.().config();
  const items: ModelInfo[] = [];
  for (const model of catalog) {
    const available = availableKeys.has(`${model.provider}\0${model.id}`);
    if (opts?.available !== undefined && available !== opts.available) continue;
    items.push({
      provider: model.provider,
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: model.cost,
      available,
      input: [...model.input],
      supportedThinkingLevels: getSupportedThinkingLevels(model),
      isCustom:
        config?.providers[model.provider]?.models?.some((entry) => entry.id === model.id) ?? false,
      hasOverride: config?.providers[model.provider]?.modelOverrides?.[model.id] !== undefined,
    });
  }
  return { models: items };
}

export async function refreshModels(
  deps: ProviderDeps,
  input: RefreshModelsRequest = {},
): Promise<RefreshModelsResponse> {
  await deps.runtime?.().reload();
  const result = await deps.models().refresh({
    ...(input.providers === undefined ? {} : { providers: input.providers }),
    ...(input.force === undefined ? {} : { force: input.force }),
  });
  const errors: Record<string, string> = {};
  for (const [providerId, error] of result.errors) {
    errors[providerId] = error.message;
  }
  return { refreshed: true, errors };
}
