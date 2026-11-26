import { basename, resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import type { Models, Usage } from "@earendil-works/pi-ai";
import {
  type CompactionSettings,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type ConversationWatch,
  type ConversationWindow,
  type Cursor,
  createRegistry,
  type EntryQuery,
  type EntryRecord,
  type Extension,
  Harness,
  type HarnessSettings,
  type Observation,
  type Observer,
  type Page,
  type Report,
  ROOT_CONVERSATION_ID,
  type Storage,
  type Submission,
  type TaskId,
  type UsageState,
  UserEntry,
} from "@earendil-works/pi-durable";
import type { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  type BackgroundTaskRecord,
  type BaseExtensionOptions,
  type CodemodeHandle,
  type CodemodeHandleOptions,
  createBaseExtension,
  createCachedCompactionExtension,
  createCodemodeHandle,
  createCodingToolsExtension,
  createManagedExecutionEnv,
  createReadonlyToolsExtension,
  createShellPathsExtension,
  createTasksExtension,
  createToolSearchExtension,
  getConversationTask,
  type McpHub,
  type ModelChoice,
  type OutputReadOptions,
  type OutputSlice,
  TaskManager,
} from "@eevee/agent";
import {
  createMemoryExtension,
  createSummarizer,
  Dreamer,
  ENTRY_PAGE,
  type MemoryBinding,
  MemoryStore,
  type RecallBudget,
  recallBudget,
  type Summarize,
} from "@eevee/memory";
import {
  CompactionUsageDoc,
  ProjectBoardDoc,
  type QuestionId,
  type QuestionRecord,
  readBoard,
  readQuestions,
  readTickets,
  readWorker,
  readWorkers,
  type TicketRecord,
  WorkerDoc,
  type WorkerId,
  type WorkerRecord,
} from "./docs.ts";
import { ProjectError } from "./errors.ts";
import { answerQuestion as submitQuestionAnswer } from "./extensions/ask-user.ts";
import { createRouterExtension, type RouterProjectInfo } from "./extensions/router.ts";
import { createWorkerExtension } from "./extensions/worker.ts";
import { ProjectPump } from "./pump.ts";
import { buildRouterAgent, type ModelSlots, resolveRoleExtensions } from "./roles.ts";
import { SerialPass } from "./serial-pass.ts";
import { resolveWorkerStatus } from "./status.ts";
import { addUsage, BoardFeed, type BoardView, projectUsage, readBoardView } from "./views.ts";

export type {
  Cursor,
  EntryQuery,
  EntryRecord,
  Page,
  ScanOrder,
} from "@earendil-works/pi-durable";
export type {
  BackgroundTaskRecord,
  OutputReadOptions,
  OutputSlice,
} from "@eevee/agent";

export const DEFAULT_ROUTER_CONTEXT_TOKENS = 80_000;

export type OpenProjectDeps = {
  readonly cwd: string;
  readonly title?: string;
  readonly workspaces?: readonly string[];
  readonly models: Models | (() => Models);
  readonly modelSlots?: ModelSlots | (() => ModelSlots);
  readonly settings?: HarnessSettings;
  readonly extensions?: readonly Extension[];
  readonly baseExtensionOptions?: BaseExtensionOptions;
  readonly maxActiveWorkers?: number | (() => number);
  readonly backgroundAfterMs?: number | (() => number);
  readonly routerContextTokens?: number | (() => number);
  readonly projectMeta?: () => RouterProjectInfo;
  readonly projectMemory?: () => string | undefined;
  readonly modelProfiles?: () => string | undefined | Promise<string | undefined>;
  readonly memorySummarizer?: () => Summarize | undefined;
  readonly memoryBudget?: () => RecallBudget;
  readonly codemode?: CodemodeHandleOptions | CodemodeHandle | false;
  readonly mcpHub?: McpHub;
  readonly taskManager?: TaskManager;
  readonly taskLogPath?: (conversationId: ConversationId, taskId: string) => string;
  readonly routerInstructions?: string;
  readonly workerInstructions?: string;
  readonly onReport?: (report: Report) => void;
  readonly onPumpError?: (error: unknown) => void;
};

export type ProjectTarget = "router" | WorkerId;

export type ProjectSendOptions = {
  readonly whenBusy?: "steer" | "followUp" | "reject";
};

export type ProjectSend = {
  (text: string, options?: ProjectSendOptions): Promise<Submission>;
  (target: ProjectTarget, text: string, options?: ProjectSendOptions): Promise<Submission>;
};

export type ProjectMemoryHandle = {
  readonly store: MemoryStore;
  readonly dreamer: Dreamer;
};

export type ProjectHandle = {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly tasks: TaskManager;
  readonly memory: ProjectMemoryHandle;
  readonly send: ProjectSend;
  watchConversation(
    target: ProjectTarget,
    context?: Context,
    window?: ConversationWindow,
  ): Promise<ConversationWatch>;
  observeConversation(
    target: ProjectTarget,
    observer: Observer<ConversationView>,
    context?: Context,
    window?: ConversationWindow,
  ): Promise<Observation<ConversationView>>;
  listEntries(
    target: ProjectTarget,
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
    cursor?: Cursor,
    context?: Context,
  ): Promise<Page<EntryRecord, Cursor>>;
  interrupt(target: ProjectTarget, context?: Context): Promise<void>;
  retry(target: ProjectTarget, context?: Context): Promise<Submission>;
  answerQuestion(
    questionId: QuestionId,
    answers: readonly string[],
    context?: Context,
  ): Promise<QuestionRecord>;
  readWorkerTaskOutput(
    workerId: WorkerId,
    taskId: string,
    options?: OutputReadOptions,
    context?: Context,
  ): Promise<{ readonly task: BackgroundTaskRecord; readonly output: OutputSlice }>;
  killWorkerTask(
    workerId: WorkerId,
    taskId: string,
    context?: Context,
  ): Promise<BackgroundTaskRecord>;
  board(context?: Context): Promise<BoardView>;
  subscribeBoard(listener: (view: BoardView) => void): () => void;
  workers(context?: Context): Promise<WorkerRecord[]>;
  tickets(context?: Context): Promise<TicketRecord[]>;
  questions(context?: Context): Promise<QuestionRecord[]>;
  usage(context?: Context): Promise<UsageState>;
  syncMcpExtensions(context?: Context): Promise<void>;
  reconfigureRouterModel(model: ModelChoice | undefined, context?: Context): Promise<void>;
  reconfigureWorkspaces(workspaces: readonly string[], context?: Context): Promise<void>;
  requestPump(): void;
  close(): Promise<void>;
};

function isCodemodeHandle(value: CodemodeHandleOptions | CodemodeHandle): value is CodemodeHandle {
  return "extension" in value && "sandbox" in value && "close" in value;
}

function sameExtensionOrder(current: readonly Extension[], desired: readonly Extension[]): boolean {
  return (
    current.length === desired.length &&
    current.every((extension, idx) => extension.name === desired[idx]?.name)
  );
}

export async function openProject(storage: Storage, deps: OpenProjectDeps): Promise<ProjectHandle> {
  const living = new AbortController();
  const livingContext = withAbortSignal(living.signal, BACKGROUND_CONTEXT);
  const projectRoot = resolve(deps.cwd);
  let currentWorkspaces: readonly string[] = (
    deps.workspaces !== undefined && deps.workspaces.length > 0 ? deps.workspaces : [projectRoot]
  ).map((dir) => resolve(projectRoot, dir));
  const getPrimaryWorkspace = () => currentWorkspaces[0] ?? projectRoot;
  const title = deps.title ?? (basename(projectRoot) || projectRoot);
  const getModels = typeof deps.models === "function" ? deps.models : () => deps.models as Models;
  const modelSlotsOption = deps.modelSlots;
  const getModelSlots =
    typeof modelSlotsOption === "function" ? modelSlotsOption : () => modelSlotsOption ?? {};
  const routerContextTokensOption = deps.routerContextTokens;
  const getRouterContextTokens =
    typeof routerContextTokensOption === "function"
      ? routerContextTokensOption
      : () => routerContextTokensOption ?? DEFAULT_ROUTER_CONTEXT_TOKENS;

  const registry = createRegistry();
  const ownsTaskManager = deps.taskManager === undefined;
  const taskManager =
    deps.taskManager ??
    new TaskManager(deps.taskLogPath === undefined ? {} : { logPath: deps.taskLogPath });

  let codemodeHandle: CodemodeHandle | undefined;
  let ownsCodemode = false;
  if (deps.codemode !== false) {
    if (deps.codemode !== undefined && isCodemodeHandle(deps.codemode)) {
      codemodeHandle = deps.codemode;
    } else {
      codemodeHandle = createCodemodeHandle(deps.codemode);
      ownsCodemode = true;
    }
  }

  let harnessRef: Harness | undefined;
  let memoryBinding: MemoryBinding | undefined;
  const getHarness = (): Harness => {
    if (harnessRef === undefined) throw new Error("Project harness is not open yet");
    return harnessRef;
  };

  const pendingCompactionUsage: { modelKey: string; usage: Usage }[] = [];
  const compactionUsagePass = new SerialPass(
    async () => {
      while (pendingCompactionUsage.length > 0) {
        const batch = pendingCompactionUsage.splice(0, pendingCompactionUsage.length);
        await getHarness().commit(async (tx) => {
          const doc = await tx.doc(CompactionUsageDoc);
          for (const item of batch) {
            const existing = Object.hasOwn(doc.models, item.modelKey)
              ? doc.models[item.modelKey]
              : undefined;
            if (existing === undefined) {
              doc.models[item.modelKey] = copyJson(item.usage, {
                omitUndefinedProperties: true,
              }) as JsonRepresentation<Usage>;
            } else {
              addUsage(
                existing,
                copyJson(item.usage, {
                  omitUndefinedProperties: true,
                }) as JsonRepresentation<Usage>,
              );
            }
          }
        }, BACKGROUND_CONTEXT);
      }
    },
    {
      ...(deps.onPumpError === undefined
        ? {}
        : {
            onError: (error) => {
              if (!living.signal.aborted) deps.onPumpError?.(error);
            },
          }),
    },
  );

  const extensions: Extension[] = [
    createBaseExtension({
      ...deps.baseExtensionOptions,
      workspaces: deps.baseExtensionOptions?.workspaces ?? (() => currentWorkspaces),
    }),
    createReadonlyToolsExtension(),
    createCodingToolsExtension(),
    createShellPathsExtension(),
    createTasksExtension({
      manager: taskManager,
      ...(deps.backgroundAfterMs === undefined
        ? {}
        : { backgroundAfterMs: deps.backgroundAfterMs }),
    }),
    createToolSearchExtension(),
    createCachedCompactionExtension({
      onCompact: (event) => {
        pendingCompactionUsage.push({
          modelKey: `${event.model.provider}/${event.model.modelId}`,
          usage: event.usage,
        });
        compactionUsagePass.request();
      },
    }),
    ...(codemodeHandle === undefined ? [] : [codemodeHandle.extension]),
    createMemoryExtension({
      resolve: (conversationId) =>
        conversationId === ROOT_CONVERSATION_ID ? memoryBinding : undefined,
    }),
    createRouterExtension({
      cwd: getPrimaryWorkspace,
      workerModel: () => {
        const slots = getModelSlots();
        return slots.worker ?? slots.router;
      },
      ...(deps.routerInstructions === undefined
        ? {}
        : { routerInstructions: deps.routerInstructions }),
      project: () => deps.projectMeta?.() ?? { title, workspaces: currentWorkspaces },
      ...(deps.projectMemory === undefined ? {} : { projectMemory: deps.projectMemory }),
      ...(deps.modelProfiles === undefined ? {} : { modelProfiles: deps.modelProfiles }),
      tasks: taskManager,
      readEntries: async (conversationId, limit, context) => {
        const conversation = await getHarness().conversation(conversationId, context);
        if (conversation === undefined) return [];
        const page = await conversation.entries({ order: "descending" }, limit, undefined, context);
        return [...page.items].reverse();
      },
    }),
    createWorkerExtension({
      ...(deps.projectMemory === undefined ? {} : { projectMemory: deps.projectMemory }),
      ...(deps.workerInstructions === undefined
        ? {}
        : { workerInstructions: deps.workerInstructions }),
    }),
    ...(deps.extensions ?? []),
  ];
  for (const extension of extensions) registry.install(extension);

  const unbindMcp = deps.mcpHub === undefined ? undefined : deps.mcpHub.bindRegistry(registry);

  const environments = new Map<string, NodeExecutionEnv>();
  const settings: HarnessSettings = {
    ...(deps.settings ?? {}),
    followUpMode: deps.settings?.followUpMode ?? "all",
  };
  let harness: Harness;
  try {
    harness = await Harness.open(
      storage,
      {
        models: getModels,
        registry,
        settings,
        ...(deps.onReport === undefined ? {} : { onReport: deps.onReport }),
        env: (target) => {
          const cwd =
            target.cwd === undefined
              ? getPrimaryWorkspace()
              : resolve(getPrimaryWorkspace(), target.cwd);
          let environment = environments.get(cwd);
          if (environment === undefined) {
            environment = createManagedExecutionEnv({ cwd });
            environments.set(cwd, environment);
          }
          return environment;
        },
      },
      BACKGROUND_CONTEXT,
    );
  } catch (error) {
    unbindMcp?.();
    if (ownsTaskManager) taskManager.killAll();
    if (ownsCodemode) await codemodeHandle?.close().catch(() => undefined);
    throw error;
  }
  harnessRef = harness;

  let boardFeed: BoardFeed | undefined;
  let pump: ProjectPump | undefined;
  let dreamer: Dreamer | undefined;
  let mcpSyncPass: SerialPass | undefined;
  let unsubscribeMcp: (() => void) | undefined;
  const disposeResources = async () => {
    living.abort();
    unsubscribeMcp?.();
    mcpSyncPass?.close();
    await mcpSyncPass?.idle();
    await boardFeed?.close();
    pump?.close();
    await pump?.idle();
    await dreamer?.close();
    if (pendingCompactionUsage.length > 0) compactionUsagePass.request();
    await compactionUsagePass.idle();
    compactionUsagePass.close();
    try {
      await harness.close(BACKGROUND_CONTEXT);
    } finally {
      unbindMcp?.();
      if (ownsTaskManager) taskManager.killAll();
      if (ownsCodemode) await codemodeHandle?.close().catch(() => undefined);
      await Promise.all(
        [...environments.values()].map((environment) =>
          environment.cleanup(BACKGROUND_CONTEXT).catch(() => undefined),
        ),
      );
    }
  };

  let root: Conversation;
  let memoryStore: MemoryStore;
  try {
    const resolveMemoryBudget = (): RecallBudget => {
      if (deps.memoryBudget !== undefined) return deps.memoryBudget();
      const routerModelChoice = getModelSlots().router;
      const contextWindow =
        routerModelChoice === undefined
          ? undefined
          : getModels().getModel(routerModelChoice.provider, routerModelChoice.modelId)
              ?.contextWindow;
      return recallBudget(contextWindow, getRouterContextTokens());
    };

    const initialRouterModel = getModelSlots().router;
    const initialCompaction =
      deps.memoryBudget !== undefined
        ? (resolveMemoryBudget().compaction ?? undefined)
        : deps.settings?.compaction !== undefined
          ? undefined
          : (resolveMemoryBudget().compaction ?? undefined);
    const routerAgent = buildRouterAgent({
      snapshot: registry.snapshot(),
      ...(initialRouterModel === undefined ? {} : { model: initialRouterModel }),
      cwd: projectRoot,
      ...(initialCompaction === undefined ? {} : { compaction: initialCompaction }),
    });

    const rootExisted =
      (await harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)) !== undefined;
    root = await harness.root(BACKGROUND_CONTEXT, { agent: routerAgent });
    if (rootExisted) {
      const clearModelFields =
        deps.modelSlots === undefined
          ? {}
          : initialRouterModel === undefined
            ? ({ model: null, thinkingLevel: null } as const)
            : initialRouterModel.thinkingLevel === undefined
              ? ({ thinkingLevel: null } as const)
              : {};
      await root.configure(
        { ...routerAgent, ...clearModelFields, instructions: null },
        BACKGROUND_CONTEXT,
      );
    }

    memoryStore = await MemoryStore.open(harness, root.id, livingContext);
    const createdDreamer = new Dreamer({
      store: memoryStore,
      pager: (minEntryId, cursor, context) =>
        root.entries(
          { ...(minEntryId === undefined ? {} : { minEntryId }), order: "ascending" },
          ENTRY_PAGE,
          cursor,
          context,
        ),
      summarizer: () => {
        if (deps.memorySummarizer !== undefined) return deps.memorySummarizer();
        const choice = getModelSlots().dreamer;
        return choice === undefined ? undefined : createSummarizer(getModels(), choice);
      },
      harness,
      context: livingContext,
      label: title,
      ...(deps.onPumpError === undefined ? {} : { onError: (error) => deps.onPumpError?.(error) }),
    });
    dreamer = createdDreamer;
    memoryBinding = {
      store: memoryStore,
      budget: resolveMemoryBudget,
      sync: (context) => createdDreamer.sync(context),
    };

    boardFeed = new BoardFeed(harness, {
      context: livingContext,
      ...(deps.onPumpError === undefined ? {} : { onError: deps.onPumpError }),
    });

    pump = new ProjectPump(harness, {
      ...(deps.maxActiveWorkers === undefined ? {} : { maxActiveWorkers: deps.maxActiveWorkers }),
      context: livingContext,
      ...(deps.onPumpError === undefined ? {} : { onError: deps.onPumpError }),
    });

    const syncMcpExtensionsNow = async (): Promise<void> => {
      if (living.signal.aborted) return;
      const snapshot = registry.snapshot();
      const routerExtensions = resolveRoleExtensions("router", snapshot);
      const workerExtensions = resolveRoleExtensions("worker", snapshot);
      const currentRouter = await root.agent(livingContext);
      if (!sameExtensionOrder(currentRouter.extensions, routerExtensions)) {
        await root.configure({ extensions: routerExtensions }, livingContext);
      }
      const workers = await readWorkers(harness, livingContext);
      for (const worker of workers) {
        if (worker.closedAt !== undefined) continue;
        const conversation = await harness.conversation(worker.conversationId, livingContext);
        if (conversation === undefined) continue;
        const currentWorker = await conversation.agent(livingContext);
        if (!sameExtensionOrder(currentWorker.extensions, workerExtensions)) {
          await conversation.configure({ extensions: workerExtensions }, livingContext);
        }
      }
    };

    mcpSyncPass = new SerialPass(syncMcpExtensionsNow, {
      ...(deps.onPumpError === undefined
        ? {}
        : {
            onError: (error) => {
              if (!living.signal.aborted) deps.onPumpError?.(error);
            },
          }),
    });
    if (deps.mcpHub !== undefined) {
      unsubscribeMcp = deps.mcpHub.subscribe(() => {
        mcpSyncPass?.request();
      });
      mcpSyncPass.request();
    }

    await createdDreamer.sync(livingContext);
    createdDreamer.wake();
    pump.request();
    harness.resume();
  } catch (error) {
    await disposeResources().catch(() => undefined);
    throw error;
  }

  const activeDreamer = dreamer;
  const activeBoardFeed = boardFeed;
  const activePump = pump;
  const activeMcpSyncPass = mcpSyncPass;

  async function resolveTargetConversation(
    target: ProjectTarget,
    context: Context,
  ): Promise<Conversation> {
    if (target === "router") return root;
    const worker = await readWorker(harness, target, context);
    if (worker === undefined)
      throw new ProjectError("worker_not_found", `Unknown worker ${target}`);
    const conversation = await harness.conversation(worker.conversationId, context);
    if (conversation === undefined)
      throw new ProjectError("worker_not_found", `Worker ${target} has no conversation`);
    return conversation;
  }

  const send = (async (
    first: string,
    second?: string | ProjectSendOptions,
    third?: ProjectSendOptions,
  ) => {
    const targeted = typeof second === "string";
    const target = (targeted ? first : "router") as ProjectTarget;
    const text = targeted ? (second as string) : first;
    const options = targeted ? third : (second as ProjectSendOptions | undefined);
    if (target === "router") {
      return root.submit(
        {
          type: "input",
          content: text,
          whenBusy: options?.whenBusy ?? "followUp",
        },
        BACKGROUND_CONTEXT,
      );
    }

    const worker = await readWorker(harness, target, BACKGROUND_CONTEXT);
    if (worker === undefined)
      throw new ProjectError("worker_not_found", `Unknown worker ${target}`);
    if (worker.closedAt !== undefined)
      throw new ProjectError("worker_closed", `Worker ${target} is closed`);
    const conversation = await harness.conversation(worker.conversationId, BACKGROUND_CONTEXT);
    if (conversation === undefined)
      throw new ProjectError("worker_not_found", `Worker ${target} has no conversation`);
    const submissionId = await harness.commit(async (tx) => {
      const current = await tx.doc(WorkerDoc, target, null);
      if (current.conversationId !== worker.conversationId) {
        throw new ProjectError("worker_not_found", `Unknown worker ${target}`);
      }
      if (current.closedAt !== undefined)
        throw new ProjectError("worker_closed", `Worker ${target} is closed`);
      const board = await tx.doc(ProjectBoardDoc);
      const queued = board.pendingStarts.some((start) => start.workerId === target);
      if (queued) {
        return conversation.submit(tx, {
          type: "write",
          entry: {
            kind: UserEntry.kind,
            model: [{ role: "user", content: text, timestamp: Date.now() }],
          },
        });
      }
      return conversation.submit(tx, {
        type: "input",
        content: text,
        whenBusy: options?.whenBusy ?? "followUp",
      });
    }, BACKGROUND_CONTEXT);
    const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
    if (submission === undefined) throw new Error(`Submission ${submissionId} does not exist`);
    return submission;
  }) as ProjectSend;

  let closePromise: Promise<void> | undefined;
  return {
    harness,
    root,
    tasks: taskManager,
    memory: { store: memoryStore, dreamer: activeDreamer },
    send,
    watchConversation: async (target, context = BACKGROUND_CONTEXT, window) => {
      const conversation = await resolveTargetConversation(target, context);
      return conversation.watch(context, window);
    },
    observeConversation: async (target, observer, context = BACKGROUND_CONTEXT, window) => {
      const conversation = await resolveTargetConversation(target, context);
      return harness.observeConversation(conversation.id, observer, context, window);
    },
    listEntries: async (target, query, limit, cursor, context = BACKGROUND_CONTEXT) => {
      const conversation = await resolveTargetConversation(target, context);
      return conversation.entries(query, limit, cursor, context);
    },
    interrupt: async (target, context = BACKGROUND_CONTEXT) => {
      const conversation = await resolveTargetConversation(target, context);
      await conversation.abort(context);
    },
    retry: async (target, context = BACKGROUND_CONTEXT) => {
      if (target === "router") {
        return root.submit({ type: "continue" }, context);
      }
      const worker = await readWorker(harness, target, context);
      if (worker === undefined)
        throw new ProjectError("worker_not_found", `Unknown worker ${target}`);
      if (worker.closedAt !== undefined)
        throw new ProjectError("worker_closed", `Worker ${target} is closed`);
      const conversation = await harness.conversation(worker.conversationId, context);
      if (conversation === undefined)
        throw new ProjectError("worker_not_found", `Worker ${target} has no conversation`);
      const submissionId = await harness.commit(async (tx) => {
        const current = await tx.doc(WorkerDoc, target, null);
        if (current.conversationId !== worker.conversationId) {
          throw new ProjectError("worker_not_found", `Unknown worker ${target}`);
        }
        if (current.closedAt !== undefined)
          throw new ProjectError("worker_closed", `Worker ${target} is closed`);
        const board = await tx.doc(ProjectBoardDoc);
        const queued = board.pendingStarts.some((start) => start.workerId === target);
        if (queued) throw new ProjectError("worker_queued", `Worker ${target} is queued`);
        return conversation.submit(tx, { type: "continue" });
      }, context);
      const submission = await harness.submission(submissionId, context);
      if (submission === undefined) throw new Error(`Submission ${submissionId} does not exist`);
      return submission;
    },
    answerQuestion: (questionId, answers, context = BACKGROUND_CONTEXT) =>
      submitQuestionAnswer(harness, questionId, answers, context),
    readWorkerTaskOutput: async (workerId, taskId, options, context = BACKGROUND_CONTEXT) => {
      const worker = await readWorker(harness, workerId, context);
      if (worker === undefined)
        throw new ProjectError("worker_not_found", `Unknown worker ${workerId}`);
      const record = await getConversationTask(harness, worker.conversationId, taskId, context);
      if (record === undefined) {
        throw new ProjectError("task_not_found", `Unknown task ${taskId} on worker ${workerId}`);
      }
      return {
        task: record,
        output: await taskManager.readOutput(worker.conversationId, taskId, record, options),
      };
    },
    killWorkerTask: async (workerId, taskId, context = BACKGROUND_CONTEXT) => {
      const worker = await readWorker(harness, workerId, context);
      if (worker === undefined)
        throw new ProjectError("worker_not_found", `Unknown worker ${workerId}`);
      const record = await getConversationTask(harness, worker.conversationId, taskId, context);
      if (record === undefined) {
        throw new ProjectError("task_not_found", `Unknown task ${taskId} on worker ${workerId}`);
      }
      if (record.status !== "running" || record.durableTaskId === undefined) {
        throw new ProjectError(
          "task_not_running",
          `Task ${taskId} on worker ${workerId} is not running (${record.status})`,
        );
      }
      const durableTaskId = record.durableTaskId as TaskId;
      await harness.abortTask(durableTaskId, context);
      await harness.waitForTask(durableTaskId, context);
      const updated = await getConversationTask(harness, worker.conversationId, taskId, context);
      if (updated === undefined) {
        throw new Error(`Task ${taskId} on worker ${workerId} disappeared after kill`);
      }
      return updated;
    },
    board: (context = BACKGROUND_CONTEXT) => readBoardView(harness, context),
    subscribeBoard: (listener) => activeBoardFeed.subscribe(listener),
    workers: async (context = BACKGROUND_CONTEXT) => {
      const board = await readBoard(harness, context);
      const workers = await readWorkers(harness, context, board);
      const pendingWorkerIds = board?.pendingStarts.map((start) => start.workerId) ?? [];
      return Promise.all(
        workers.map(async (worker) => ({
          ...worker,
          status: await resolveWorkerStatus(harness, worker, pendingWorkerIds, context),
        })),
      );
    },
    tickets: async (context = BACKGROUND_CONTEXT) => {
      const board = await readBoard(harness, context);
      return readTickets(harness, context, board);
    },
    questions: async (context = BACKGROUND_CONTEXT) => {
      const board = await readBoard(harness, context);
      return readQuestions(harness, context, board);
    },
    usage: async (context = BACKGROUND_CONTEXT) => {
      await compactionUsagePass.idle();
      return projectUsage(harness, root.id, context);
    },
    syncMcpExtensions: async (context = BACKGROUND_CONTEXT) => {
      context.abortSignal?.throwIfAborted();
      activeMcpSyncPass.request();
      await activeMcpSyncPass.idle();
      context.abortSignal?.throwIfAborted();
    },
    reconfigureRouterModel: async (model, context = BACKGROUND_CONTEXT) => {
      const compaction: CompactionSettings | null | undefined =
        deps.memoryBudget !== undefined
          ? (deps.memoryBudget().compaction ?? null)
          : deps.settings?.compaction !== undefined
            ? undefined
            : (recallBudget(
                model === undefined
                  ? undefined
                  : getModels().getModel(model.provider, model.modelId)?.contextWindow,
                getRouterContextTokens(),
              ).compaction ?? null);
      await root.configure(
        {
          model: model === undefined ? null : { provider: model.provider, modelId: model.modelId },
          thinkingLevel: model?.thinkingLevel ?? null,
          ...(compaction === undefined ? {} : { compaction }),
        },
        context,
      );
    },
    reconfigureWorkspaces: async (workspaces, context = BACKGROUND_CONTEXT) => {
      if (workspaces.length === 0) {
        throw new RangeError("reconfigureWorkspaces requires at least one workspace");
      }
      const previousPrimary = getPrimaryWorkspace();
      const next = workspaces.map((dir) => resolve(previousPrimary, dir));
      currentWorkspaces = next;
      const nextPrimary = next[0] ?? projectRoot;
      if (nextPrimary !== previousPrimary) {
        await root.configure({ cwd: nextPrimary }, context);
      }
    },
    requestPump: () => activePump.request(),
    close: () => {
      closePromise ??= disposeResources();
      return closePromise;
    },
  };
}
