import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  contentText,
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type ConversationId,
  createRegistry,
  type DocumentReader,
  defineExtension,
  defineTask,
  Harness,
  LiveDoc,
  UserEntry,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import {
  AGENT_EXTENSIONS,
  BASE_EXTENSION,
  listConversationTasks,
  TaskRecordDoc,
  TasksBoardDoc,
} from "@eevee/agent";
import {
  buildWorkerMessageSubmission,
  findWorkerByConversationInTx,
  killWorkerTask,
  NOTICE_ENTRY_KIND,
  openProject,
  ProjectBoardDoc,
  type ProjectBoardState,
  ProjectError,
  ProjectPump,
  QuestionDoc,
  type QuestionDocState,
  type QuestionId,
  readQuestions,
  readTickets,
  readWorkers,
  reconfigureRoles,
  resolveWorkerTask,
  TicketDoc,
  type TicketDocState,
  type TicketId,
  type ToolPolicy,
  WorkerDoc,
  type WorkerDocState,
  type WorkerId,
} from "../src/index.ts";

const MODEL_ID = "faux-1";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("readWorkers, readTickets, and readQuestions read in parallel while preserving order and dropping missing docs", async () => {
  const board: ProjectBoardState = {
    nextWorkerSeq: 5,
    nextTicketSeq: 5,
    nextQuestionSeq: 5,
    workerOrder: ["w1", "w2", "w3", "w4"],
    ticketOrder: ["t1", "t2", "t3", "t4"],
    questionOrder: ["q1", "q2", "q3", "q4"],
    pendingStarts: [],
  };

  const w4Started = deferred();
  const t4Started = deferred();
  const q4Started = deferred();

  const workersMap = new Map<WorkerId, WorkerDocState>([
    [
      "w1",
      { id: "w1", name: "first", cwd: "/tmp", conversationId: 1 as ConversationId, createdAt: 1 },
    ],
    [
      "w3",
      { id: "w3", name: "third", cwd: "/tmp", conversationId: 1 as ConversationId, createdAt: 1 },
    ],
    [
      "w4",
      { id: "w4", name: "fourth", cwd: "/tmp", conversationId: 1 as ConversationId, createdAt: 1 },
    ],
  ]);
  const ticketsMap = new Map<TicketId, TicketDocState>([
    ["t1", { id: "t1", workerId: "w1", title: "first", status: "open", createdAt: 1 }],
    ["t2", { id: "t2", workerId: "w1", title: "second", status: "open", createdAt: 1 }],
    ["t4", { id: "t4", workerId: "w1", title: "fourth", status: "open", createdAt: 1 }],
  ]);
  const questionsMap = new Map<QuestionId, QuestionDocState>([
    ["q1", { id: "q1", items: [{ question: "one?" }], askedAt: 1 }],
    ["q3", { id: "q3", items: [{ question: "three?" }], askedAt: 1 }],
    ["q4", { id: "q4", items: [{ question: "four?" }], askedAt: 1 }],
  ]);

  const reader: DocumentReader = {
    snapshot: (async (...args: unknown[]) => {
      const token = args[0];
      if (token === ProjectBoardDoc) return board;
      if (token === WorkerDoc) {
        const id = args[1] as WorkerId;
        if (id === "w1") await w4Started.promise;
        if (id === "w4") w4Started.resolve();
        return workersMap.get(id);
      }
      if (token === TicketDoc) {
        const id = args[1] as TicketId;
        if (id === "t1") await t4Started.promise;
        if (id === "t4") t4Started.resolve();
        return ticketsMap.get(id);
      }
      if (token === QuestionDoc) {
        const id = args[1] as QuestionId;
        if (id === "q1") await q4Started.promise;
        if (id === "q4") q4Started.resolve();
        return questionsMap.get(id);
      }
      return undefined;
    }) as DocumentReader["snapshot"],
    snapshotAsOf: (async () => undefined) as DocumentReader["snapshotAsOf"],
  };

  const [workers, tickets, questions] = await Promise.all([
    readWorkers(reader, BACKGROUND_CONTEXT),
    readTickets(reader, BACKGROUND_CONTEXT, board),
    readQuestions(reader, BACKGROUND_CONTEXT),
  ]);

  assert.deepEqual(
    workers.map((worker) => worker.id),
    ["w1", "w3", "w4"],
  );
  assert.deepEqual(
    tickets.map((ticket) => ticket.id),
    ["t1", "t2", "t4"],
  );
  assert.deepEqual(
    questions.map((question) => question.id),
    ["q1", "q3", "q4"],
  );
});

