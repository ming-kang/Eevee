import { applyImmutable, assertValidOp, type Op } from "@earendil-works/chord/delta";
import { compile } from "@earendil-works/pi-schema";
import {
  type AnswerQuestionRequest,
  type AnswerQuestionResponse,
  AnswerQuestionResponseSchema,
  type BackgroundTaskRecordPayload,
  type BoardViewPayload,
  BoardViewSchema,
  type BuiltinModelMatchRequest,
  type BuiltinModelMatchResponse,
  BuiltinModelMatchResponseSchema,
  type ConfigBundle,
  ConfigBundleSchema,
  ConversationFailedEventSchema,
  ConversationPatchEventSchema,
  type ConversationRef,
  ConversationSnapshotEventSchema,
  type ConversationViewPayload,
  type CreateProjectRequest,
  type CreateProjectResponse,
  CreateProjectResponseSchema,
  type CreateWebSessionRequest,
  type CreateWebTicketResponse,
  CreateWebTicketResponseSchema,
  type DeleteProjectResponse,
  DeleteProjectResponseSchema,
  type EngineSettings,
  EngineSettingsSchema,
  type GetProjectResponse,
  GetProjectResponseSchema,
  type HealthResponse,
  HealthResponseSchema,
  type ImportProviderModelsRequest,
  type ImportProviderModelsResponse,
  ImportProviderModelsResponseSchema,
  type KillWorkerTaskResponse,
  KillWorkerTaskResponseSchema,
  type ListEntriesResponse,
  ListEntriesResponseSchema,
  type ListModelsResponse,
  ListModelsResponseSchema,
  type ListProjectsResponse,
  ListProjectsResponseSchema,
  type ListProvidersResponse,
  ListProvidersResponseSchema,
  type ListWorkerTasksResponse,
  ListWorkerTasksResponseSchema,
  type LoginAuthEvent,
  LoginAuthEventSchema,
  type LoginCompleteEvent,
  LoginCompleteEventSchema,
  type LoginErrorEvent,
  LoginErrorEventSchema,
  type LoginInputRequest,
  type LoginPromptEvent,
  LoginPromptEventSchema,
  type McpLogsResponse,
  McpLogsResponseSchema,
  type McpOAuthEvent,
  McpOAuthEventSchema,
  type McpOAuthInputRequest,
  type McpStateResponse,
  McpStateResponseSchema,
  type ModelProfilesDocument,
  ModelProfilesDocumentSchema,
  type OkResponse,
  OkResponseSchema,
  type OutputSlice,
  type ProbeProviderRequest,
  type ProbeProviderResponse,
  ProbeProviderResponseSchema,
  type Problem,
  ProblemSchema,
  type ProjectMcpStateResponse,
  ProjectMcpStateResponseSchema,
  type ProjectMemoryResponse,
  ProjectMemoryResponseSchema,
  type ProjectUsageResponse,
  ProjectUsageResponseSchema,
  type ProviderCatalogResponse,
  ProviderCatalogResponseSchema,
  type ProviderDetailResponse,
  ProviderDetailResponseSchema,
  type PutMcpConfigRequest,
  type PutProjectMemoryRequest,
  type PutSkillsPolicyRequest,
  parseWithSchema,
  type QuestionId,
  type ReadWorkerTaskResponse,
  ReadWorkerTaskResponseSchema,
  type ReconnectMcpRequest,
  type ReconnectMcpResponse,
  ReconnectMcpResponseSchema,
  type RefreshModelsRequest,
  type RefreshModelsResponse,
  RefreshModelsResponseSchema,
  type ReloadModelsResponse,
  ReloadModelsResponseSchema,
  type ScanOrder,
  type SendMessageRequest,
  type SendMessageResponse,
  SendMessageResponseSchema,
  type SetApiKeyRequest,
  type SkillsListResponse,
  SkillsListResponseSchema,
  type SmokeTestModelRequest,
  type SmokeTestModelResponse,
  SmokeTestModelResponseSchema,
  type StartLoginRequest,
  type StartLoginResponse,
  StartLoginResponseSchema,
  type StartMcpOAuthResponse,
  StartMcpOAuthResponseSchema,
  type StreamEndEvent,
  StreamEndEventSchema,
  type TaskListStatusFilter,
  type TaskReadMode,
  TaskStreamChunkEventSchema,
  TaskStreamSnapshotEventSchema,
  TaskStreamStatusEventSchema,
  type UpdateProjectRequest,
  type UpsertMcpServerRequest,
  type UpsertProviderModelRequest,
  type UpsertProviderRequest,
  type WebSessionResponse,
  WebSessionResponseSchema,
  type WorkerId,
} from "./schemas.ts";
import { parseSseStream } from "./sse.ts";

