import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  contentText,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ConversationId, DocumentReader, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { TaskRecordDoc, TasksBoardDoc } from "@eevee/agent";
import {
  openProject,
  ProjectBoardDoc,
  type ProjectBoardState,
  ProjectError,
  QuestionDoc,
  type QuestionDocState,
  type QuestionId,
  readQuestions,
  readTickets,
  readWorkers,
  resolveWorkerTask,
  TicketDoc,
  type TicketDocState,
  type TicketId,
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
