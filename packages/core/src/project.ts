import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type {
  Conversation,
  ConversationId,
  ConversationView,
  ConversationWatch,
  ConversationWindow,
  Cursor,
  EntryQuery,
  EntryRecord,
  Extension,
  Harness,
  HarnessSettings,
  Observation,
  Observer,
  Page,
  Report,
  Storage,
  Submission,
  UsageState,
  UserInput,
} from "@earendil-works/pi-durable";
import type {
  BackgroundTaskRecord,
  BaseExtensionOptions,
  CodemodeHandle,
  CodemodeHandleOptions,
  McpHub,
  ModelChoice,
  OutputReadOptions,
  OutputSlice,
  TaskManager,
} from "@eevee/agent";
import type { Dreamer, MemoryStore, RecallBudget, Summarize } from "@eevee/memory";
import {
  type QuestionId,
  type QuestionRecord,
  readBoard,
  readQuestions,
  readTickets,
  type TicketRecord,
  type WorkerId,
  type WorkerRecord,
} from "./docs.ts";
import { ProjectError } from "./errors.ts";
import { answerQuestion as submitQuestionAnswer } from "./extensions/ask-user.ts";
import type { RouterProjectInfo } from "./extensions/router.ts";
import { DEFAULT_ROUTER_CONTEXT_TOKENS, ProjectRuntime } from "./project-runtime.ts";
import type { ModelSlots, ToolPolicy } from "./roles.ts";
import { type BoardView, type DailyUsageBucket, readBoardView } from "./views.ts";
import {
  buildWorkerMessageSubmission,
  commitWorkerSubmission,
  killWorkerTask,
  type ListWorkerTasksOptions,
  listProjectWorkers,
  listWorkerTasks,
  type ProjectTarget,
  type ResolvedWorkerTask,
  readWorkerTaskOutput,
  resolveTargetConversation,
  resolveWorkerTask,
  subscribeWorkerTaskOutput,
} from "./worker-ops.ts";

export type {
  Cursor,
  EntryQuery,
  EntryRecord,
  Page,
  ScanOrder,
  UserInput,
} from "@earendil-works/pi-durable";
export type {
  BackgroundTaskRecord,
  BackgroundTaskStatus,
  OutputReadOptions,
  OutputSlice,
} from "@eevee/agent";
export type { ListWorkerTasksOptions, ProjectTarget, ResolvedWorkerTask } from "./worker-ops.ts";
export { DEFAULT_ROUTER_CONTEXT_TOKENS };

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
  readonly toolPolicy?: ToolPolicy | (() => ToolPolicy | undefined);
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

export type ProjectSendOptions = {
  readonly whenBusy?: "steer" | "followUp" | "reject";
};

export type ProjectSend = {
  (content: UserInput, options?: ProjectSendOptions): Promise<Submission>;
  (target: ProjectTarget, content: UserInput, options?: ProjectSendOptions): Promise<Submission>;
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
  resolveWorkerTask(
    workerId: WorkerId,
    taskId: string,
    context?: Context,
  ): Promise<ResolvedWorkerTask>;
  listWorkerTasks(
    workerId: WorkerId,
    options?: ListWorkerTasksOptions,
    context?: Context,
  ): Promise<readonly BackgroundTaskRecord[]>;
  readWorkerTaskOutput(
    workerId: WorkerId,
    taskId: string,
    options?: OutputReadOptions,
    context?: Context,
  ): Promise<{ readonly task: BackgroundTaskRecord; readonly output: OutputSlice }>;
  subscribeWorkerTaskOutput(
    workerId: WorkerId,
    taskId: string,
    listener: (chunk: string) => void,
    context?: Context,
  ): Promise<(() => void) | undefined>;
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
  dailyUsage(context?: Context): Promise<DailyUsageBucket[]>;
  syncMcpExtensions(context?: Context): Promise<void>;
  rebindMcpHub(mcpHub: McpHub | undefined, context?: Context): Promise<void>;
  reconfigureTools(context?: Context): Promise<void>;
  reconfigureRouterModel(model: ModelChoice | undefined, context?: Context): Promise<void>;
  reconfigureWorkspaces(workspaces: readonly string[], context?: Context): Promise<void>;
  requestPump(): void;
  close(): Promise<void>;
};