const problemValidator = compile(ProblemSchema);
const healthValidator = compile(HealthResponseSchema);
const createProjectValidator = compile(CreateProjectResponseSchema);
const listProjectsValidator = compile(ListProjectsResponseSchema);
const getProjectValidator = compile(GetProjectResponseSchema);
const sendMessageValidator = compile(SendMessageResponseSchema);
const listEntriesValidator = compile(ListEntriesResponseSchema);
const okValidator = compile(OkResponseSchema);
const answerQuestionValidator = compile(AnswerQuestionResponseSchema);
const readWorkerTaskValidator = compile(ReadWorkerTaskResponseSchema);
const listWorkerTasksValidator = compile(ListWorkerTasksResponseSchema);
const killWorkerTaskValidator = compile(KillWorkerTaskResponseSchema);
const taskStreamSnapshotValidator = compile(TaskStreamSnapshotEventSchema);
const taskStreamChunkValidator = compile(TaskStreamChunkEventSchema);
const taskStreamStatusValidator = compile(TaskStreamStatusEventSchema);
const boardViewValidator = compile(BoardViewSchema);
const conversationSnapshotValidator = compile(ConversationSnapshotEventSchema);
const conversationPatchValidator = compile(ConversationPatchEventSchema);
const conversationFailedValidator = compile(ConversationFailedEventSchema);
const streamEndValidator = compile(StreamEndEventSchema);
const listProvidersValidator = compile(ListProvidersResponseSchema);
const startLoginValidator = compile(StartLoginResponseSchema);
const loginAuthValidator = compile(LoginAuthEventSchema);
const loginPromptValidator = compile(LoginPromptEventSchema);
const loginCompleteValidator = compile(LoginCompleteEventSchema);
const loginErrorValidator = compile(LoginErrorEventSchema);
const listModelsValidator = compile(ListModelsResponseSchema);
const refreshModelsValidator = compile(RefreshModelsResponseSchema);
const providerCatalogValidator = compile(ProviderCatalogResponseSchema);
const providerDetailValidator = compile(ProviderDetailResponseSchema);
const probeProviderValidator = compile(ProbeProviderResponseSchema);
const importProviderModelsValidator = compile(ImportProviderModelsResponseSchema);
const builtinModelMatchValidator = compile(BuiltinModelMatchResponseSchema);
const smokeTestModelValidator = compile(SmokeTestModelResponseSchema);
const reloadModelsValidator = compile(ReloadModelsResponseSchema);
const modelProfilesValidator = compile(ModelProfilesDocumentSchema);
const skillsListValidator = compile(SkillsListResponseSchema);
const mcpStateValidator = compile(McpStateResponseSchema);
const mcpLogsValidator = compile(McpLogsResponseSchema);
const startMcpOAuthValidator = compile(StartMcpOAuthResponseSchema);
const mcpOAuthEventValidator = compile(McpOAuthEventSchema);
const projectMcpStateValidator = compile(ProjectMcpStateResponseSchema);
const reconnectMcpValidator = compile(ReconnectMcpResponseSchema);
const engineSettingsValidator = compile(EngineSettingsSchema);
const configBundleValidator = compile(ConfigBundleSchema);
const deleteProjectValidator = compile(DeleteProjectResponseSchema);
const projectMemoryValidator = compile(ProjectMemoryResponseSchema);
const projectUsageValidator = compile(ProjectUsageResponseSchema);
const webSessionValidator = compile(WebSessionResponseSchema);
const webTicketValidator = compile(CreateWebTicketResponseSchema);

export class EeveeApiError extends Error {
  readonly status: number;
  readonly problem: Problem;

  constructor(status: number, problem: Problem) {
    super(problem.detail ? `${problem.message}: ${problem.detail}` : problem.message);
    this.name = "EeveeApiError";
    this.status = status;
    this.problem = problem;
  }
}

export type FetchCredentials = "omit" | "same-origin" | "include";

export type EeveeClientOptions = {
  readonly baseUrl: string;
  readonly token?: string;
  readonly credentials?: FetchCredentials;
  readonly fetch?: typeof globalThis.fetch;
};

export type BoardStreamEvent =
  | { readonly type: "board"; readonly board: BoardViewPayload }
  | {
      readonly type: "end";
      readonly reason: StreamEndEvent["reason"];
      readonly message?: string;
    };

export type ConversationStreamEvent =
  | {
      readonly type: "snapshot";
      readonly view: ConversationViewPayload;
      readonly eventId?: string;
    }
  | {
      readonly type: "patch";
      readonly ops: readonly Op[];
      readonly retired: boolean;
      readonly view: ConversationViewPayload;
      readonly eventId?: string;
    }
  | { readonly type: "failed"; readonly message: string }
  | {
      readonly type: "end";
      readonly reason: StreamEndEvent["reason"];
      readonly message?: string;
    };

export type StreamBoardOptions = {
  readonly signal?: AbortSignal;
};

export type StreamConversationOptions = {
  readonly from?: number;
  readonly min?: number;
  readonly max?: number;
  readonly lastEventId?: string | number;
  readonly signal?: AbortSignal;
};

export type ListEntriesOptions = {
  readonly order?: ScanOrder;
  readonly limit?: number;
  readonly minEntryId?: number;
  readonly maxEntryId?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
};

export type ReadWorkerTaskOptions = {
  readonly mode?: TaskReadMode;
  readonly bytes?: number;
  readonly sinceBytes?: number;
  readonly endByte?: number;
  readonly filter?: string;
  readonly contextLines?: number;
  readonly signal?: AbortSignal;
};

export type ListWorkerTasksOptions = {
  readonly status?: TaskListStatusFilter;
  readonly limit?: number;
  readonly signal?: AbortSignal;
};

export type StreamWorkerTaskOptions = {
  readonly mode?: TaskReadMode;
  readonly bytes?: number;
  readonly sinceBytes?: number;
  readonly signal?: AbortSignal;
};

export type TaskStreamEvent =
  | {
      readonly type: "snapshot";
      readonly task: BackgroundTaskRecordPayload;
      readonly output: OutputSlice;
    }
  | {
      readonly type: "chunk";
      readonly text: string;
      readonly fromByte: number;
      readonly endByte: number;
      readonly totalBytes: number;
    }
  | { readonly type: "status"; readonly task: BackgroundTaskRecordPayload }
  | {
      readonly type: "end";
      readonly reason: StreamEndEvent["reason"];
      readonly message?: string;
    };

export type ListModelsOptions = {
  readonly provider?: string;
  readonly available?: boolean;
  readonly signal?: AbortSignal;
};

export type StreamLoginOptions = {
  readonly signal?: AbortSignal;
};

export type StreamMcpOAuthOptions = {
  readonly signal?: AbortSignal;
};

export type LoginStreamEvent =
  | { readonly type: "auth"; readonly event: LoginAuthEvent }
  | { readonly type: "prompt"; readonly prompt: LoginPromptEvent }
  | { readonly type: "complete"; readonly complete: LoginCompleteEvent }
  | { readonly type: "error"; readonly error: LoginErrorEvent };

