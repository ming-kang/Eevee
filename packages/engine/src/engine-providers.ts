import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import { ConversationBusy, type Cursor, StorageRequestError } from "@earendil-works/pi-durable";
import { ProjectError, type ProjectErrorCode } from "@eevee/core";
import type {
  ListModelsResponse,
  ListProvidersResponse,
  ModelInfo,
  OkResponse,
  RefreshModelsRequest,
  RefreshModelsResponse,
  SetApiKeyRequest,
} from "@eevee/protocol";
import { EngineError } from "./engine-error.ts";

export type ProviderDeps = {
  readonly models: () => Models;
  readonly credentials: () => CredentialStore | undefined;
};

export async function listProviders(deps: ProviderDeps): Promise<ListProvidersResponse> {
  const models = deps.models();
  const providers = await Promise.all(
    models.getProviders().map(async (provider) => {
      const check = await models.checkAuth(provider.id);
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
          ...(provider.auth.oauth?.name === undefined
            ? {}
            : { oauthName: provider.auth.oauth.name }),
          ...(provider.auth.oauth?.loginLabel === undefined
            ? {}
            : { oauthLabel: provider.auth.oauth.loginLabel }),
        },
        configured: check !== undefined,
        ...(check === undefined ? {} : { authType: check.type }),
        ...(check?.source === undefined ? {} : { authSource: check.source }),
        modelCount,
      };
    }),
  );
  return { providers };
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
    });
  }
  return { models: items };
}

export async function refreshModels(
  deps: ProviderDeps,
  input: RefreshModelsRequest = {},
): Promise<RefreshModelsResponse> {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  if (raw.length === 0 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new EngineError(400, "invalid_query", "Invalid pagination cursor");
  }
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (!isPlainObject(parsed)) {
      throw new EngineError(400, "invalid_query", "Invalid pagination cursor");
    }
    return parsed as Cursor;
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError(400, "invalid_query", "Invalid pagination cursor");
  }
}

const PROJECT_ERROR_HTTP: Record<ProjectErrorCode, readonly [status: number, code: string]> = {
  worker_not_found: [404, "worker_not_found"],
  worker_closed: [409, "worker_closed"],
  worker_queued: [409, "worker_queued"],
  question_not_found: [404, "question_not_found"],
  question_closed: [409, "question_closed"],
  invalid_answer: [400, "invalid_request"],
  task_not_found: [404, "task_not_found"],
  task_not_running: [409, "task_not_running"],
};

export function toEngineError(error: unknown): unknown {
  if (error instanceof ProjectError) {
    const [status, code] = PROJECT_ERROR_HTTP[error.code];
    return new EngineError(status, code, error.message);
  }
  if (error instanceof ConversationBusy) {
    return new EngineError(409, "conversation_busy", error.message);
  }
  if (error instanceof StorageRequestError) {
    return new EngineError(400, "invalid_query", error.message);
  }
  if (error instanceof RangeError) {
    return new EngineError(400, "invalid_request", error.message);
  }
  return error;
}