test("ambiguous task ID prefix throws ProjectError('task_ambiguous') across worker task APIs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-ambiguous-task-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);

  faux.setResponses([
    () =>
      fauxAssistantMessage(
        [fauxToolCall("spawn_worker", { name: "tasker", prompt: "seed tasks" })],
        { stopReason: "toolUse" },
      ),
    () => fauxAssistantMessage("spawned"),
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall("inspect_worker", {
            workerId: "w1",
            include: "tasks",
            taskId: "1",
          }),
        ],
        { stopReason: "toolUse" },
      ),
    () => fauxAssistantMessage("inspected"),
  ]);

  const project = await openProject(new MemoryStorage(), {
    cwd: dir,
    models,
    modelSlots: {
      router: { provider: faux.provider.id, modelId: MODEL_ID },
      worker: { provider: faux.provider.id, modelId: MODEL_ID },
    },
    maxActiveWorkers: 0,
    baseExtensionOptions: { globalDir: join(dir, "no-global") },
  });

  try {
    const sub = await project.send("create worker");
    await sub.wait(BACKGROUND_CONTEXT);

    const workers = await project.workers();
    const w1 = workers[0];
    assert.ok(w1 !== undefined);

    await project.harness.commit(async (tx) => {
      const board = await tx.doc(TasksBoardDoc, w1.conversationId);
      board.nextSeq = 11;
      board.order.push("task-1", "task-2", "task-10");
      for (const id of ["task-1", "task-2", "task-10"] as const) {
        const record = await tx.doc(TaskRecordDoc, w1.conversationId, id, null);
        record.id = id;
        record.command = `echo ${id}`;
        record.status = "running";
        record.startedAt = 1;
      }
    }, BACKGROUND_CONTEXT);

    const resolvedExact = await project.resolveWorkerTask("w1", "task-1");
    assert.equal(resolvedExact.record.id, "task-1");

    const resolvedUniquePrefix = await resolveWorkerTask(project.harness as Harness, "w1", "2");
    assert.equal(resolvedUniquePrefix.record.id, "task-2");

    const isAmbiguousError = (error: unknown): boolean =>
      error instanceof ProjectError &&
      error.code === "task_ambiguous" &&
      error.message.includes("task-1") &&
      error.message.includes("task-10");

    await assert.rejects(project.resolveWorkerTask("w1", "1"), isAmbiguousError);
    await assert.rejects(resolveWorkerTask(project.harness, "w1", "1"), isAmbiguousError);
    await assert.rejects(project.readWorkerTaskOutput("w1", "1"), isAmbiguousError);
    await assert.rejects(
      project.subscribeWorkerTaskOutput("w1", "1", () => {}),
      isAmbiguousError,
    );
    await assert.rejects(project.killWorkerTask("w1", "1"), isAmbiguousError);

    await assert.rejects(
      project.readWorkerTaskOutput("w1", "missing"),
      (error: unknown) => error instanceof ProjectError && error.code === "task_not_found",
    );
    await assert.rejects(
      project.readWorkerTaskOutput("w99" as WorkerId, "1"),
      (error: unknown) => error instanceof ProjectError && error.code === "worker_not_found",
    );

    const inspectSub = await project.send("inspect ambiguous task");
    await inspectSub.wait(BACKGROUND_CONTEXT);
    const page = await project.root.entries(
      { order: "ascending" },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const toolResult = page.items
      .map((entry) => entry.model?.[0])
      .find((msg) => msg?.role === "toolResult" && msg.toolName === "inspect_worker");
    assert.equal(toolResult?.role, "toolResult");
    if (toolResult?.role === "toolResult") {
      assert.equal(toolResult.isError, true);
      const text = contentText(toolResult.content);
      assert.ok(text.includes('Ambiguous task id "1"'));
      assert.ok(text.includes("task-1"));
      assert.ok(text.includes("task-10"));
    }
  } finally {
    await project.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("buildWorkerMessageSubmission and findWorkerByConversationInTx unify submission drafting and tx worker lookup", async () => {
  const queued = buildWorkerMessageSubmission({
    queued: true,
    text: "queued note",
    requestId: "req-q",
    timestamp: 1234,
  });
  assert.deepEqual(queued, {
    requestId: "req-q",
    type: "write",
    entry: {
      kind: UserEntry.kind,
      model: [{ role: "user", content: "queued note", timestamp: 1234 }],
    },
  });

  const active = buildWorkerMessageSubmission({
    queued: false,
    text: "steer note",
    whenBusy: "steer",
    onAbort: "keep",
    requestId: "req-a",
  });
  assert.deepEqual(active, {
    requestId: "req-a",
    type: "input",
    content: "steer note",
    whenBusy: "steer",
    onAbort: "keep",
  });

  const defaultActive = buildWorkerMessageSubmission({ queued: false, text: "default note" });
  assert.deepEqual(defaultActive, {
    type: "input",
    content: "default note",
    whenBusy: "followUp",
  });

  const dir = await mkdtemp(join(tmpdir(), "eevee-core-tx-lookup-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    () =>
      fauxAssistantMessage([fauxToolCall("spawn_worker", { name: "lookup", prompt: "hi" })], {
        stopReason: "toolUse",
      }),
    () => fauxAssistantMessage("spawned"),
  ]);

  const project = await openProject(new MemoryStorage(), {
    cwd: dir,
    models,
    modelSlots: {
      router: { provider: faux.provider.id, modelId: MODEL_ID },
      worker: { provider: faux.provider.id, modelId: MODEL_ID },
    },
    maxActiveWorkers: 0,
    baseExtensionOptions: { globalDir: join(dir, "no-global") },
  });

  try {
    await (await project.send("spawn")).wait(BACKGROUND_CONTEXT);
    const workers = await project.workers();
    const w1 = workers[0];
    assert.ok(w1 !== undefined);

    const [found, missing] = await project.harness.commit(
      async (tx) => [
        await findWorkerByConversationInTx(tx, w1.conversationId),
        await findWorkerByConversationInTx(tx, 999 as ConversationId),
      ],
      BACKGROUND_CONTEXT,
    );
    assert.equal(found?.id, "w1");
    assert.equal(found?.conversationId, w1.conversationId);
    assert.equal(missing, undefined);
  } finally {
    await project.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("killWorkerTask handles active live tasks, non-live durable tasks, non-durable records, and terminal tasks via killConversationTask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-kill-paths-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const nonLiveSleepTask = defineTask<{ readonly taskId: string }, { phase: "wait" }, null>({
    name: "test.non-live-sleep",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (_task, runtime, context) => {
        await runtime.sleepUntil(runtime.now() + 60_000, { phase: "wait" }, context);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(TaskRecordDoc, runtime.conversationId, task.input.taskId, null);
        doc.status = "cancelled";
        doc.cancelReason = "user";
        doc.endedAt = runtime.now();
        return { status: "terminal", outcome: { status: "aborted" } } as const;
      }, context);
    },
  });

  const longCmd = "sleep 60";
  const killBrain: FauxResponseFactory = (context) => {
    const last = context.messages.findLast((message) => message.role !== "system");
    if (last?.role === "user") {
      const text = contentText(last.content);
      if (text.includes("spawn")) {
        return fauxAssistantMessage(
          [fauxToolCall("spawn_worker", { name: "killer", prompt: "start-bg" })],
          { stopReason: "toolUse" },
        );
      }
      if (text.includes("start-bg")) {
        return fauxAssistantMessage(
          [fauxToolCall("bash", { command: longCmd, background: true })],
          {
            stopReason: "toolUse",
          },
        );
      }
      if (text.includes("cancelled by the user")) {
        return fauxAssistantMessage("noted user cancel");
      }
      if (text.includes("noted user cancel")) {
        return fauxAssistantMessage("router noted");
      }
    }
    if (last?.role === "toolResult") {
      if (last.toolName === "spawn_worker") return fauxAssistantMessage("spawned killer");
      if (last.toolName === "bash") return fauxAssistantMessage("started bg");
    }
    throw new Error(`unexpected killWorkerTask context: ${JSON.stringify(context.messages)}`);
  };
  faux.setResponses(Array.from({ length: 12 }, () => killBrain));

  const project = await openProject(new MemoryStorage(), {
    cwd: dir,
    models,
    modelSlots: {
      router: { provider: faux.provider.id, modelId: MODEL_ID },
      worker: { provider: faux.provider.id, modelId: MODEL_ID },
    },
    extensions: [defineExtension({ name: "test.non-live-sleep-ext", tasks: [nonLiveSleepTask] })],
    baseExtensionOptions: { globalDir: join(dir, "no-global") },
  });

  try {
    await (await project.send("spawn")).wait(BACKGROUND_CONTEXT);
    const w1 = (await project.workers())[0];
    assert.ok(w1 !== undefined);

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const tasks = await listConversationTasks(
        project.harness,
        w1.conversationId,
        BACKGROUND_CONTEXT,
      );
      const live = await project.harness.snapshot(LiveDoc, w1.conversationId, BACKGROUND_CONTEXT);
      if (tasks[0]?.status === "running" && live?.run === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const killedLive = await project.killWorkerTask("w1", "task-1");
    assert.equal(killedLive.id, "task-1");
    assert.equal(killedLive.status, "cancelled");
    assert.equal(killedLive.cancelReason, "user");
    await project.root.waitForIdle(BACKGROUND_CONTEXT);

    await assert.rejects(
      project.killWorkerTask("w1", "task-1"),
      (error: unknown) => error instanceof ProjectError && error.code === "task_not_running",
    );

    const durableTaskId = await project.harness.commit(async (tx) => {
      const id = await tx.createTask(
        nonLiveSleepTask,
        { taskId: "task-2" },
        {
          ownership: { kind: "conversation" },
          conversationId: w1.conversationId,
          background: true,
        },
      );
      const board = await tx.doc(TasksBoardDoc, w1.conversationId);
      board.nextSeq = 4;
      board.order.push("task-2", "task-3");

      const durableRec = await tx.doc(TaskRecordDoc, w1.conversationId, "task-2", null);
      durableRec.id = "task-2";
      durableRec.durableTaskId = id;
      durableRec.command = "sleep durable";
      durableRec.status = "running";
      durableRec.startedAt = 1;

      const orphanedRec = await tx.doc(TaskRecordDoc, w1.conversationId, "task-3", null);
      orphanedRec.id = "task-3";
      orphanedRec.command = "sleep non-durable";
      orphanedRec.status = "running";
      orphanedRec.startedAt = 1;
      return id;
    }, BACKGROUND_CONTEXT);

    const killedDurable = await killWorkerTask(project.harness, project.tasks, "w1", "task-2");
    assert.equal(killedDurable.status, "cancelled");
    assert.equal(killedDurable.cancelReason, "user");
    const settled = await project.harness.waitForTask(durableTaskId, BACKGROUND_CONTEXT);
    assert.equal(settled.state.outcome.status, "aborted");

    const killedNonDurable = await killWorkerTask(project.harness, project.tasks, "w1", "task-3");
    assert.equal(killedNonDurable.status, "cancelled");
    assert.equal(killedNonDurable.cancelReason, "user");
    assert.ok(killedNonDurable.endedAt !== undefined);
  } finally {
    await project.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("reconfigureRoles and ProjectPump handle multiple open and closed workers concurrently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-multi-workers-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const w1Gate = deferred();
  const w2Gate = deferred();
  const w1Started = deferred();
  const w2Started = deferred();

  const lastUserOrTool = (context: TranscriptContext): Message | undefined =>
    context.messages.findLast((message) => message.role !== "system");

  const textOf = (message: Message): string =>
    message.role === "user" || message.role === "assistant" || message.role === "toolResult"
      ? contentText(message.content)
      : "";

  const brain: FauxResponseFactory = (context) => {
    const last = lastUserOrTool(context);
    if (last?.role === "user") {
      const text = textOf(last);
      if (text.includes("spawn-four")) {
        return fauxAssistantMessage(
          [
            fauxToolCall("spawn_worker", { name: "one", prompt: "run-w1" }),
            fauxToolCall("spawn_worker", { name: "two", prompt: "run-w2" }),
            fauxToolCall("spawn_worker", { name: "three", prompt: "run-w3" }),
            fauxToolCall("spawn_worker", { name: "four", prompt: "run-w4" }),
          ],
          { stopReason: "toolUse" },
        );
      }
      if (text.includes("run-w1")) {
        w1Started.resolve();
        return w1Gate.promise.then(() =>
          fauxAssistantMessage("", { stopReason: "error", errorMessage: "w1-boom" }),
        );
      }
      if (text.includes("run-w2")) {
        w2Started.resolve();
        return w2Gate.promise.then(() => fauxAssistantMessage("w2-done"));
      }
      if (text.includes("run-w3")) {
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "w3-boom" });
      }
      if (text.includes("run failed")) {
        return fauxAssistantMessage("router handled worker failure");
      }
      if (text.includes("w2-done")) {
        return fauxAssistantMessage("router handled w2 handoff");
      }
    }
    if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
      return fauxAssistantMessage("spawned four");
    }
    return fauxAssistantMessage("ack");
  };
  faux.setResponses(Array.from({ length: 30 }, () => brain));

  let policy: ToolPolicy | undefined;
  const project = await openProject(new MemoryStorage(), {
    cwd: dir,
    models,
    modelSlots: {
      router: { provider: faux.provider.id, modelId: MODEL_ID },
      worker: { provider: faux.provider.id, modelId: MODEL_ID },
    },
    maxActiveWorkers: 2,
    settings: { toolExecution: "sequential", retry: { enabled: false } },
    toolPolicy: () => policy,
    baseExtensionOptions: { globalDir: join(dir, "no-global") },
  });

  try {
    await (await project.send("spawn-four")).wait(BACKGROUND_CONTEXT);
    await Promise.all([w1Started.promise, w2Started.promise]);

    const initialWorkers = await project.workers();
    assert.deepEqual(
      initialWorkers.map((worker) => [worker.id, worker.status]),
      [
        ["w1", "running"],
        ["w2", "running"],
        ["w3", "queued"],
        ["w4", "queued"],
      ],
    );

    await project.harness.commit(async (tx) => {
      const board = await tx.doc(ProjectBoardDoc);
      const kept = board.pendingStarts.filter((start) => start.workerId !== "w4");
      board.pendingStarts.splice(0, board.pendingStarts.length, ...kept);
      const w4 = await tx.doc(WorkerDoc, "w4", null);
      w4.closedAt = Date.now();
    }, BACKGROUND_CONTEXT);

    policy = { router: { ls: false }, worker: { bash: false, grep: true } };
    await project.reconfigureTools();

    const rootAgent = await project.root.agent(BACKGROUND_CONTEXT);
    assert.equal(
      rootAgent.tools.some((tool) => tool.name === "ls"),
      false,
    );
    for (const workerId of ["w1", "w2", "w3"] as const) {
      const worker = initialWorkers.find((item) => item.id === workerId);
      assert.ok(worker !== undefined);
      const conv = await project.harness.conversation(worker.conversationId, BACKGROUND_CONTEXT);
      assert.ok(conv !== undefined);
      const agent = await conv.agent(BACKGROUND_CONTEXT);
      assert.equal(
        agent.tools.some((tool) => tool.name === "bash"),
        false,
      );
      assert.equal(
        agent.tools.some((tool) => tool.name === "grep"),
        true,
      );
    }
    const w4 = initialWorkers.find((item) => item.id === "w4");
    assert.ok(w4 !== undefined);
    const w4Conv = await project.harness.conversation(w4.conversationId, BACKGROUND_CONTEXT);
    assert.ok(w4Conv !== undefined);
    const w4Agent = await w4Conv.agent(BACKGROUND_CONTEXT);
    assert.equal(
      w4Agent.tools.some((tool) => tool.name === "bash"),
      true,
      "closed worker must not be reconfigured",
    );

    w1Gate.resolve();
    w2Gate.resolve();

    const deadline = Date.now() + 15_000;
    for (;;) {
      const page = await project.root.entries(
        { order: "ascending" },
        200,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const failedNotices = page.items.filter(
        (entry) =>
          entry.kind === NOTICE_ENTRY_KIND &&
          (entry.data as { type?: string } | undefined)?.type === "worker_failed",
      );
      if (failedNotices.length === 2) break;
      assert.ok(Date.now() < deadline, "timed out waiting for w1 and w3 failure notices");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const pump = new ProjectPump(project.harness, {
      maxActiveWorkers: 2,
      context: BACKGROUND_CONTEXT,
    });
    try {
      await pump.reportRunFailures();
    } finally {
      pump.close();
      await pump.idle();
    }

    const finalPage = await project.root.entries(
      { order: "ascending" },
      200,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const failedNotices = finalPage.items.filter(
      (entry) =>
        entry.kind === NOTICE_ENTRY_KIND &&
        (entry.data as { type?: string } | undefined)?.type === "worker_failed",
    );
    assert.deepEqual(
      failedNotices.map((entry) => (entry.data as { workerId?: string }).workerId),
      ["w1", "w3"],
    );
  } finally {
    await project.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("reconfigureRoles and ProjectPump.reportRunFailures operate concurrently across open workers", async () => {
  const registry = createRegistry();
  registry.install(defineExtension({ name: BASE_EXTENSION }));
  registry.install(defineExtension({ name: AGENT_EXTENSIONS.codingTools }));
  registry.install(defineExtension({ name: "eevee.worker" }));
  registry.install(defineExtension({ name: "eevee.router" }));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  faux.setResponses([() => fauxAssistantMessage("ack-1"), () => fauxAssistantMessage("ack-2")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  harness.resume();

  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: faux.provider.id, modelId: MODEL_ID } },
    });
    const c1 = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    const c2 = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    const c3 = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    const c4 = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );

    await harness.commit(async (tx) => {
      const board = await tx.doc(ProjectBoardDoc);
      board.nextWorkerSeq = 5;
      board.workerOrder.push("w1", "w2", "w3", "w4");
      const entries = [
        { id: "w1" as WorkerId, conv: c1.id, closed: false },
        { id: "w2" as WorkerId, conv: c2.id, closed: false },
        { id: "w3" as WorkerId, conv: c3.id, closed: true },
        { id: "w4" as WorkerId, conv: c4.id, closed: false },
      ];
      for (const item of entries) {
        const doc = await tx.doc(WorkerDoc, item.id, null);
        doc.id = item.id;
        doc.name = item.id;
        doc.cwd = "/tmp";
        doc.conversationId = item.conv;
        doc.createdAt = 1;
        if (item.closed) doc.closedAt = 2;
      }
    }, BACKGROUND_CONTEXT);

    const w4Started = deferred();
    const w4SnapshotReady = deferred();

    const concurrentHarness = new Proxy(harness, {
      get(target, prop) {
        if (prop === "snapshot") {
          return async (...args: unknown[]) => {
            if (args[0] === LiveDoc) {
              const convId = args[1] as ConversationId;
              if (convId === c1.id) await w4SnapshotReady.promise;
              if (convId === c4.id) w4SnapshotReady.resolve();
              return {
                runFailure:
                  convId === c2.id
                    ? { taskId: 2, inputs: [], reason: "aborted" }
                    : {
                        taskId: convId * 10,
                        inputs: [],
                        reason: "model_error",
                        detail: `err-${convId}`,
                      },
              };
            }
            return target.snapshot(...(args as Parameters<Harness["snapshot"]>));
          };
        }
        if (prop === "conversation") {
          return async (id: ConversationId, context: Parameters<Harness["conversation"]>[1]) => {
            if (id === c1.id) await w4Started.promise;
            if (id === c4.id) w4Started.resolve();
            return target.conversation(id, context);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const snapshot = registry.snapshot();
    await reconfigureRoles(
      concurrentHarness,
      root,
      snapshot,
      { worker: { bash: false } },
      BACKGROUND_CONTEXT,
    );
    const c1Agent = await harness.snapshot(AgentDoc, c1.id, BACKGROUND_CONTEXT);
    const c3Agent = await harness.snapshot(AgentDoc, c3.id, BACKGROUND_CONTEXT);
    const c4Agent = await harness.snapshot(AgentDoc, c4.id, BACKGROUND_CONTEXT);
    assert.deepEqual(c1Agent?.extensions, [
      BASE_EXTENSION,
      AGENT_EXTENSIONS.codingTools,
      "eevee.worker",
    ]);
    assert.deepEqual(c4Agent?.extensions, [
      BASE_EXTENSION,
      AGENT_EXTENSIONS.codingTools,
      "eevee.worker",
    ]);
    assert.equal(c3Agent?.extensions, undefined, "closed worker must not be configured");
    assert.equal(c3Agent?.tools, undefined, "closed worker must not be configured");

    const pump = new ProjectPump(concurrentHarness, { context: BACKGROUND_CONTEXT });
    try {
      await pump.reportRunFailures();
    } finally {
      pump.close();
      await pump.idle();
    }
    await root.waitForIdle(BACKGROUND_CONTEXT);

    const [w1Doc, w2Doc, w3Doc, w4Doc] = await Promise.all(
      (["w1", "w2", "w3", "w4"] as const).map((id) =>
        harness.snapshot(WorkerDoc, id, BACKGROUND_CONTEXT),
      ),
    );
    assert.equal(w1Doc?.reportedFailure, c1.id * 10);
    assert.equal(w2Doc?.reportedFailure, undefined);
    assert.equal(w3Doc?.reportedFailure, undefined);
    assert.equal(w4Doc?.reportedFailure, c4.id * 10);

    const page = await root.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
    const failed = page.items.filter((entry) => entry.kind === NOTICE_ENTRY_KIND);
    assert.deepEqual(
      failed.map((entry) => (entry.data as { workerId?: string }).workerId),
      ["w1", "w4"],
    );
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