function parseJsonString(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export class EeveeClient {
  readonly #baseUrl: string;
  readonly #token?: string;
  readonly #credentials?: FetchCredentials;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: EeveeClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async getWebSession(signal?: AbortSignal): Promise<WebSessionResponse> {
    const data = await this.#requestJson("GET", "/auth/session", undefined, signal);
    return parseWithSchema(webSessionValidator, data, "GET /auth/session response");
  }

  async createWebSession(
    input: CreateWebSessionRequest,
    signal?: AbortSignal,
  ): Promise<WebSessionResponse> {
    const data = await this.#requestJson("POST", "/auth/session", input, signal);
    return parseWithSchema(webSessionValidator, data, "POST /auth/session response");
  }

  async logoutWebSession(signal?: AbortSignal): Promise<OkResponse> {
    const data = await this.#requestJson("POST", "/auth/logout", {}, signal);
    return parseWithSchema(okValidator, data, "POST /auth/logout response");
  }

  async createWebTicket(signal?: AbortSignal): Promise<CreateWebTicketResponse> {
    const data = await this.#requestJson("POST", "/auth/web-ticket", {}, signal);
    return parseWithSchema(webTicketValidator, data, "POST /auth/web-ticket response");
  }

  async health(signal?: AbortSignal): Promise<HealthResponse> {
    const data = await this.#requestJson("GET", "/health", undefined, signal);
    return parseWithSchema(healthValidator, data, "GET /health response");
  }

  async shutdown(signal?: AbortSignal): Promise<OkResponse> {
    const data = await this.#requestJson("POST", "/shutdown", undefined, signal);
    return parseWithSchema(okValidator, data, "POST /shutdown response");
  }

  async createProject(
    input: CreateProjectRequest,
    signal?: AbortSignal,
  ): Promise<CreateProjectResponse> {
    const data = await this.#requestJson("POST", "/projects", input, signal);
    return parseWithSchema(createProjectValidator, data, "POST /projects response");
  }

  async listProjects(signal?: AbortSignal): Promise<ListProjectsResponse> {
    const data = await this.#requestJson("GET", "/projects", undefined, signal);
    return parseWithSchema(listProjectsValidator, data, "GET /projects response");
  }

  async getProject(id: string, signal?: AbortSignal): Promise<GetProjectResponse> {
    const data = await this.#requestJson(
      "GET",
      `/projects/${encodeURIComponent(id)}`,
      undefined,
      signal,
    );
    return parseWithSchema(getProjectValidator, data, "GET /projects/:id response");
  }

  async sendMessage(
    projectId: string,
    ref: ConversationRef,
    input: SendMessageRequest,
    signal?: AbortSignal,
  ): Promise<SendMessageResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(ref)}/messages`;
    const data = await this.#requestJson("POST", path, input, signal);
    return parseWithSchema(sendMessageValidator, data, `POST ${path} response`);
  }

  async listEntries(
    projectId: string,
    ref: ConversationRef,
    opts?: ListEntriesOptions,
  ): Promise<ListEntriesResponse> {
    const params = new URLSearchParams();
    if (opts?.order !== undefined) params.set("order", opts.order);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.minEntryId !== undefined) params.set("minEntryId", String(opts.minEntryId));
    if (opts?.maxEntryId !== undefined) params.set("maxEntryId", String(opts.maxEntryId));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    const query = params.toString();
    const path = `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(ref)}/entries${query ? `?${query}` : ""}`;
    const data = await this.#requestJson("GET", path, undefined, opts?.signal);
    return parseWithSchema(listEntriesValidator, data, `GET ${path} response`);
  }

  async interrupt(
    projectId: string,
    ref: ConversationRef,
    signal?: AbortSignal,
  ): Promise<OkResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(ref)}/interrupt`;
    const data = await this.#requestJson("POST", path, undefined, signal);
    return parseWithSchema(okValidator, data, `POST ${path} response`);
  }

  async retry(
    projectId: string,
    ref: ConversationRef,
    signal?: AbortSignal,
  ): Promise<SendMessageResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(ref)}/retry`;
    const data = await this.#requestJson("POST", path, undefined, signal);
    return parseWithSchema(sendMessageValidator, data, `POST ${path} response`);
  }

  async answerQuestion(
    projectId: string,
    questionId: QuestionId,
    input: AnswerQuestionRequest,
    signal?: AbortSignal,
  ): Promise<AnswerQuestionResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/questions/${encodeURIComponent(questionId)}/answer`;
    const data = await this.#requestJson("POST", path, input, signal);
    return parseWithSchema(answerQuestionValidator, data, `POST ${path} response`);
  }

  async listWorkerTasks(
    projectId: string,
    workerId: WorkerId,
    opts?: ListWorkerTasksOptions,
  ): Promise<ListWorkerTasksResponse> {
    const params = new URLSearchParams();
    if (opts?.status !== undefined) params.set("status", opts.status);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const query = params.toString();
    const path = `/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/tasks${query ? `?${query}` : ""}`;
    const data = await this.#requestJson("GET", path, undefined, opts?.signal);
    return parseWithSchema(listWorkerTasksValidator, data, `GET ${path} response`);
  }

  async readWorkerTask(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
    opts?: ReadWorkerTaskOptions,
  ): Promise<ReadWorkerTaskResponse> {
    const params = new URLSearchParams();
    if (opts?.mode !== undefined) params.set("mode", opts.mode);
    if (opts?.bytes !== undefined) params.set("bytes", String(opts.bytes));
    if (opts?.sinceBytes !== undefined) params.set("sinceBytes", String(opts.sinceBytes));
    if (opts?.endByte !== undefined) params.set("endByte", String(opts.endByte));
    if (opts?.filter !== undefined) params.set("filter", opts.filter);
    if (opts?.contextLines !== undefined) params.set("contextLines", String(opts.contextLines));
    const query = params.toString();
    const path = `/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/tasks/${encodeURIComponent(taskId)}${query ? `?${query}` : ""}`;
    const data = await this.#requestJson("GET", path, undefined, opts?.signal);
    return parseWithSchema(readWorkerTaskValidator, data, `GET ${path} response`);
  }

  async *streamWorkerTask(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
    opts?: StreamWorkerTaskOptions,
  ): AsyncGenerator<TaskStreamEvent> {
    const params = new URLSearchParams();
    if (opts?.mode !== undefined) params.set("mode", opts.mode);
    if (opts?.bytes !== undefined) params.set("bytes", String(opts.bytes));
    if (opts?.sinceBytes !== undefined) params.set("sinceBytes", String(opts.sinceBytes));
    const query = params.toString();
    const path = `/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/tasks/${encodeURIComponent(taskId)}/stream${query ? `?${query}` : ""}`;
    const response = await this.#requestSse(path, opts?.signal);
    for await (const sse of parseSseStream(response.body, opts?.signal)) {
      if (sse.event === "snapshot") {
        const raw = parseJsonString(sse.data, "task snapshot SSE payload");
        const parsed = parseWithSchema(
          taskStreamSnapshotValidator,
          raw,
          "task snapshot SSE payload",
        );
        yield { type: "snapshot", task: parsed.task, output: parsed.output };
      } else if (sse.event === "chunk") {
        const raw = parseJsonString(sse.data, "task chunk SSE payload");
        const parsed = parseWithSchema(taskStreamChunkValidator, raw, "task chunk SSE payload");
        yield {
          type: "chunk",
          text: parsed.text,
          fromByte: parsed.fromByte,
          endByte: parsed.endByte,
          totalBytes: parsed.totalBytes,
        };
      } else if (sse.event === "status") {
        const raw = parseJsonString(sse.data, "task status SSE payload");
        const parsed = parseWithSchema(taskStreamStatusValidator, raw, "task status SSE payload");
        yield { type: "status", task: parsed.task };
      } else if (sse.event === "end") {
        const raw = parseJsonString(sse.data, "task end SSE payload");
        const parsed = parseWithSchema(streamEndValidator, raw, "task end SSE payload");
        yield {
          type: "end",
          reason: parsed.reason,
          ...(parsed.message === undefined ? {} : { message: parsed.message }),
        };
        return;
      }
    }
  }

  async killWorkerTask(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<KillWorkerTaskResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/tasks/${encodeURIComponent(taskId)}/kill`;
    const data = await this.#requestJson("POST", path, undefined, signal);
    return parseWithSchema(killWorkerTaskValidator, data, `POST ${path} response`);
  }

  async getBoard(projectId: string, signal?: AbortSignal): Promise<BoardViewPayload> {
    const path = `/projects/${encodeURIComponent(projectId)}/board`;
    const data = await this.#requestJson("GET", path, undefined, signal);
    return parseWithSchema(boardViewValidator, data, `GET ${path} response`);
  }

  async *streamBoard(
    projectId: string,
    opts?: StreamBoardOptions,
  ): AsyncGenerator<BoardStreamEvent> {
    const path = `/projects/${encodeURIComponent(projectId)}/board/stream`;
    const response = await this.#requestSse(path, opts?.signal);
    for await (const sse of parseSseStream(response.body, opts?.signal)) {
      if (sse.event === "board") {
        const raw = parseJsonString(sse.data, "board SSE payload");
        const board = parseWithSchema(boardViewValidator, raw, "board SSE payload");
        yield { type: "board", board };
      } else if (sse.event === "end") {
        const raw = parseJsonString(sse.data, "board end SSE payload");
        const end = parseWithSchema(streamEndValidator, raw, "board end SSE payload");
        yield {
          type: "end",
          reason: end.reason,
          ...(end.message === undefined ? {} : { message: end.message }),
        };
        return;
      }
    }
  }

  async *streamConversation(
    projectId: string,
    ref: ConversationRef,
    opts?: StreamConversationOptions,
  ): AsyncGenerator<ConversationStreamEvent> {
    const params = new URLSearchParams();
    if (opts?.from !== undefined) params.set("from", String(opts.from));
    if (opts?.min !== undefined) params.set("min", String(opts.min));
    if (opts?.max !== undefined) params.set("max", String(opts.max));
    const query = params.toString();
    const path = `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(ref)}/stream${query ? `?${query}` : ""}`;

    const extraHeaders =
      opts?.lastEventId === undefined ? undefined : { "Last-Event-ID": String(opts.lastEventId) };
    const response = await this.#requestSse(path, opts?.signal, extraHeaders);

    let currentView: ConversationViewPayload | undefined;
    for await (const sse of parseSseStream(response.body, opts?.signal)) {
      if (sse.event === "snapshot") {
        const raw = parseJsonString(sse.data, "conversation snapshot SSE payload");
        const parsed = parseWithSchema(
          conversationSnapshotValidator,
          raw,
          "conversation snapshot SSE payload",
        );
        currentView = parsed.view;
        yield {
          type: "snapshot",
          view: currentView,
          ...(sse.id === undefined ? {} : { eventId: sse.id }),
        };
      } else if (sse.event === "patch") {
        if (currentView === undefined) {
          throw new Error("Received conversation patch before initial snapshot");
        }
        const raw = parseJsonString(sse.data, "conversation patch SSE payload");
        const parsed = parseWithSchema(
          conversationPatchValidator,
          raw,
          "conversation patch SSE payload",
        );
        for (const op of parsed.ops) assertValidOp(op);
        const ops = parsed.ops as Op[];
        currentView = applyImmutable(currentView, ops);
        yield {
          type: "patch",
          ops,
          retired: parsed.retired,
          view: currentView,
          ...(sse.id === undefined ? {} : { eventId: sse.id }),
        };
      } else if (sse.event === "failed") {
        const raw = parseJsonString(sse.data, "conversation failed SSE payload");
        const parsed = parseWithSchema(
          conversationFailedValidator,
          raw,
          "conversation failed SSE payload",
        );
        yield { type: "failed", message: parsed.message };
      } else if (sse.event === "end") {
        const raw = parseJsonString(sse.data, "conversation end SSE payload");
        const parsed = parseWithSchema(streamEndValidator, raw, "conversation end SSE payload");
        yield {
          type: "end",
          reason: parsed.reason,
          ...(parsed.message === undefined ? {} : { message: parsed.message }),
        };
        return;
      }
    }
  }

  async listProviders(signal?: AbortSignal): Promise<ListProvidersResponse> {
    const data = await this.#requestJson("GET", "/providers", undefined, signal);
    return parseWithSchema(listProvidersValidator, data, "GET /providers response");
  }

  async getProviderCatalog(signal?: AbortSignal): Promise<ProviderCatalogResponse> {
    const data = await this.#requestJson("GET", "/providers/catalog", undefined, signal);
    return parseWithSchema(providerCatalogValidator, data, "GET /providers/catalog response");
  }

  async getProviderDetail(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<ProviderDetailResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}`;
    const data = await this.#requestJson("GET", path, undefined, signal);
    return parseWithSchema(providerDetailValidator, data, `GET ${path} response`);
  }

  async createProvider(
    input: UpsertProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderDetailResponse> {
    const data = await this.#requestJson("POST", "/providers", input, signal);
    return parseWithSchema(providerDetailValidator, data, "POST /providers response");
  }

  async updateProvider(
    providerId: string,
    input: UpsertProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderDetailResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}`;
    const data = await this.#requestJson("PATCH", path, input, signal);
    return parseWithSchema(providerDetailValidator, data, `PATCH ${path} response`);
  }

  async deleteProvider(providerId: string, signal?: AbortSignal): Promise<OkResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}`;
    const data = await this.#requestJson("DELETE", path, undefined, signal);
    return parseWithSchema(okValidator, data, `DELETE ${path} response`);
  }

  async createProviderModel(
    providerId: string,
    input: UpsertProviderModelRequest,
    signal?: AbortSignal,
  ): Promise<ProviderDetailResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}/models`;
    const data = await this.#requestJson("POST", path, input, signal);
    return parseWithSchema(providerDetailValidator, data, `POST ${path} response`);
  }

  async updateProviderModel(
    providerId: string,
    modelId: string,
    input: UpsertProviderModelRequest,
    signal?: AbortSignal,
  ): Promise<ProviderDetailResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`;
    const data = await this.#requestJson("PATCH", path, input, signal);
    return parseWithSchema(providerDetailValidator, data, `PATCH ${path} response`);
  }

  async deleteProviderModel(
    providerId: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<ProviderDetailResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`;
    const data = await this.#requestJson("DELETE", path, undefined, signal);
    return parseWithSchema(providerDetailValidator, data, `DELETE ${path} response`);
  }

  async probeDraftProvider(
    input: ProbeProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProbeProviderResponse> {
    const data = await this.#requestJson("POST", "/providers/probe", input, signal);
    return parseWithSchema(probeProviderValidator, data, "POST /providers/probe response");
  }

  async probeProvider(
    providerId: string,
    input: ProbeProviderRequest = {},
    signal?: AbortSignal,
  ): Promise<ProbeProviderResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}/probe`;
    const data = await this.#requestJson("POST", path, input, signal);
    return parseWithSchema(probeProviderValidator, data, `POST ${path} response`);
  }

  async importProviderModels(
    providerId: string,
    input: ImportProviderModelsRequest,
    signal?: AbortSignal,
  ): Promise<ImportProviderModelsResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}/models/import`;
    const data = await this.#requestJson("POST", path, input, signal);
    return parseWithSchema(importProviderModelsValidator, data, `POST ${path} response`);
  }

  async matchBuiltinModel(
    providerId: string,
    modelId: string,
    input: BuiltinModelMatchRequest = {},
    signal?: AbortSignal,
  ): Promise<BuiltinModelMatchResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/builtin-match`;
    const data = await this.#requestJson("POST", path, input, signal);
    return parseWithSchema(builtinModelMatchValidator, data, `POST ${path} response`);
  }

  async testProviderModel(
    providerId: string,
    modelId: string,
    input: SmokeTestModelRequest = {},
    signal?: AbortSignal,
  ): Promise<SmokeTestModelResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/test`;
    const data = await this.#requestJson("POST", path, input, signal);
    return parseWithSchema(smokeTestModelValidator, data, `POST ${path} response`);
  }

  async setProviderApiKey(
    providerId: string,
    input: SetApiKeyRequest,
    signal?: AbortSignal,
  ): Promise<OkResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}/auth/api-key`;
    const data = await this.#requestJson("PUT", path, input, signal);
    return parseWithSchema(okValidator, data, `PUT ${path} response`);
  }

  async logoutProvider(providerId: string, signal?: AbortSignal): Promise<OkResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}/auth`;
    const data = await this.#requestJson("DELETE", path, undefined, signal);
    return parseWithSchema(okValidator, data, `DELETE ${path} response`);
  }

  async startProviderLogin(
    providerId: string,
    input: StartLoginRequest,
    signal?: AbortSignal,
  ): Promise<StartLoginResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}/auth/login`;
    const data = await this.#requestJson("POST", path, input, signal);
    return parseWithSchema(startLoginValidator, data, `POST ${path} response`);
  }

  async *streamLoginSession(
    providerId: string,
    sessionId: string,
    opts?: StreamLoginOptions,
  ): AsyncGenerator<LoginStreamEvent> {
    const path = `/providers/${encodeURIComponent(providerId)}/auth/login/${encodeURIComponent(sessionId)}/stream`;
    const response = await this.#requestSse(path, opts?.signal);
    for await (const sse of parseSseStream(response.body, opts?.signal)) {
      if (sse.event === "auth") {
        const raw = parseJsonString(sse.data, "login auth SSE payload");
        const event = parseWithSchema(loginAuthValidator, raw, "login auth SSE payload");
        yield { type: "auth", event };
      } else if (sse.event === "prompt") {
        const raw = parseJsonString(sse.data, "login prompt SSE payload");
        const prompt = parseWithSchema(loginPromptValidator, raw, "login prompt SSE payload");
        yield { type: "prompt", prompt };
      } else if (sse.event === "complete") {
        const raw = parseJsonString(sse.data, "login complete SSE payload");
        const complete = parseWithSchema(loginCompleteValidator, raw, "login complete SSE payload");
        yield { type: "complete", complete };
        return;
      } else if (sse.event === "error") {
        const raw = parseJsonString(sse.data, "login error SSE payload");
        const error = parseWithSchema(loginErrorValidator, raw, "login error SSE payload");
        yield { type: "error", error };
        return;
      }
    }
  }

  async submitLoginInput(
    providerId: string,
    sessionId: string,
    input: LoginInputRequest,
    signal?: AbortSignal,
  ): Promise<OkResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}/auth/login/${encodeURIComponent(sessionId)}/input`;
    const data = await this.#requestJson("POST", path, input, signal);
    return parseWithSchema(okValidator, data, `POST ${path} response`);
  }

  async cancelLoginSession(
    providerId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<OkResponse> {
    const path = `/providers/${encodeURIComponent(providerId)}/auth/login/${encodeURIComponent(sessionId)}/cancel`;
    const data = await this.#requestJson("POST", path, undefined, signal);
    return parseWithSchema(okValidator, data, `POST ${path} response`);
  }

  async listModels(opts?: ListModelsOptions): Promise<ListModelsResponse> {
    const params = new URLSearchParams();
    if (opts?.provider !== undefined) params.set("provider", opts.provider);
    if (opts?.available !== undefined) params.set("available", String(opts.available));
    const query = params.toString();
    const path = `/models${query ? `?${query}` : ""}`;
    const data = await this.#requestJson("GET", path, undefined, opts?.signal);
    return parseWithSchema(listModelsValidator, data, `GET ${path} response`);
  }

  async refreshModels(
    input: RefreshModelsRequest = {},
    signal?: AbortSignal,
  ): Promise<RefreshModelsResponse> {
    const data = await this.#requestJson("POST", "/models/refresh", input, signal);
    return parseWithSchema(refreshModelsValidator, data, "POST /models/refresh response");
  }

  async reloadModels(signal?: AbortSignal): Promise<ReloadModelsResponse> {
    const data = await this.#requestJson("POST", "/models/reload", undefined, signal);
    return parseWithSchema(reloadModelsValidator, data, "POST /models/reload response");
  }

  async getModelProfiles(signal?: AbortSignal): Promise<ModelProfilesDocument> {
    const data = await this.#requestJson("GET", "/models/profiles", undefined, signal);
    return parseWithSchema(modelProfilesValidator, data, "GET /models/profiles response");
  }

  async putModelProfiles(
    input: ModelProfilesDocument,
    signal?: AbortSignal,
  ): Promise<ModelProfilesDocument> {
    const data = await this.#requestJson("PUT", "/models/profiles", input, signal);
    return parseWithSchema(modelProfilesValidator, data, "PUT /models/profiles response");
  }

  async listSkills(signal?: AbortSignal): Promise<SkillsListResponse> {
    const data = await this.#requestJson("GET", "/skills", undefined, signal);
    return parseWithSchema(skillsListValidator, data, "GET /skills response");
  }

  async putSkillsPolicy(
    input: PutSkillsPolicyRequest,
    signal?: AbortSignal,
  ): Promise<SkillsListResponse> {
    const data = await this.#requestJson("PUT", "/skills/policy", input, signal);
    return parseWithSchema(skillsListValidator, data, "PUT /skills/policy response");
  }

  async listProjectSkills(projectId: string, signal?: AbortSignal): Promise<SkillsListResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/skills`;
    const data = await this.#requestJson("GET", path, undefined, signal);
    return parseWithSchema(skillsListValidator, data, `GET ${path} response`);
  }

  async putProjectSkillsPolicy(
    projectId: string,
    input: PutSkillsPolicyRequest,
    signal?: AbortSignal,
  ): Promise<SkillsListResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/skills/policy`;
    const data = await this.#requestJson("PUT", path, input, signal);
    return parseWithSchema(skillsListValidator, data, `PUT ${path} response`);
  }

  async getMcpState(signal?: AbortSignal): Promise<McpStateResponse> {
    const data = await this.#requestJson("GET", "/mcp", undefined, signal);
    return parseWithSchema(mcpStateValidator, data, "GET /mcp response");
  }

  async putMcpConfig(input: PutMcpConfigRequest, signal?: AbortSignal): Promise<McpStateResponse> {
    const data = await this.#requestJson("PUT", "/mcp", input, signal);
    return parseWithSchema(mcpStateValidator, data, "PUT /mcp response");
  }

  async upsertMcpServer(
    name: string,
    input: UpsertMcpServerRequest,
    signal?: AbortSignal,
  ): Promise<McpStateResponse> {
    const path = `/mcp/servers/${encodeURIComponent(name)}`;
    const data = await this.#requestJson("PUT", path, input, signal);
    return parseWithSchema(mcpStateValidator, data, `PUT ${path} response`);
  }

  async deleteMcpServer(name: string, signal?: AbortSignal): Promise<McpStateResponse> {
    const path = `/mcp/servers/${encodeURIComponent(name)}`;
    const data = await this.#requestJson("DELETE", path, undefined, signal);
    return parseWithSchema(mcpStateValidator, data, `DELETE ${path} response`);
  }

  async reconnectMcp(
    input: ReconnectMcpRequest = {},
    signal?: AbortSignal,
  ): Promise<ReconnectMcpResponse> {
    const data = await this.#requestJson("POST", "/mcp/reconnect", input, signal);
    return parseWithSchema(reconnectMcpValidator, data, "POST /mcp/reconnect response");
  }

  async getMcpLogs(serverName: string, signal?: AbortSignal): Promise<McpLogsResponse> {
    const path = `/mcp/servers/${encodeURIComponent(serverName)}/logs`;
    const data = await this.#requestJson("GET", path, undefined, signal);
    return parseWithSchema(mcpLogsValidator, data, `GET ${path} response`);
  }

  async startMcpOAuth(serverName: string, signal?: AbortSignal): Promise<StartMcpOAuthResponse> {
    const path = `/mcp/servers/${encodeURIComponent(serverName)}/oauth/login`;
    const data = await this.#requestJson("POST", path, undefined, signal);
    return parseWithSchema(startMcpOAuthValidator, data, `POST ${path} response`);
  }

  streamMcpOAuth(
    serverName: string,
    sessionId: string,
    opts?: StreamMcpOAuthOptions,
  ): AsyncGenerator<McpOAuthEvent> {
    const path = `/mcp/servers/${encodeURIComponent(serverName)}/oauth/login/${encodeURIComponent(sessionId)}/stream`;
    return this.#streamMcpOAuthPath(path, opts);
  }

  async submitMcpOAuthInput(
    serverName: string,
    sessionId: string,
    input: McpOAuthInputRequest,
    signal?: AbortSignal,
  ): Promise<OkResponse> {
    const path = `/mcp/servers/${encodeURIComponent(serverName)}/oauth/login/${encodeURIComponent(sessionId)}/input`;
    const data = await this.#requestJson("POST", path, input, signal);
    return parseWithSchema(okValidator, data, `POST ${path} response`);
  }

  async cancelMcpOAuth(
    serverName: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<OkResponse> {
    const path = `/mcp/servers/${encodeURIComponent(serverName)}/oauth/login/${encodeURIComponent(sessionId)}/cancel`;
    const data = await this.#requestJson("POST", path, undefined, signal);
    return parseWithSchema(okValidator, data, `POST ${path} response`);
  }

  async logoutMcpOAuth(serverName: string, signal?: AbortSignal): Promise<OkResponse> {
    const path = `/mcp/servers/${encodeURIComponent(serverName)}/oauth`;
    const data = await this.#requestJson("DELETE", path, undefined, signal);
    return parseWithSchema(okValidator, data, `DELETE ${path} response`);
  }

  async getProjectMcpState(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<ProjectMcpStateResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/mcp`;
    const data = await this.#requestJson("GET", path, undefined, signal);
    return parseWithSchema(projectMcpStateValidator, data, `GET ${path} response`);
  }

  async putProjectMcpConfig(
    projectId: string,
    input: PutMcpConfigRequest,
    signal?: AbortSignal,
  ): Promise<ProjectMcpStateResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/mcp`;
    const data = await this.#requestJson("PUT", path, input, signal);
    return parseWithSchema(projectMcpStateValidator, data, `PUT ${path} response`);
  }

  async upsertProjectMcpServer(
    projectId: string,
    serverName: string,
    input: UpsertMcpServerRequest,
    signal?: AbortSignal,
  ): Promise<ProjectMcpStateResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/mcp/servers/${encodeURIComponent(serverName)}`;
    const data = await this.#requestJson("PUT", path, input, signal);
    return parseWithSchema(projectMcpStateValidator, data, `PUT ${path} response`);
  }

  async deleteProjectMcpServer(
    projectId: string,
    serverName: string,
    signal?: AbortSignal,
  ): Promise<ProjectMcpStateResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/mcp/servers/${encodeURIComponent(serverName)}`;
    const data = await this.#requestJson("DELETE", path, undefined, signal);
    return parseWithSchema(projectMcpStateValidator, data, `DELETE ${path} response`);
  }

  async reconnectProjectMcp(
    projectId: string,
    input: ReconnectMcpRequest = {},
    signal?: AbortSignal,
  ): Promise<ReconnectMcpResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/mcp/reconnect`;
    const data = await this.#requestJson("POST", path, input, signal);
    return parseWithSchema(reconnectMcpValidator, data, `POST ${path} response`);
  }

  async getProjectMcpLogs(
    projectId: string,
    serverName: string,
    signal?: AbortSignal,
  ): Promise<McpLogsResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/mcp/servers/${encodeURIComponent(serverName)}/logs`;
    const data = await this.#requestJson("GET", path, undefined, signal);
    return parseWithSchema(mcpLogsValidator, data, `GET ${path} response`);
  }

  async startProjectMcpOAuth(
    projectId: string,
    serverName: string,
    signal?: AbortSignal,
  ): Promise<StartMcpOAuthResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/mcp/servers/${encodeURIComponent(serverName)}/oauth/login`;
    const data = await this.#requestJson("POST", path, undefined, signal);
    return parseWithSchema(startMcpOAuthValidator, data, `POST ${path} response`);
  }

  streamProjectMcpOAuth(
    projectId: string,
    serverName: string,
    sessionId: string,
    opts?: StreamMcpOAuthOptions,
  ): AsyncGenerator<McpOAuthEvent> {
    const path = `/projects/${encodeURIComponent(projectId)}/mcp/servers/${encodeURIComponent(serverName)}/oauth/login/${encodeURIComponent(sessionId)}/stream`;
    return this.#streamMcpOAuthPath(path, opts);
  }

  async submitProjectMcpOAuthInput(
    projectId: string,
    serverName: string,
    sessionId: string,
    input: McpOAuthInputRequest,
    signal?: AbortSignal,
  ): Promise<OkResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/mcp/servers/${encodeURIComponent(serverName)}/oauth/login/${encodeURIComponent(sessionId)}/input`;
    const data = await this.#requestJson("POST", path, input, signal);
    return parseWithSchema(okValidator, data, `POST ${path} response`);
  }

  async cancelProjectMcpOAuth(
    projectId: string,
    serverName: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<OkResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/mcp/servers/${encodeURIComponent(serverName)}/oauth/login/${encodeURIComponent(sessionId)}/cancel`;
    const data = await this.#requestJson("POST", path, undefined, signal);
    return parseWithSchema(okValidator, data, `POST ${path} response`);
  }

  async logoutProjectMcpOAuth(
    projectId: string,
    serverName: string,
    signal?: AbortSignal,
  ): Promise<OkResponse> {
    const path = `/projects/${encodeURIComponent(projectId)}/mcp/servers/${encodeURIComponent(serverName)}/oauth`;
    const data = await this.#requestJson("DELETE", path, undefined, signal);
    return parseWithSchema(okValidator, data, `DELETE ${path} response`);
  }

  async getSettings(signal?: AbortSignal): Promise<EngineSettings> {
    const data = await this.#requestJson("GET", "/settings", undefined, signal);
    return parseWithSchema(engineSettingsValidator, data, "GET /settings response");
  }

  async patchSettings(input: EngineSettings, signal?: AbortSignal): Promise<EngineSettings> {
    const data = await this.#requestJson("PATCH", "/settings", input, signal);
    return parseWithSchema(engineSettingsValidator, data, "PATCH /settings response");
  }

  async putSettings(input: EngineSettings, signal?: AbortSignal): Promise<EngineSettings> {
    const data = await this.#requestJson("PUT", "/settings", input, signal);
    return parseWithSchema(engineSettingsValidator, data, "PUT /settings response");
  }

  async exportConfig(signal?: AbortSignal): Promise<ConfigBundle> {
    const data = await this.#requestJson("GET", "/config/export", undefined, signal);
    return parseWithSchema(configBundleValidator, data, "GET /config/export response");
  }

  async importConfig(input: ConfigBundle, signal?: AbortSignal): Promise<ConfigBundle> {
    const data = await this.#requestJson("POST", "/config/import", input, signal);
    return parseWithSchema(configBundleValidator, data, "POST /config/import response");
  }

  async updateProject(
    id: string,
    input: UpdateProjectRequest,
    signal?: AbortSignal,
  ): Promise<GetProjectResponse> {
    const path = `/projects/${encodeURIComponent(id)}`;
    const data = await this.#requestJson("PATCH", path, input, signal);
    return parseWithSchema(getProjectValidator, data, `PATCH ${path} response`);
  }

  async deleteProject(id: string, signal?: AbortSignal): Promise<DeleteProjectResponse> {
    const path = `/projects/${encodeURIComponent(id)}`;
    const data = await this.#requestJson("DELETE", path, undefined, signal);
    return parseWithSchema(deleteProjectValidator, data, `DELETE ${path} response`);
  }

  async getProjectMemory(id: string, signal?: AbortSignal): Promise<ProjectMemoryResponse> {
    const path = `/projects/${encodeURIComponent(id)}/memory`;
    const data = await this.#requestJson("GET", path, undefined, signal);
    return parseWithSchema(projectMemoryValidator, data, `GET ${path} response`);
  }

  async putProjectMemory(
    id: string,
    input: PutProjectMemoryRequest,
    signal?: AbortSignal,
  ): Promise<ProjectMemoryResponse> {
    const path = `/projects/${encodeURIComponent(id)}/memory`;
    const data = await this.#requestJson("PUT", path, input, signal);
    return parseWithSchema(projectMemoryValidator, data, `PUT ${path} response`);
  }

  async getProjectUsage(id: string, signal?: AbortSignal): Promise<ProjectUsageResponse> {
    const path = `/projects/${encodeURIComponent(id)}/usage`;
    const data = await this.#requestJson("GET", path, undefined, signal);
    return parseWithSchema(projectUsageValidator, data, `GET ${path} response`);
  }

  #headers(
    accept: string,
    hasBody: boolean,
    extra?: Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = { Accept: accept, ...extra };
    if (hasBody) headers["Content-Type"] = "application/json";
    if (this.#token !== undefined) headers.Authorization = `Bearer ${this.#token}`;
    return headers;
  }

  async #requestJson(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const hasBody = body !== undefined;
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: this.#headers("application/json", hasBody),
      ...(this.#credentials === undefined ? {} : { credentials: this.#credentials }),
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw await this.#readApiError(response);
    }

    const text = await response.text();
    return parseJsonString(text, `${method} ${path}`);
  }

  async *#streamMcpOAuthPath(
    path: string,
    opts?: StreamMcpOAuthOptions,
  ): AsyncGenerator<McpOAuthEvent> {
    const response = await this.#requestSse(path, opts?.signal);
    for await (const sse of parseSseStream(response.body, opts?.signal)) {
      if (
        sse.event === "auth_url" ||
        sse.event === "progress" ||
        sse.event === "complete" ||
        sse.event === "error" ||
        sse.event === "message"
      ) {
        const raw = parseJsonString(sse.data, "MCP OAuth SSE payload");
        const event = parseWithSchema(mcpOAuthEventValidator, raw, "MCP OAuth SSE payload");
        yield event;
        if (event.type === "complete" || event.type === "error") return;
      }
    }
  }

  async #requestSse(
    path: string,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "GET",
      headers: this.#headers("text/event-stream", false, extraHeaders),
      ...(this.#credentials === undefined ? {} : { credentials: this.#credentials }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw await this.#readApiError(response);
    }
    if (response.body === null) {
      throw new Error(`Expected SSE response body from GET ${path}`);
    }
    return response;
  }

  async #readApiError(response: Response): Promise<EeveeApiError> {
    const text = await response.text().catch(() => "");
    if (text.length > 0) {
      try {
        const parsed: unknown = JSON.parse(text);
        const checked = problemValidator.validate(parsed);
        if (checked.ok) return new EeveeApiError(response.status, checked.value);
      } catch {
        // Fall through to generic Problem wrapper for non-JSON errors.
      }
    }
    const fallbackMessage = response.statusText || `HTTP ${response.status}`;
    return new EeveeApiError(response.status, {
      code: "http_error",
      message: fallbackMessage,
      ...(text.length > 0 ? { detail: text } : {}),
    });
  }
}