export async function openProject(storage: Storage, deps: OpenProjectDeps): Promise<ProjectHandle> {
  const runtime = new ProjectRuntime(deps);
  const { harness, root, memory } = await runtime.start(storage);

  const send = (async (
    first: ProjectTarget | UserInput,
    second?: UserInput | ProjectSendOptions,
    third?: ProjectSendOptions,
  ) => {
    const targeted = typeof second === "string" || Array.isArray(second);
    const target = (targeted ? first : "router") as ProjectTarget;
    const content = (targeted ? second : first) as UserInput;
    const options = targeted ? third : (second as ProjectSendOptions | undefined);
    if (target === "router") {
      return root.submit(
        {
          type: "input",
          content,
          whenBusy: options?.whenBusy ?? "followUp",
        },
        BACKGROUND_CONTEXT,
      );
    }
    return commitWorkerSubmission(harness, target, BACKGROUND_CONTEXT, ({ queued }) =>
      buildWorkerMessageSubmission({
        queued,
        content,
        ...(options?.whenBusy === undefined ? {} : { whenBusy: options.whenBusy }),
      }),
    );
  }) as ProjectSend;

  return {
    harness,
    root,
    tasks: runtime.tasks,
    memory,
    send,
    watchConversation: async (target, context = BACKGROUND_CONTEXT, window) =>
      (await resolveTargetConversation(harness, root, target, context)).watch(context, window),
    observeConversation: async (target, observer, context = BACKGROUND_CONTEXT, window) => {
      const conversation = await resolveTargetConversation(harness, root, target, context);
      return harness.observeConversation(conversation.id, observer, context, window);
    },
    listEntries: async (target, query, limit, cursor, context = BACKGROUND_CONTEXT) =>
      (await resolveTargetConversation(harness, root, target, context)).entries(
        query,
        limit,
        cursor,
        context,
      ),
    interrupt: async (target, context = BACKGROUND_CONTEXT) =>
      (await resolveTargetConversation(harness, root, target, context)).abort(context),
    retry: async (target, context = BACKGROUND_CONTEXT) => {
      if (target === "router") return root.submit({ type: "continue" }, context);
      return commitWorkerSubmission(harness, target, context, ({ queued }) => {
        if (queued) throw new ProjectError("worker_queued", `Worker ${target} is queued`);
        return { type: "continue" };
      });
    },
    answerQuestion: (questionId, answers, context = BACKGROUND_CONTEXT) =>
      submitQuestionAnswer(harness, questionId, answers, context),
    resolveWorkerTask: (workerId, taskId, context = BACKGROUND_CONTEXT) =>
      resolveWorkerTask(harness, workerId, taskId, context),
    listWorkerTasks: (workerId, options, context = BACKGROUND_CONTEXT) =>
      listWorkerTasks(harness, workerId, options, context),
    readWorkerTaskOutput: (workerId, taskId, options, context = BACKGROUND_CONTEXT) =>
      readWorkerTaskOutput(harness, runtime.tasks, workerId, taskId, options, context),
    subscribeWorkerTaskOutput: (workerId, taskId, listener, context = BACKGROUND_CONTEXT) =>
      subscribeWorkerTaskOutput(harness, runtime.tasks, workerId, taskId, listener, context),
    killWorkerTask: (workerId, taskId, context = BACKGROUND_CONTEXT) =>
      killWorkerTask(harness, runtime.tasks, workerId, taskId, context),
    board: (context = BACKGROUND_CONTEXT) => readBoardView(harness, context),
    subscribeBoard: (listener) => runtime.subscribeBoard(listener),
    workers: (context = BACKGROUND_CONTEXT) => listProjectWorkers(harness, context),
    tickets: async (context = BACKGROUND_CONTEXT) =>
      readTickets(harness, context, await readBoard(harness, context)),
    questions: async (context = BACKGROUND_CONTEXT) =>
      readQuestions(harness, context, await readBoard(harness, context)),
    usage: (context = BACKGROUND_CONTEXT) => runtime.usage(context),
    dailyUsage: (context = BACKGROUND_CONTEXT) => runtime.dailyUsage(context),
    syncMcpExtensions: (context = BACKGROUND_CONTEXT) => runtime.syncMcpExtensions(context),
    rebindMcpHub: (nextHub, context = BACKGROUND_CONTEXT) => runtime.rebindMcpHub(nextHub, context),
    reconfigureTools: (context = BACKGROUND_CONTEXT) => runtime.reconfigureTools(context),
    reconfigureRouterModel: (model, context = BACKGROUND_CONTEXT) =>
      runtime.reconfigureRouterModel(model, context),
    reconfigureWorkspaces: (workspaces, context = BACKGROUND_CONTEXT) =>
      runtime.reconfigureWorkspaces(workspaces, context),
    requestPump: () => runtime.requestPump(),
    close: () => runtime.close(),
  };
}
