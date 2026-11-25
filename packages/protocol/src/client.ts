import { applyImmutable, assertValidOp, type Op } from "@earendil-works/chord/delta";
import { compile } from "@earendil-works/pi-schema";
import {
  type AnswerQuestionRequest,
  type AnswerQuestionResponse,
  AnswerQuestionResponseSchema,
  type BoardViewPayload,
  BoardViewSchema,
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
  type DeleteProjectResponse,
  DeleteProjectResponseSchema,
  type EngineSettings,
  EngineSettingsSchema,
  type GetProjectResponse,
  GetProjectResponseSchema,
  type HealthResponse,
  HealthResponseSchema,
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
  type LoginAuthEvent,
  LoginAuthEventSchema,
  type LoginCompleteEvent,
  LoginCompleteEventSchema,
  type LoginErrorEvent,
  LoginErrorEventSchema,
  type LoginInputRequest,
  type LoginPromptEvent,
  LoginPromptEventSchema,
  type McpStateResponse,
  McpStateResponseSchema,
  type ModelProfilesDocument,
  ModelProfilesDocumentSchema,
  type OkResponse,
  OkResponseSchema,
  type Problem,
  ProblemSchema,
  type ProjectMemoryResponse,
  ProjectMemoryResponseSchema,
  type ProjectUsageResponse,
  ProjectUsageResponseSchema,
  type PutMcpConfigRequest,
  type PutProjectMemoryRequest,
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
  type ScanOrder,
  type SendMessageRequest,
  type SendMessageResponse,
  SendMessageResponseSchema,
  type SetApiKeyRequest,
  type StartLoginRequest,
  type StartLoginResponse,
  StartLoginResponseSchema,
  type StreamEndEvent,
  StreamEndEventSchema,
  type TaskReadMode,
  type UpdateProjectRequest,
  type UpsertMcpServerRequest,
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
const killWorkerTaskValidator = compile(KillWorkerTaskResponseSchema);
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
const modelProfilesValidator = compile(ModelProfilesDocumentSchema);
const mcpStateValidator = compile(McpStateResponseSchema);
const reconnectMcpValidator = compile(ReconnectMcpResponseSchema);
const engineSettingsValidator = compile(EngineSettingsSchema);
const configBundleValidator = compile(ConfigBundleSchema);
const deleteProjectValidator = compile(DeleteProjectResponseSchema);
const projectMemoryValidator = compile(ProjectMemoryResponseSchema);
const projectUsageValidator = compile(ProjectUsageResponseSchema);

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

export type EeveeClientOptions = {
  readonly baseUrl: string;
  readonly token?: string;
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
  readonly signal?: AbortSignal;
};

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
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: EeveeClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
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
    const query = params.toString();
    const path = `/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/tasks/${encodeURIComponent(taskId)}${query ? `?${query}` : ""}`;
    const data = await this.#requestJson("GET", path, undefined, opts?.signal);
    return parseWithSchema(readWorkerTaskValidator, data, `GET ${path} response`);
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
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw await this.#readApiError(response);
    }

    const text = await response.text();
    return parseJsonString(text, `${method} ${path}`);
  }

  async #requestSse(
    path: string,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "GET",
      headers: this.#headers("text/event-stream", false, extraHeaders),
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
