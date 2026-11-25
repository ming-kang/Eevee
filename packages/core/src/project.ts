import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  type Extension,
  Harness,
  type HarnessSettings,
  ROOT_CONVERSATION_ID,
  type Storage,
  type Submission,
  UserEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  type BaseExtensionOptions,
  createBaseExtension,
  createCachedCompactionExtension,
  createCodingToolsExtension,
  createReadonlyToolsExtension,
  createShellPathsExtension,
  createTasksExtension,
  createToolSearchExtension,
  TaskManager,
} from "@eevee/agent";
import {
  ProjectBoardDoc,
  readBoard,
  readTickets,
  readWorker,
  readWorkers,
  type TicketRecord,
  WorkerDoc,
  type WorkerId,
  type WorkerRecord,
} from "./docs.ts";
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

export type OpenProjectDeps = {
  readonly cwd: string;
  readonly models: Models;
  readonly modelSlots?: ModelSlots;
  readonly settings?: HarnessSettings;
  readonly extensions?: readonly Extension[];
  readonly baseExtensionOptions?: BaseExtensionOptions;
  readonly maxActiveWorkers?: number;
  readonly taskManager?: TaskManager;
  readonly routerInstructions?: string;
  readonly workerInstructions?: string;
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

export type ProjectHandle = {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly tasks: TaskManager;
  readonly send: ProjectSend;
  workers(): Promise<WorkerRecord[]>;
  tickets(): Promise<TicketRecord[]>;
  close(): Promise<void>;
};

export async function openProject(storage: Storage, deps: OpenProjectDeps): Promise<ProjectHandle> {
  const projectRoot = resolve(deps.cwd);
  const registry = createRegistry();
  const ownsTaskManager = deps.taskManager === undefined;
  const taskManager = deps.taskManager ?? new TaskManager();
  const workerInstructions = deps.workerInstructions ?? DEFAULT_WORKER_INSTRUCTIONS;
  const extensions: Extension[] = [
    createBaseExtension(deps.baseExtensionOptions),
    createReadonlyToolsExtension(),
    createCodingToolsExtension(),
    createShellPathsExtension(),
    createTasksExtension({ manager: taskManager }),
    createToolSearchExtension(),
    createCachedCompactionExtension(),
    createRouterExtension({
      cwd: projectRoot,
      workerModel: deps.modelSlots?.worker ?? deps.modelSlots?.router,
      workerInstructions,
    }),
    createWorkerExtension(),
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
      models: deps.models,
      registry,
      settings,
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

  const routerAgent = buildRouterAgent({
    snapshot: registry.snapshot(),
    ...(deps.modelSlots?.router === undefined ? {} : { model: deps.modelSlots.router }),
    instructions: deps.routerInstructions ?? DEFAULT_ROUTER_INSTRUCTIONS,
    cwd: projectRoot,
  });
  const rootExisted =
    (await harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)) !== undefined;
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: routerAgent });
  if (rootExisted) await root.configure(routerAgent, BACKGROUND_CONTEXT);

  const pump = new ProjectPump(harness, {
    ...(deps.maxActiveWorkers === undefined ? {} : { maxActiveWorkers: deps.maxActiveWorkers }),
    ...(deps.onPumpError === undefined ? {} : { onError: deps.onPumpError }),
  });
  pump.request();
  harness.resume();

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
    send,
    workers: async () => {
      const board = await readBoard(harness, BACKGROUND_CONTEXT);
      const workers = await readWorkers(harness, BACKGROUND_CONTEXT, board);
      const pendingWorkerIds = board?.pendingStarts.map((start) => start.workerId) ?? [];
      return Promise.all(
        workers.map(async (worker) => ({
          ...worker,
          status: await resolveWorkerStatus(harness, worker, pendingWorkerIds, BACKGROUND_CONTEXT),
        })),
      );
    },
    tickets: async () => {
      const board = await readBoard(harness, BACKGROUND_CONTEXT);
      return readTickets(harness, BACKGROUND_CONTEXT, board);
    },
    close: () => {
      closePromise ??= (async () => {
        pump.close();
        await pump.idle();
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
      })();
      return closePromise;
    },
  };
}
