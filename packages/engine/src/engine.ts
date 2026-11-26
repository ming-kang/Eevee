import { mkdir, rm } from "node:fs/promises";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import type {
  ConversationWatch,
  ConversationWindow,
  EntryId,
  EntryQuery,
  Report,
  Submission,
} from "@earendil-works/pi-durable";
import {
  createMcpHub,
  getConversationTask,
  isTaskTerminalStatus,
  type McpHub,
  type McpHubOptions,
  parseMcpConfig,
  resolveTaskId,
  sliceRetainedOutput,
  TASK_READ_MAX_BYTES,
  validateOutputReadOptions,
} from "@eevee/agent";
import { ModelRuntime } from "@eevee/agent/models";
import type {
  BoardView,
  ListWorkerTasksOptions as CoreListWorkerTasksOptions,
  QuestionId as CoreQuestionId,
  WorkerId as CoreWorkerId,
  ModelSlots,
  OutputReadOptions,
  OutputSlice,
  ProjectHandle,
  ProjectTarget,
} from "@eevee/core";
import { ProjectError } from "@eevee/core";
import {
  type AnswerQuestionRequest,
  type AnswerQuestionResponse,
  type BackgroundTaskRecordPayload,
  type BackgroundTaskStatus,
  type ConfigBundle,
  type ConversationRef,
  type CreateProjectRequest,
  type DeleteProjectResponse,
  type EngineSettings,
  EngineSettingsSchema,
  type EntryRecordPayload,
  type GetProjectResponse,
  type KillWorkerTaskResponse,
  type ListEntriesResponse,
  type ListModelsResponse,
  type ListProvidersResponse,
  type ListWorkerTasksResponse,
  type LoginInputRequest,
  type McpStateResponse,
  type ModelProfilesDocument,
  ModelProfilesDocumentSchema,
  type OkResponse,
  type ProjectMemoryResponse,
  type ProjectSummary,
  type ProjectUsageResponse,
  type PutMcpConfigRequest,
  type PutProjectMemoryRequest,
  parseWithSchema,
  type QuestionId,
  type ReadWorkerTaskResponse,
  type ReconnectMcpRequest,
  type ReconnectMcpResponse,
  type RefreshModelsRequest,
  type RefreshModelsResponse,
  type ScanOrder,
  type SendMessageRequest,
  type SendMessageResponse,
  type SetApiKeyRequest,
  type StartLoginRequest,
  type StartLoginResponse,
  type TaskStreamChunkEvent,
  type UpdateProjectRequest,
  type UpsertMcpServerRequest,
  type WorkerId,
} from "@eevee/protocol";
import { type DataDirLayout, dataDirLayout, projectPaths, resolveDataDir } from "./data-dir.ts";
import {
  type EngineKnobs,
  engineKnobs,
  exportEngineConfig,
  importEngineConfig,
  KV_MCP_SERVERS,
  KV_MODEL_PROFILES,
  KV_SETTINGS,
  mergeEngineSettings,
  readEngineSettings,
  readModelProfiles,
} from "./engine-config.ts";
import { EngineError } from "./engine-error.ts";
import {
  deleteMcpServer,
  getMcpState,
  type McpDeps,
  putMcpConfig,
  reconnectMcp,
  upsertMcpServer,
} from "./engine-mcp.ts";
import {
  decodeCursor,
  encodeCursor,
  listModels,
  listProviders,
  logoutProvider,
  type ProviderDeps,
  refreshModels,
  setProviderApiKey,
  toEngineError,
} from "./engine-providers.ts";
import { LoginSessionManager, type LoginSseFrame } from "./login-sessions.ts";
import { type OpenProjectStorage, ProjectPool } from "./project-pool.ts";
import { EngineStore } from "./store.ts";

export { formatModelProfiles } from "./engine-config.ts";
export { EngineError } from "./engine-error.ts";
export type { LoginSseFrame } from "./login-sessions.ts";
export type { OpenProjectStorage } from "./project-pool.ts";

export type ListEntriesParams = {
  readonly order?: ScanOrder;
  readonly limit?: number;
  readonly minEntryId?: number;
  readonly maxEntryId?: number;
  readonly cursor?: string;
};

