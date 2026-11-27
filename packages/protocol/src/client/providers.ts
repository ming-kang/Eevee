import { type OkResponse, OkResponseSchema } from "../schemas/common.ts";
import {
  type BuiltinModelMatchRequest,
  type BuiltinModelMatchResponse,
  BuiltinModelMatchResponseSchema,
  type ImportProviderModelsRequest,
  type ImportProviderModelsResponse,
  ImportProviderModelsResponseSchema,
  type ListModelsResponse,
  ListModelsResponseSchema,
  type ListProvidersResponse,
  ListProvidersResponseSchema,
  type LoginAuthEvent,
  LoginAuthEventSchema,
  type LoginCompleteEvent,
  LoginCompleteEventSchema,
  type LoginErrorEvent,
  LoginErrorEventSchema,
  type LoginInputRequest,
  type LoginPromptEvent,
  LoginPromptEventSchema,
  type ModelProfilesDocument,
  ModelProfilesDocumentSchema,
  type ProbeProviderRequest,
  type ProbeProviderResponse,
  ProbeProviderResponseSchema,
  type ProviderCatalogResponse,
  ProviderCatalogResponseSchema,
  type ProviderDetailResponse,
  ProviderDetailResponseSchema,
  type RefreshModelsRequest,
  type RefreshModelsResponse,
  RefreshModelsResponseSchema,
  type ReloadModelsResponse,
  ReloadModelsResponseSchema,
  type SetApiKeyRequest,
  type SmokeTestModelRequest,
  type SmokeTestModelResponse,
  SmokeTestModelResponseSchema,
  type StartLoginRequest,
  type StartLoginResponse,
  StartLoginResponseSchema,
  type UpsertProviderModelRequest,
  type UpsertProviderRequest,
} from "../schemas/providers.ts";
import { buildQuery, type HttpTransport } from "./transport.ts";

export type ListModelsOptions = {
  readonly provider?: string;
  readonly available?: boolean;
  readonly signal?: AbortSignal;
};

export type StreamLoginOptions = {
  readonly signal?: AbortSignal;
};

export type LoginStreamEvent =
  | { readonly type: "auth"; readonly event: LoginAuthEvent }
  | { readonly type: "prompt"; readonly prompt: LoginPromptEvent }
  | { readonly type: "complete"; readonly complete: LoginCompleteEvent }
  | { readonly type: "error"; readonly error: LoginErrorEvent };

