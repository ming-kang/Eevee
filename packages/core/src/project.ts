import { basename, resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ConversationId,
  type ConversationView,
  type ConversationWatch,
  type ConversationWindow,
  createRegistry,
  type Extension,
  Harness,
  type HarnessSettings,
  type Observation,
  type Observer,
  type Report,
  ROOT_CONVERSATION_ID,
  type Storage,
  type Submission,
  type TaskId,
  type UsageState,
  UserEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  type BackgroundTaskRecord,
  type BaseExtensionOptions,
  createBaseExtension,
  createCachedCompactionExtension,
  createCodingToolsExtension,
  createReadonlyToolsExtension,
  createShellPathsExtension,
  createTasksExtension,
  createToolSearchExtension,
  getConversationTask,
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
import { answerQuestion as submitQuestionAnswer } from "./extensions/ask-user.ts";
import { createRouterExtension } from "./extensions/router.ts";
import { createWorkerExtension } from "./extensions/worker.ts";
import { ProjectPump } from "./pump.ts";
import {
  buildRouterAgent,
  DEFAULT_ROUTER_INSTRUCTIONS,
  DEFAULT_WORKER_INSTRUCTIONS,
  type ModelSlots,
} from "./roles.ts";
import { resolveWorkerStatus } from "./status.ts";
import { BoardFeed, type BoardView, projectUsage, readBoardView } from "./views.ts";

export const DEFAULT_ROUTER_CONTEXT_TOKENS = 80_000;

export type OpenProjectDeps = {
  readonly cwd: string;
  readonly title?: string;
  readonly workspaces?: readonly string[];
  readonly models: Models | (() => Models);
  readonly modelSlots?: ModelSlots;
  readonly settings?: HarnessSettings;
  readonly extensions?: readonly Extension[];
  readonly baseExtensionOptions?: BaseExtensionOptions;
  readonly maxActiveWorkers?: number;
  readonly backgroundAfterMs?: number | (() => number);
  readonly routerContextTokens?: number;
  readonly projectMemory?: () => string | undefined;
  readonly modelProfiles?: () => string | undefined | Promise<string | undefined>;
  readonly memorySummarizer?: () => Summarize | undefined;
  readonly memoryBudget?: () => RecallBudget;
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
  interrupt(target: ProjectTarget, context?: Context): Promise<void>;
  answerQuestion(
    questionId: QuestionId,
    answers: readonly string[],
    context?: Context,
  ): Promise<QuestionRecord>;
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
  close(): Promise<void>;
};

export async function openProject(storage: Storage, deps: OpenProjectDeps): Promise<ProjectHandle> {
  const living = new AbortController();
  const livingContext = withAbortSignal(living.signal, BACKGROUND_CONTEXT);
  const projectRoot = resolve(deps.cwd);
  const workspaces = (
    deps.workspaces !== undefined && deps.workspaces.length > 0 ? deps.workspaces : [projectRoot]
  ).map((dir) => resolve(projectRoot, dir));
  const title = deps.title ?? (basename(projectRoot) || projectRoot);
  const getModels = typeof deps.models === "function" ? deps.models : () => deps.models as Models;

  const registry = createRegistry();
  const ownsTaskManager = deps.taskManager === undefined;
  const taskManager =
    deps.taskManager ??
    new TaskManager(deps.taskLogPath === undefined ? {} : { logPath: deps.taskLogPath });
  const workerInstructions = deps.workerInstructions ?? DEFAULT_WORKER_INSTRUCTIONS;

  let harnessRef: Harness | undefined;
  let memoryBinding: MemoryBinding | undefined;
  const getHarness = (): Harness => {
    if (harnessRef === undefined) throw new Error("Project harness is not open yet");
    return harnessRef;
  };

  const extensions: Extension[] = [
    createBaseExtension(deps.baseExtensionOptions),
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
    createCachedCompactionExtension(),
    createMemoryExtension({
      resolve: (conversationId) =>
        conversationId === ROOT_CONVERSATION_ID ? memoryBinding : undefined,
    }),
    createRouterExtension({
      cwd: projectRoot,
      workerModel: deps.modelSlots?.worker ?? deps.modelSlots?.router,
      workerInstructions,
      project: () => ({ title, workspaces }),
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
    createWorkerExtension(
      deps.projectMemory === undefined ? {} : { projectMemory: deps.projectMemory },
    ),
    ...(deps.extensions ?? []),
  ];
  for (const extension of extensions) registry.install(extension);

  const environments = new Map<string, NodeExecutionEnv>();
  const settings: HarnessSettings = {
    ...(deps.settings ?? {}),
    followUpMode: deps.settings?.followUpMode ?? "all",
  };
  const harness = await Harness.open(
    storage,
    {
      models: getModels,
      registry,
      settings,
      ...(deps.onReport === undefined ? {} : { onReport: deps.onReport }),
      env: (target) => {
        const cwd = target.cwd === undefined ? projectRoot : resolve(projectRoot, target.cwd);
        let environment = environments.get(cwd);
        if (environment === undefined) {
          environment = new NodeExecutionEnv({ cwd });
          environments.set(cwd, environment);
        }
        return environment;
      },
    },
    BACKGROUND_CONTEXT,
  );
  harnessRef = harness;

  let boardFeed: BoardFeed | undefined;
  let pump: ProjectPump | undefined;
  let dreamer: Dreamer | undefined;
  const disposeResources = async () => {
    living.abort();
    await boardFeed?.close();
    pump?.close();
    await pump?.idle();
    await dreamer?.close();
    try {
      await harness.close(BACKGROUND_CONTEXT);
    } finally {
      if (ownsTaskManager) taskManager.killAll();
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
      const routerModelChoice = deps.modelSlots?.router;
      const contextWindow =
        routerModelChoice === undefined
          ? undefined
          : getModels().getModel(routerModelChoice.provider, routerModelChoice.modelId)
              ?.contextWindow;
      return recallBudget(contextWindow, deps.routerContextTokens ?? DEFAULT_ROUTER_CONTEXT_TOKENS);
    };

    const initialCompaction =
      deps.memoryBudget !== undefined
        ? (resolveMemoryBudget().compaction ?? undefined)
        : deps.settings?.compaction !== undefined
          ? undefined
          : (resolveMemoryBudget().compaction ?? undefined);
    const routerAgent = buildRouterAgent({
      snapshot: registry.snapshot(),
      ...(deps.modelSlots?.router === undefined ? {} : { model: deps.modelSlots.router }),
      instructions: deps.routerInstructions ?? DEFAULT_ROUTER_INSTRUCTIONS,
      cwd: projectRoot,
      ...(initialCompaction === undefined ? {} : { compaction: initialCompaction }),
    });

    const rootExisted =
      (await harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)) !== undefined;
    root = await harness.root(BACKGROUND_CONTEXT, { agent: routerAgent });
    if (rootExisted) await root.configure(routerAgent, BACKGROUND_CONTEXT);

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
        const choice = deps.modelSlots?.dreamer;
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

  async function resolveTargetConversation(
    target: ProjectTarget,
    context: Context,
  ): Promise<Conversation> {
    if (target === "router") return root;
    const worker = await readWorker(harness, target, context);
    if (worker === undefined) throw new Error(`Unknown worker ${target}`);
    const conversation = await harness.conversation(worker.conversationId, context);
    if (conversation === undefined) throw new Error(`Worker ${target} has no conversation`);
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
    if (worker === undefined) throw new Error(`Unknown worker ${target}`);
    if (worker.closedAt !== undefined) throw new Error(`Worker ${target} is closed`);
    const conversation = await harness.conversation(worker.conversationId, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error(`Worker ${target} has no conversation`);
    const submissionId = await harness.commit(async (tx) => {
      const current = await tx.doc(WorkerDoc, target, null);
      if (current.conversationId !== worker.conversationId) {
        throw new Error(`Unknown worker ${target}`);
      }
      if (current.closedAt !== undefined) throw new Error(`Worker ${target} is closed`);
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
    interrupt: async (target, context = BACKGROUND_CONTEXT) => {
      const conversation = await resolveTargetConversation(target, context);
      await conversation.abort(context);
    },
    answerQuestion: (questionId, answers, context = BACKGROUND_CONTEXT) =>
      submitQuestionAnswer(harness, questionId, answers, context),
    killWorkerTask: async (workerId, taskId, context = BACKGROUND_CONTEXT) => {
      const worker = await readWorker(harness, workerId, context);
      if (worker === undefined) throw new Error(`Unknown worker ${workerId}`);
      const record = await getConversationTask(harness, worker.conversationId, taskId, context);
      if (record === undefined) {
        throw new Error(`Unknown task ${taskId} on worker ${workerId}`);
      }
      if (record.status !== "running" || record.durableTaskId === undefined) {
        throw new Error(`Task ${taskId} on worker ${workerId} is not running (${record.status})`);
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
    usage: (context = BACKGROUND_CONTEXT) => projectUsage(harness, root.id, context),
    close: () => {
      closePromise ??= disposeResources();
      return closePromise;
    },
  };
}