export type WorkerTaskStreamCallbacks = {
  readonly onChunk: (chunk: TaskStreamChunkEvent) => void;
  readonly onStatus: (task: BackgroundTaskRecordPayload) => void;
  readonly onEnd: (reason: "completed" | "terminal") => void;
};

export type WorkerTaskStream = {
  readonly snapshot: ReadWorkerTaskResponse;
  readonly terminal: boolean;
  start(callbacks: WorkerTaskStreamCallbacks): void;
  close(): void;
};

function taskStatusPhase(status: BackgroundTaskStatus): number {
  switch (status) {
    case "queued":
      return 0;
    case "running":
      return 1;
    case "stopping":
      return 2;
    default:
      return 3;
  }
}

export type EngineOptions = {
  readonly dataDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly models?: Models | (() => Models);
  readonly credentials?: CredentialStore;
  readonly openProjectStorage?: OpenProjectStorage;
  readonly createMcpTransport?: McpHubOptions["createTransport"];
  readonly defaultModelSlots?: ModelSlots;
  readonly maxActiveWorkers?: number;
  readonly backgroundAfterMs?: number;
  readonly routerContextTokens?: number;
  readonly idleHibernateMs?: number;
  readonly onReport?: (projectId: string, report: Report) => void;
  readonly onPumpError?: (projectId: string, error: unknown) => void;
};

function conversationTarget(ref: ConversationRef): ProjectTarget {
  return ref === "router" ? "router" : (ref as CoreWorkerId);
}

async function submissionResponse(submission: Submission): Promise<SendMessageResponse> {
  const { status } = await submission.status(BACKGROUND_CONTEXT);
  return { submissionId: submission.id, status };
}

export class Engine {
  readonly layout: DataDirLayout;
  readonly store: EngineStore;
  readonly modelRuntime: ModelRuntime;
  readonly mcpHub: McpHub;