export function createProvidersClient(transport: HttpTransport) {
  return {
    listProviders(signal?: AbortSignal): Promise<ListProvidersResponse> {
      return transport.get("/providers", ListProvidersResponseSchema, signal);
    },

    getProviderCatalog(signal?: AbortSignal): Promise<ProviderCatalogResponse> {
      return transport.get("/providers/catalog", ProviderCatalogResponseSchema, signal);
    },

    getProviderDetail(providerId: string, signal?: AbortSignal): Promise<ProviderDetailResponse> {
      return transport.get(
        `/providers/${encodeURIComponent(providerId)}`,
        ProviderDetailResponseSchema,
        signal,
      );
    },

    createProvider(
      input: UpsertProviderRequest,
      signal?: AbortSignal,
    ): Promise<ProviderDetailResponse> {
      return transport.post("/providers", ProviderDetailResponseSchema, input, signal);
    },

    updateProvider(
      providerId: string,
      input: UpsertProviderRequest,
      signal?: AbortSignal,
    ): Promise<ProviderDetailResponse> {
      return transport.patch(
        `/providers/${encodeURIComponent(providerId)}`,
        ProviderDetailResponseSchema,
        input,
        signal,
      );
    },

    deleteProvider(providerId: string, signal?: AbortSignal): Promise<OkResponse> {
      return transport.del(
        `/providers/${encodeURIComponent(providerId)}`,
        OkResponseSchema,
        signal,
      );
    },

    createProviderModel(
      providerId: string,
      input: UpsertProviderModelRequest,
      signal?: AbortSignal,
    ): Promise<ProviderDetailResponse> {
      return transport.post(
        `/providers/${encodeURIComponent(providerId)}/models`,
        ProviderDetailResponseSchema,
        input,
        signal,
      );
    },

    updateProviderModel(
      providerId: string,
      modelId: string,
      input: UpsertProviderModelRequest,
      signal?: AbortSignal,
    ): Promise<ProviderDetailResponse> {
      return transport.patch(
        `/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`,
        ProviderDetailResponseSchema,
        input,
        signal,
      );
    },

    deleteProviderModel(
      providerId: string,
      modelId: string,
      signal?: AbortSignal,
    ): Promise<ProviderDetailResponse> {
      return transport.del(
        `/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`,
        ProviderDetailResponseSchema,
        signal,
      );
    },

    probeDraftProvider(
      input: ProbeProviderRequest,
      signal?: AbortSignal,
    ): Promise<ProbeProviderResponse> {
      return transport.post("/providers/probe", ProbeProviderResponseSchema, input, signal);
    },

    probeProvider(
      providerId: string,
      input: ProbeProviderRequest = {},
      signal?: AbortSignal,
    ): Promise<ProbeProviderResponse> {
      return transport.post(
        `/providers/${encodeURIComponent(providerId)}/probe`,
        ProbeProviderResponseSchema,
        input,
        signal,
      );
    },

    importProviderModels(
      providerId: string,
      input: ImportProviderModelsRequest,
      signal?: AbortSignal,
    ): Promise<ImportProviderModelsResponse> {
      return transport.post(
        `/providers/${encodeURIComponent(providerId)}/models/import`,
        ImportProviderModelsResponseSchema,
        input,
        signal,
      );
    },

    matchBuiltinModel(
      providerId: string,
      modelId: string,
      input: BuiltinModelMatchRequest = {},
      signal?: AbortSignal,
    ): Promise<BuiltinModelMatchResponse> {
      return transport.post(
        `/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/builtin-match`,
        BuiltinModelMatchResponseSchema,
        input,
        signal,
      );
    },

    testProviderModel(
      providerId: string,
      modelId: string,
      input: SmokeTestModelRequest = {},
      signal?: AbortSignal,
    ): Promise<SmokeTestModelResponse> {
      return transport.post(
        `/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/test`,
        SmokeTestModelResponseSchema,
        input,
        signal,
      );
    },

    setProviderApiKey(
      providerId: string,
      input: SetApiKeyRequest,
      signal?: AbortSignal,
    ): Promise<OkResponse> {
      return transport.put(
        `/providers/${encodeURIComponent(providerId)}/auth/api-key`,
        OkResponseSchema,
        input,
        signal,
      );
    },

    logoutProvider(providerId: string, signal?: AbortSignal): Promise<OkResponse> {
      return transport.del(
        `/providers/${encodeURIComponent(providerId)}/auth`,
        OkResponseSchema,
        signal,
      );
    },

    startProviderLogin(
      providerId: string,
      input: StartLoginRequest,
      signal?: AbortSignal,
    ): Promise<StartLoginResponse> {
      return transport.post(
        `/providers/${encodeURIComponent(providerId)}/auth/login`,
        StartLoginResponseSchema,
        input,
        signal,
      );
    },

    streamLoginSession(
      providerId: string,
      sessionId: string,
      opts?: StreamLoginOptions,
    ): AsyncGenerator<LoginStreamEvent> {
      const path = `/providers/${encodeURIComponent(providerId)}/auth/login/${encodeURIComponent(sessionId)}/stream`;
      return transport.streamDecodedSse<LoginStreamEvent>(
        path,
        {
          signal: opts?.signal,
          isTerminal: (event) => event.type === "complete" || event.type === "error",
        },
        (sse) => {
          if (sse.event === "auth") {
            const event = transport.decodeSseEvent(
              sse,
              LoginAuthEventSchema,
              "login auth SSE payload",
            );
            return { type: "auth", event };
          }
          if (sse.event === "prompt") {
            const prompt = transport.decodeSseEvent(
              sse,
              LoginPromptEventSchema,
              "login prompt SSE payload",
            );
            return { type: "prompt", prompt };
          }
          if (sse.event === "complete") {
            const complete = transport.decodeSseEvent(
              sse,
              LoginCompleteEventSchema,
              "login complete SSE payload",
            );
            return { type: "complete", complete };
          }
          if (sse.event === "error") {
            const error = transport.decodeSseEvent(
              sse,
              LoginErrorEventSchema,
              "login error SSE payload",
            );
            return { type: "error", error };
          }
          return undefined;
        },
      );
    },

    submitLoginInput(
      providerId: string,
      sessionId: string,
      input: LoginInputRequest,
      signal?: AbortSignal,
    ): Promise<OkResponse> {
      return transport.post(
        `/providers/${encodeURIComponent(providerId)}/auth/login/${encodeURIComponent(sessionId)}/input`,
        OkResponseSchema,
        input,
        signal,
      );
    },

    cancelLoginSession(
      providerId: string,
      sessionId: string,
      signal?: AbortSignal,
    ): Promise<OkResponse> {
      return transport.post(
        `/providers/${encodeURIComponent(providerId)}/auth/login/${encodeURIComponent(sessionId)}/cancel`,
        OkResponseSchema,
        undefined,
        signal,
      );
    },

    listModels(opts?: ListModelsOptions): Promise<ListModelsResponse> {
      const query = buildQuery({ provider: opts?.provider, available: opts?.available });
      return transport.get(`/models${query}`, ListModelsResponseSchema, opts?.signal);
    },

    refreshModels(
      input: RefreshModelsRequest = {},
      signal?: AbortSignal,
    ): Promise<RefreshModelsResponse> {
      return transport.post("/models/refresh", RefreshModelsResponseSchema, input, signal);
    },

    reloadModels(signal?: AbortSignal): Promise<ReloadModelsResponse> {
      return transport.post("/models/reload", ReloadModelsResponseSchema, undefined, signal);
    },

    getModelProfiles(signal?: AbortSignal): Promise<ModelProfilesDocument> {
      return transport.get("/models/profiles", ModelProfilesDocumentSchema, signal);
    },

    putModelProfiles(
      input: ModelProfilesDocument,
      signal?: AbortSignal,
    ): Promise<ModelProfilesDocument> {
      return transport.put("/models/profiles", ModelProfilesDocumentSchema, input, signal);
    },
  };
}

export type ProvidersClient = ReturnType<typeof createProvidersClient>;