  readonly #options: EngineOptions;
  readonly #knobs: EngineKnobs;
  readonly #pool: ProjectPool;
  readonly #loginSessions = new LoginSessionManager();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  private constructor(
    layout: DataDirLayout,
    store: EngineStore,
    modelRuntime: ModelRuntime,
    mcpHub: McpHub,
    options: EngineOptions,
  ) {
    this.layout = layout;
    this.store = store;
    this.modelRuntime = modelRuntime;
    this.mcpHub = mcpHub;
    this.#options = options;
    this.#knobs = engineKnobs(store, {
      defaultModelSlots: options.defaultModelSlots,
      maxActiveWorkers: options.maxActiveWorkers,
      backgroundAfterMs: options.backgroundAfterMs,
      routerContextTokens: options.routerContextTokens,
      idleHibernateMs: options.idleHibernateMs,
    });
    this.#pool = new ProjectPool({
      layout,
      store,
      mcpHub,
      models: () => this.models(),
      knobs: this.#knobs,
      openProjectStorage: options.openProjectStorage,
      onReport: options.onReport,
      onPumpError: options.onPumpError,
    });
  }

  static async open(options: EngineOptions = {}): Promise<Engine> {
    const root = options.dataDir ?? resolveDataDir(options.env);
    const layout = dataDirLayout(root);
    await mkdir(layout.root, { recursive: true });
    await mkdir(layout.projectsDir, { recursive: true });

    const store = EngineStore.open(layout.engineDb);
    let mcpHub: McpHub | undefined;
    try {
      const modelRuntime = await ModelRuntime.open({
        dir: layout.root,
        env: options.env,
      });
      const storedMcp = store.getKv<Record<string, unknown>>(KV_MCP_SERVERS) ?? {};
      const parsedMcp = parseMcpConfig({ mcpServers: storedMcp });
      mcpHub = createMcpHub({
        servers: parsedMcp.servers,
        env: options.env,
        ...(options.createMcpTransport === undefined
          ? {}
          : { createTransport: options.createMcpTransport }),
      });
      await mcpHub.start();
      return new Engine(layout, store, modelRuntime, mcpHub, options);
    } catch (error) {
      await mcpHub?.close().catch(() => undefined);
      store.close();
      throw error;
    }
  }

  models(): Models {
    const override = this.#options.models;
    if (override !== undefined) {
      return typeof override === "function" ? override() : override;
    }
    return this.modelRuntime.models();
  }

  async reloadModels(): Promise<void> {
    this.#assertOpen();
    await this.modelRuntime.reload();
  }

  async listProviders(): Promise<ListProvidersResponse> {
    this.#assertOpen();
    return listProviders(this.#providerDeps());
  }

  async setProviderApiKey(providerId: string, input: SetApiKeyRequest): Promise<OkResponse> {
    this.#assertOpen();
    return setProviderApiKey(this.#providerDeps(), providerId, input);
  }

  async logoutProvider(providerId: string): Promise<OkResponse> {
    this.#assertOpen();
    return logoutProvider(this.#providerDeps(), providerId);
  }

  startProviderLogin(providerId: string, input: StartLoginRequest): StartLoginResponse {
    this.#assertOpen();
    return this.#loginSessions.start(this.models(), providerId, input.type);
  }

  subscribeLoginSession(
    providerId: string,
    sessionId: string,
    onFrame: (frame: LoginSseFrame) => void,
  ): () => void {
    this.#assertOpen();
    return this.#loginSessions.subscribe(providerId, sessionId, onFrame);
  }

  submitLoginInput(providerId: string, sessionId: string, input: LoginInputRequest): OkResponse {
    this.#assertOpen();
    this.#loginSessions.submitInput(providerId, sessionId, input);
    return { ok: true };
  }

  cancelLoginSession(providerId: string, sessionId: string): OkResponse {
    this.#assertOpen();
    this.#loginSessions.cancel(providerId, sessionId);
    return { ok: true };
  }

  async listModels(opts?: {
    readonly provider?: string;
    readonly available?: boolean;
  }): Promise<ListModelsResponse> {
    this.#assertOpen();
    return listModels(this.#providerDeps(), opts);
  }

  async refreshModels(input: RefreshModelsRequest = {}): Promise<RefreshModelsResponse> {
    this.#assertOpen();
    return refreshModels(this.#providerDeps(), input);
  }

  getModelProfiles(): ModelProfilesDocument {
    this.#assertOpen();
    return readModelProfiles(this.store);
  }

  putModelProfiles(doc: ModelProfilesDocument): ModelProfilesDocument {
    this.#assertOpen();
    const validated = parseWithSchema(ModelProfilesDocumentSchema, doc, "ModelProfilesDocument");
    this.store.setKv(KV_MODEL_PROFILES, validated);
    return validated;
  }

  getMcpState(): McpStateResponse {
    this.#assertOpen();
    return getMcpState(this.#mcpDeps());
  }

  async putMcpConfig(input: PutMcpConfigRequest): Promise<McpStateResponse> {
    this.#assertOpen();
    return putMcpConfig(this.#mcpDeps(), input);
  }

  async upsertMcpServer(name: string, input: UpsertMcpServerRequest): Promise<McpStateResponse> {
    this.#assertOpen();
    return upsertMcpServer(this.#mcpDeps(), name, input);
  }

  async deleteMcpServer(name: string): Promise<McpStateResponse> {
    this.#assertOpen();
    return deleteMcpServer(this.#mcpDeps(), name);
  }

  async reconnectMcp(input: ReconnectMcpRequest = {}): Promise<ReconnectMcpResponse> {
    this.#assertOpen();
    return reconnectMcp(this.#mcpDeps(), input);
  }

  getSettings(): EngineSettings {
    this.#assertOpen();
    return readEngineSettings(this.store);
  }

  async patchSettings(patch: EngineSettings): Promise<EngineSettings> {
    this.#assertOpen();
    const validated = parseWithSchema(EngineSettingsSchema, patch, "EngineSettings");
    const next = mergeEngineSettings(this.getSettings(), validated);
    this.store.setKv(KV_SETTINGS, next);
    await this.#pool.applySettingsLive();
    return next;
  }

  async putSettings(next: EngineSettings): Promise<EngineSettings> {
    this.#assertOpen();
    const validated = parseWithSchema(EngineSettingsSchema, next, "EngineSettings");
    this.store.setKv(KV_SETTINGS, validated);
    await this.#pool.applySettingsLive();
    return validated;
  }

  async exportConfig(): Promise<ConfigBundle> {
    this.#assertOpen();
    return exportEngineConfig({ layout: this.layout, store: this.store });
  }

  async importConfig(input: ConfigBundle): Promise<ConfigBundle> {
    this.#assertOpen();
    return importEngineConfig(
      {
        layout: this.layout,
        store: this.store,
        modelRuntime: this.modelRuntime,
        mcpHub: this.mcpHub,
        env: this.#options.env,
        syncProjects: () => this.#pool.syncMcpExtensions(),
        applySettings: () => this.#pool.applySettingsLive(),
      },
      input,
    );
  }

  createProject(input: CreateProjectRequest): ProjectSummary {
    this.#assertOpen();
    if (input.workspaces.length === 0) {
      throw new EngineError(
        400,
        "invalid_request",
        "workspaces must contain at least one directory",
      );
    }
    try {
      return this.store.createProject(input);
    } catch (error) {
      if (error instanceof Error) {
        throw new EngineError(400, "invalid_request", error.message);
      }
      throw error;
    }
  }

  listProjects(): ProjectSummary[] {
    this.#assertOpen();
    return this.store.listProjects();
  }

  getProject(projectId: string): ProjectSummary {
    this.#assertOpen();
    if (this.#pool.isDeleting(projectId)) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    const project = this.store.getProject(projectId);
    if (project === undefined) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    return project;
  }

  async updateProject(projectId: string, patch: UpdateProjectRequest): Promise<GetProjectResponse> {
    this.#assertOpen();
    this.getProject(projectId);
    let updated: ProjectSummary | undefined;
    try {
      updated = this.store.updateProject(projectId, patch);
    } catch (error) {
      if (error instanceof Error) {
        throw new EngineError(400, "invalid_request", error.message);
      }
      throw error;
    }
    if (updated === undefined) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    const openHandle = this.#pool.getOpenHandle(projectId);
    if (openHandle !== undefined) {
      this.#pool.touch(projectId);
      if (patch.models !== undefined) {
        await openHandle.reconfigureRouterModel(this.#knobs.modelSlots(projectId).router);
      }
      if (patch.workspaces !== undefined) {
        await openHandle.reconfigureWorkspaces(updated.workspaces);
      }
      if (patch.tools !== undefined) {
        await openHandle.reconfigureTools();
      }
    }
    return { project: updated };
  }

  async deleteProject(projectId: string): Promise<DeleteProjectResponse> {
    this.#assertOpen();
    this.getProject(projectId);
    await this.#pool.deleteOpenProject(projectId, async () => {
      this.store.deleteProject(projectId);
      const paths = projectPaths(this.layout, projectId);
      await rm(paths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    return { ok: true, id: projectId };
  }

  getProjectMemory(projectId: string): ProjectMemoryResponse {
    const project = this.getProject(projectId);
    return { projectId: project.id, memory: project.memory ?? null };
  }

  putProjectMemory(projectId: string, input: PutProjectMemoryRequest): ProjectMemoryResponse {
    this.#assertOpen();
    this.getProject(projectId);
    const updated = this.store.updateProject(projectId, { memory: input.memory });
    if (updated === undefined) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    this.#pool.touch(projectId);
    return { projectId: updated.id, memory: updated.memory ?? null };
  }

  async getProjectUsage(projectId: string): Promise<ProjectUsageResponse> {
    const handle = await this.openProject(projectId);
    const usage = await handle.usage(BACKGROUND_CONTEXT);
    return { projectId, usage };
  }

  async recoverProjects(): Promise<void> {
    this.#assertOpen();
    await this.#pool.recoverProjects();
  }

  isProjectOpen(projectId: string): boolean {
    return this.#pool.isProjectOpen(projectId);
  }

  acquireStream(projectId: string): () => void {
    return this.#pool.acquireStream(projectId);
  }

  async hibernateIdleProjects(now = Date.now()): Promise<string[]> {
    return this.#pool.hibernateIdleProjects(now);
  }

  async openProject(projectId: string): Promise<ProjectHandle> {
    this.#assertOpen();
    return this.#pool.openProject(projectId);
  }

  async sendMessage(
    projectId: string,
    ref: ConversationRef,
    input: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    const options = input.whenBusy === undefined ? undefined : { whenBusy: input.whenBusy };
    return this.#inProject(projectId, async (handle) =>
      submissionResponse(await handle.send(conversationTarget(ref), input.text, options)),
    );
  }

  async listEntries(
    projectId: string,
    ref: ConversationRef,
    params: ListEntriesParams = {},
  ): Promise<ListEntriesResponse> {
    const limit = params.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new EngineError(400, "invalid_query", "limit must be an integer between 1 and 500");
    }
    const cursor = params.cursor === undefined ? undefined : decodeCursor(params.cursor);
    const query: Omit<EntryQuery, "conversationId"> = {
      ...(params.order === undefined ? {} : { order: params.order }),
      ...(params.minEntryId === undefined ? {} : { minEntryId: params.minEntryId as EntryId }),
      ...(params.maxEntryId === undefined ? {} : { maxEntryId: params.maxEntryId as EntryId }),
    };
    return this.#inProject(projectId, async (handle) => {
      const page = await handle.listEntries(
        conversationTarget(ref),
        query,
        limit,
        cursor,
        BACKGROUND_CONTEXT,
      );
      return {
        entries: page.items as unknown as EntryRecordPayload[],
        ...(page.next === undefined ? {} : { nextCursor: encodeCursor(page.next) }),
      };
    });
  }

  async interrupt(projectId: string, ref: ConversationRef): Promise<OkResponse> {
    return this.#inProject(projectId, async (handle) => {
      await handle.interrupt(conversationTarget(ref), BACKGROUND_CONTEXT);
      return { ok: true };
    });
  }

  async retry(projectId: string, ref: ConversationRef): Promise<SendMessageResponse> {
    return this.#inProject(projectId, async (handle) =>
      submissionResponse(await handle.retry(conversationTarget(ref), BACKGROUND_CONTEXT)),
    );
  }

  async answerQuestion(
    projectId: string,
    questionId: QuestionId,
    input: AnswerQuestionRequest,
  ): Promise<AnswerQuestionResponse> {
    return this.#inProject(projectId, async (handle) => ({
      question: await handle.answerQuestion(
        questionId as CoreQuestionId,
        input.answers,
        BACKGROUND_CONTEXT,
      ),
    }));
  }

  async listWorkerTasks(
    projectId: string,
    workerId: WorkerId,
    options?: CoreListWorkerTasksOptions,
  ): Promise<ListWorkerTasksResponse> {
    if (
      options?.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
    ) {
      throw new EngineError(400, "invalid_query", "limit must be an integer between 1 and 100");
    }
    return this.#inProject(projectId, async (handle) => ({
      tasks: [
        ...(await handle.listWorkerTasks(workerId as CoreWorkerId, options, BACKGROUND_CONTEXT)),
      ],
    }));
  }

  async readWorkerTask(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
    options?: OutputReadOptions,
  ): Promise<ReadWorkerTaskResponse> {
    if (options !== undefined) {
      try {
        validateOutputReadOptions(options);
      } catch (error) {
        throw new EngineError(
          400,
          "invalid_query",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return this.#inProject(projectId, (handle) =>
      handle.readWorkerTaskOutput(workerId as CoreWorkerId, taskId, options, BACKGROUND_CONTEXT),
    );
  }

  async subscribeWorkerTaskStream(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
    options?: OutputReadOptions,
  ): Promise<WorkerTaskStream> {
    if (options !== undefined) {
      try {
        validateOutputReadOptions(options);
      } catch (error) {
        throw new EngineError(
          400,
          "invalid_query",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return this.#inProject(projectId, async (handle) => {
      const workers = await handle.workers(BACKGROUND_CONTEXT);
      const worker = workers.find((candidate) => candidate.id === workerId);
      if (worker === undefined) {
        throw new ProjectError("worker_not_found", `Unknown worker ${workerId}`);
      }

      const tasks = await handle.listWorkerTasks(
        workerId as CoreWorkerId,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const resolution = resolveTaskId(tasks, taskId);
      if (resolution.kind === "not_found") {
        throw new ProjectError("task_not_found", `Unknown task ${taskId} on worker ${workerId}`);
      }
      if (resolution.kind === "ambiguous") {
        throw new EngineError(
          400,
          "task_ambiguous",
          `Ambiguous task id "${taskId}" on worker ${workerId}`,
        );
      }
      const resolvedId = resolution.record.id;

      if (isTaskTerminalStatus(resolution.record.status)) {
        const snapshot = await handle.readWorkerTaskOutput(
          workerId as CoreWorkerId,
          resolvedId,
          options,
          BACKGROUND_CONTEXT,
        );
        return {
          snapshot,
          terminal: true,
          start: () => {},
          close: () => {},
        };
      }

      let closed = false;
      let started = false;
      let callbacks: WorkerTaskStreamCallbacks | undefined;
      const bufferedChunks: string[] = [];
      const bufferedBoards: BoardView[] = [];
      let unsubOutput: (() => void) | undefined;
      let unsubBoard: (() => void) | undefined;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubOutput?.();
        unsubOutput = undefined;
        unsubBoard?.();
        unsubBoard = undefined;
        bufferedChunks.length = 0;
        bufferedBoards.length = 0;
      };

      let handleBoard = (_board: BoardView) => {};

      unsubBoard = handle.subscribeBoard((board) => {
        if (closed) return;
        if (!started) {
          bufferedBoards.push(board);
          return;
        }
        handleBoard(board);
      });

      const running = handle.tasks.get(worker.conversationId, resolvedId);
      let snapshot: ReadWorkerTaskResponse;
      if (running !== undefined) {
        unsubOutput = running.onOutput((chunk) => {
          if (closed) return;
          if (!started) {
            bufferedChunks.push(chunk);
            return;
          }
          emitChunkText(chunk);
        });
        const live = running.output();
        const initialOutput = sliceRetainedOutput(
          Buffer.from(live.text, "utf8"),
          live.droppedBytes,
          live.totalBytes,
          options,
        );
        const freshTask = await getConversationTask(
          handle.harness,
          worker.conversationId,
          resolvedId,
          BACKGROUND_CONTEXT,
        );
        const task = freshTask ?? resolution.record;
        if (isTaskTerminalStatus(task.status)) {
          cleanup();
          const finalSnapshot = await handle.readWorkerTaskOutput(
            workerId as CoreWorkerId,
            resolvedId,
            options,
            BACKGROUND_CONTEXT,
          );
          return {
            snapshot: finalSnapshot,
            terminal: true,
            start: () => {},
            close: () => {},
          };
        }
        snapshot = { task, output: initialOutput };
      } else {
        snapshot = await handle.readWorkerTaskOutput(
          workerId as CoreWorkerId,
          resolvedId,
          options,
          BACKGROUND_CONTEXT,
        );
        if (isTaskTerminalStatus(snapshot.task.status)) {
          cleanup();
          return {
            snapshot,
            terminal: true,
            start: () => {},
            close: () => {},
          };
        }
      }

      let cursorByte = snapshot.output.totalBytes;
      let lastTask = snapshot.task;
      let lastTaskJson = JSON.stringify(lastTask);
      let pendingBoard = Promise.resolve();

      const emitChunkText = (text: string) => {
        if (closed) return;
        const byteLen = Buffer.byteLength(text, "utf8");
        if (byteLen === 0) return;
        const fromByte = cursorByte;
        const endByte = fromByte + byteLen;
        cursorByte = endByte;
        callbacks?.onChunk({ text, fromByte, endByte, totalBytes: endByte });
      };

      const emitChunkSlice = (slice: OutputSlice) => {
        if (closed) return;
        if (slice.fromByte < cursorByte || slice.endByte <= cursorByte || slice.text.length === 0) {
          return;
        }
        cursorByte = slice.endByte;
        callbacks?.onChunk({
          text: slice.text,
          fromByte: slice.fromByte,
          endByte: slice.endByte,
          totalBytes: slice.totalBytes,
        });
      };

      const processBoard = async (board: BoardView): Promise<void> => {
        if (closed) return;
        const boardWorker = board.workers.find((candidate) => candidate.id === workerId);
        let candidate = boardWorker?.tasks.find((task) => task.id === resolvedId);
        if (candidate === undefined) {
          candidate = await getConversationTask(
            handle.harness,
            worker.conversationId,
            resolvedId,
            BACKGROUND_CONTEXT,
          );
          if (candidate === undefined || closed) return;
        }
        if (taskStatusPhase(candidate.status) < taskStatusPhase(lastTask.status)) {
          return;
        }
        const candidateJson = JSON.stringify(candidate);
        if (isTaskTerminalStatus(candidate.status)) {
          unsubOutput?.();
          unsubOutput = undefined;
          for (;;) {
            if (closed) return;
            const read = await handle.readWorkerTaskOutput(
              workerId as CoreWorkerId,
              resolvedId,
              { mode: "head", sinceBytes: cursorByte, bytes: TASK_READ_MAX_BYTES },
              BACKGROUND_CONTEXT,
            );
            const slice = read.output;
            if (
              slice.fromByte >= cursorByte &&
              slice.endByte > cursorByte &&
              slice.text.length > 0
            ) {
              emitChunkSlice(slice);
              if (slice.endByte < slice.totalBytes) continue;
            }
            break;
          }
          if (closed) return;
          lastTask = candidate;
          lastTaskJson = candidateJson;
          callbacks?.onStatus(candidate);
          const onEnd = callbacks?.onEnd;
          cleanup();
          onEnd?.("completed");
          return;
        }
        if (candidateJson !== lastTaskJson) {
          lastTask = candidate;
          lastTaskJson = candidateJson;
          callbacks?.onStatus(candidate);
        }
      };

      handleBoard = (board: BoardView) => {
        pendingBoard = pendingBoard.then(() => processBoard(board)).catch(() => undefined);
      };

      return {
        snapshot,
        terminal: false,
        start: (nextCallbacks) => {
          if (closed || started) return;
          started = true;
          callbacks = nextCallbacks;
          const queuedChunks = bufferedChunks.splice(0, bufferedChunks.length);
          for (const chunk of queuedChunks) {
            emitChunkText(chunk);
          }
          const queuedBoards = bufferedBoards.splice(0, bufferedBoards.length);
          for (const board of queuedBoards) {
            handleBoard(board);
          }
        },
        close: cleanup,
      };
    });
  }

  async killWorkerTask(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
  ): Promise<KillWorkerTaskResponse> {
    return this.#inProject(projectId, async (handle) => ({
      task: await handle.killWorkerTask(workerId as CoreWorkerId, taskId, BACKGROUND_CONTEXT),
    }));
  }

  async getBoard(projectId: string): Promise<BoardView> {
    const handle = await this.openProject(projectId);
    return handle.board(BACKGROUND_CONTEXT);
  }

  async watchConversation(
    projectId: string,
    ref: ConversationRef,
    context: Context = BACKGROUND_CONTEXT,
    window?: ConversationWindow,
  ): Promise<ConversationWatch> {
    return this.#inProject(projectId, (handle) =>
      handle.watchConversation(conversationTarget(ref), context, window),
    );
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#dispose();
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new EngineError(503, "engine_closed", "Engine is closing");
    }
  }

  #providerDeps(): ProviderDeps {
    return {
      models: () => this.models(),
      credentials: () => {
        if (this.#options.credentials !== undefined) return this.#options.credentials;
        if (this.#options.models === undefined) return this.modelRuntime.credentials;
        return undefined;
      },
    };
  }

  #mcpDeps(): McpDeps {
    return {
      store: this.store,
      mcpHub: this.mcpHub,
      syncProjects: () => this.#pool.syncMcpExtensions(),
    };
  }

  async #inProject<T>(projectId: string, run: (handle: ProjectHandle) => Promise<T>): Promise<T> {
    const handle = await this.openProject(projectId);
    try {
      return await run(handle);
    } catch (error) {
      throw toEngineError(error);
    } finally {
      this.#pool.touch(projectId);
    }
  }

  async #dispose(): Promise<void> {
    this.#closed = true;
    await this.#loginSessions.close().catch(() => undefined);
    await this.#pool.closeAll();
    await this.mcpHub.close().catch(() => undefined);
    this.store.close();
  }
}
