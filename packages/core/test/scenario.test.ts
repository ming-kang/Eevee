import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  contentText,
  createModels,
  type FauxProviderHandle,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type Conversation,
  type EntryRecord,
  type HarnessSettings,
  LiveDoc,
  type Storage,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { TaskRecordDoc, TasksBoardDoc } from "@eevee/agent";
import {
  deriveWorkerStatus,
  NOTICE_ENTRY_KIND,
  openProject,
  ProjectBoardDoc,
  type ProjectHandle,
  WorkerDoc,
  type WorkerId,
} from "../src/index.ts";

type ProjectFixture = {
  readonly dir: string;
  readonly faux: FauxProviderHandle;
  readonly storage: Storage;
  readonly project: ProjectHandle;
};

type FixtureOptions = {
  readonly maxActiveWorkers?: number;
  readonly settings?: HarnessSettings;
  readonly storage?: Storage;
};

const MODEL_ID = "faux-1";

async function openFixture(options: FixtureOptions = {}): Promise<ProjectFixture> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-scenario-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = options.storage ?? new MemoryStorage();
  const project = await openProject(storage, {
    cwd: dir,
    models,
    modelSlots: {
      router: { provider: faux.provider.id, modelId: MODEL_ID },
      worker: { provider: faux.provider.id, modelId: MODEL_ID },
    },
    baseExtensionOptions: { globalDir: join(dir, "no-global-context") },
    settings: options.settings,
    maxActiveWorkers: options.maxActiveWorkers,
  });
  return { dir, faux, storage, project };
}

async function closeFixture(fixture: ProjectFixture): Promise<void> {
  await fixture.project.close().catch(() => undefined);
  await rm(fixture.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function responses(brain: FauxResponseFactory, count = 30): FauxResponseFactory[] {
  return Array.from({ length: count }, () => brain);
}

function messageText(message: Message): string {
  if (message.role === "user") return contentText(message.content);
  if (message.role === "assistant") return contentText(message.content);
  if (message.role === "toolResult") return contentText(message.content);
  return "";
}

function contextText(context: TranscriptContext): string {
  return JSON.stringify(context.messages);
}

function entryText(entry: EntryRecord): string {
  const message = entry.model?.[0];
  if (message === undefined) return "";
  return messageText(message);
}

async function entries(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT);
  return [...page.items];
}

async function noticeEntries(conversation: Conversation): Promise<EntryRecord[]> {
  return (await entries(conversation)).filter((entry) => entry.kind === NOTICE_ENTRY_KIND);
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function lastMessage(context: TranscriptContext): Message | undefined {
  return context.messages.findLast((message) => message.role !== "system");
}

test("minimal end-to-end loop delegates to a Worker and receives its handoff", async () => {
  const fixture = await openFixture();
  try {
    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("delegate-scribe")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "scribe",
                prompt: "scribe-write-task: create result.txt",
                ticketTitle: "Write result",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("scribe-write-task")) {
          return fauxAssistantMessage(
            [fauxToolCall("write", { path: "result.txt", content: "hello from worker" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("Worker scribe") && text.includes("worker finished token")) {
          return fauxAssistantMessage("router final answer");
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("router delegated");
        if (last.toolName === "write") return fauxAssistantMessage("worker finished token");
      }
      throw new Error(`unexpected model context: ${contextText(context)}`);
    };
    fixture.faux.setResponses(responses(brain));

    const submission = await fixture.project.send("delegate-scribe");
    await submission.wait(BACKGROUND_CONTEXT);

    await waitFor(async () => {
      const rootEntries = await entries(fixture.project.root);
      return (
        (await noticeEntries(fixture.project.root)).length === 1 &&
        rootEntries.some((entry) => entryText(entry).includes("router final answer"))
      );
    }, "worker handoff and router answer");

    assert.equal(await readFile(join(fixture.dir, "result.txt"), "utf8"), "hello from worker");
    const workers = await fixture.project.workers();
    assert.equal(workers.length, 1);
    assert.equal(workers[0]?.status, "idle");
    assert.equal(workers[0]?.name, "scribe");
    const tickets = await fixture.project.tickets();
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0]?.status, "open");
    assert.equal(tickets[0]?.workerId, workers[0]?.id);
    const notices = await noticeEntries(fixture.project.root);
    assert.equal(notices.length, 1);
    const data = notices[0]?.data as { type?: string; workerId?: string; answerEntryId?: number };
    assert.equal(data.type, "handoff");
    assert.equal(data.workerId, workers[0]?.id);
    assert.equal(typeof data.answerEntryId, "number");
  } finally {
    await closeFixture(fixture);
  }
});

test("worker handoff truncates long answers and points inspect_worker at the worker", async () => {
  const fixture = await openFixture();
  try {
    const longAnswer = "x".repeat(4200);
    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("delegate-long-answer")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "verbose",
                prompt: "verbose-answer-task",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("verbose-answer-task")) return fauxAssistantMessage(longAnswer);
        if (text.includes("Worker verbose")) return fauxAssistantMessage("router saw truncation");
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("router delegated verbose worker");
      }
      throw new Error(`unexpected model context: ${contextText(context)}`);
    };
    fixture.faux.setResponses(responses(brain));

    const submission = await fixture.project.send("delegate-long-answer");
    await submission.wait(BACKGROUND_CONTEXT);
    await waitFor(
      async () => (await noticeEntries(fixture.project.root)).length === 1,
      "truncated worker handoff",
    );

    const notice = (await noticeEntries(fixture.project.root))[0];
    const text = notice === undefined ? "" : entryText(notice);
    assert.ok(text.includes("x".repeat(4000)));
    assert.equal(text.includes("x".repeat(4001)), false);
    assert.ok(text.includes("[Answer truncated to 4000 characters."));
    assert.ok(text.includes('inspect_worker({ workerId: "w1" })'));
  } finally {
    await closeFixture(fixture);
  }
});

test("worker handoff stays silent while background tasks are active", async () => {
  const fixture = await openFixture();
  try {
    let injectedRunningTask = false;
    const brain: FauxResponseFactory = async (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("delegate-background-worker")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "backgrounded",
                prompt: "background-worker-task",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("background-worker-task")) {
          return fauxAssistantMessage(
            [fauxToolCall("write", { path: "background.txt", content: "written" })],
            { stopReason: "toolUse" },
          );
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("router delegated");
        if (last.toolName === "write") {
          if (!injectedRunningTask) {
            injectedRunningTask = true;
            const worker = (await fixture.project.workers())[0];
            assert.ok(worker !== undefined);
            await fixture.project.harness.commit(async (tx) => {
              const board = await tx.doc(TasksBoardDoc, worker.conversationId);
              board.nextSeq = Math.max(board.nextSeq, 2);
              board.order.push("task-1");
              const record = await tx.doc(TaskRecordDoc, worker.conversationId, "task-1", null);
              record.id = "task-1";
              record.command = "sleep 60";
              record.status = "running";
              record.startedAt = 1;
            }, BACKGROUND_CONTEXT);
          }
          return fauxAssistantMessage("worker finished but background task remains");
        }
      }
      throw new Error(`unexpected model context: ${contextText(context)}`);
    };
    fixture.faux.setResponses(responses(brain));

    const submission = await fixture.project.send("delegate-background-worker");
    await submission.wait(BACKGROUND_CONTEXT);
    const worker = (await fixture.project.workers())[0];
    assert.ok(worker !== undefined);
    await waitFor(async () => {
      const live = await fixture.project.harness.snapshot(
        LiveDoc,
        worker.conversationId,
        BACKGROUND_CONTEXT,
      );
      return live?.run === undefined;
    }, "worker generation to end");

    assert.equal((await noticeEntries(fixture.project.root)).length, 0);
    assert.equal((await fixture.project.workers())[0]?.status, "running");
  } finally {
    await closeFixture(fixture);
  }
});

test("spawn_worker applies catalog model and thinking overrides to the Worker", async () => {
  const fixture = await openFixture({ maxActiveWorkers: 0 });
  try {
    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user" && messageText(last).includes("spawn-configured-worker")) {
        return fauxAssistantMessage(
          [
            fauxToolCall("spawn_worker", {
              name: "configured",
              prompt: "configured worker prompt",
              model: `${fixture.faux.provider.id}/${MODEL_ID}`,
              thinkingLevel: "high",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("router delegated configured worker");
      }
      throw new Error(`unexpected model context: ${contextText(context)}`);
    };
    fixture.faux.setResponses(responses(brain));

    const submission = await fixture.project.send("spawn-configured-worker");
    await submission.wait(BACKGROUND_CONTEXT);
    const worker = (await fixture.project.workers())[0];
    assert.ok(worker !== undefined);
    assert.deepEqual(worker.model, {
      provider: fixture.faux.provider.id,
      modelId: MODEL_ID,
      thinkingLevel: "high",
    });
    const agent = await fixture.project.harness.snapshot(
      AgentDoc,
      worker.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.deepEqual(agent?.model, { provider: fixture.faux.provider.id, modelId: MODEL_ID });
    assert.equal(agent?.thinkingLevel, "high");
  } finally {
    await closeFixture(fixture);
  }
});

test("spawn_worker rejects an unknown model without creating Worker records", async () => {
  const fixture = await openFixture();
  try {
    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user" && messageText(last).includes("spawn-invalid-model")) {
        return fauxAssistantMessage(
          [
            fauxToolCall("spawn_worker", {
              name: "invalid",
              prompt: "invalid model prompt",
              model: "missing/faux-1",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("router saw invalid model");
      }
      throw new Error(`unexpected model context: ${contextText(context)}`);
    };
    fixture.faux.setResponses(responses(brain));

    const submission = await fixture.project.send("spawn-invalid-model");
    await submission.wait(BACKGROUND_CONTEXT);
    assert.equal((await fixture.project.workers()).length, 0);
    assert.equal((await fixture.project.tickets()).length, 0);
    const resultEntry = (await entries(fixture.project.root)).find((entry) => {
      const message = entry.model?.[0];
      return message?.role === "toolResult" && message.toolName === "spawn_worker";
    });
    const result = resultEntry?.model?.[0];
    assert.equal(result?.role, "toolResult");
    if (result?.role === "toolResult") assert.equal(result.isError, true);
  } finally {
    await closeFixture(fixture);
  }
});

test("direct input to a queued Worker is appended passively without starting it", async () => {
  const fixture = await openFixture({ maxActiveWorkers: 0 });
  try {
    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user" && messageText(last).includes("spawn-passive-target")) {
        return fauxAssistantMessage(
          [
            fauxToolCall("spawn_worker", {
              name: "passive",
              prompt: "initial passive prompt",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("router delegated passive worker");
      }
      throw new Error(`unexpected model context: ${contextText(context)}`);
    };
    fixture.faux.setResponses(responses(brain));

    const submission = await fixture.project.send("spawn-passive-target");
    await submission.wait(BACKGROUND_CONTEXT);
    await waitFor(
      async () => (await fixture.project.workers())[0]?.status === "queued",
      "queued passive worker",
    );

    const guidance = await fixture.project.send("w1", "queued guidance");
    assert.equal((await guidance.wait(BACKGROUND_CONTEXT)).status, "done");
    const worker = (await fixture.project.workers())[0];
    assert.ok(worker !== undefined);
    assert.equal(worker.status, "queued");
    const conversation = await fixture.project.harness.conversation(
      worker.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.ok(conversation !== undefined);
    const workerEntries = await entries(conversation);
    assert.equal(workerEntries.filter((entry) => entry.kind === "pi.user").length, 2);
    assert.equal(
      workerEntries.some((entry) => entry.kind === "pi.assistant"),
      false,
    );
    assert.ok(workerEntries.some((entry) => entryText(entry) === "queued guidance"));
  } finally {
    await closeFixture(fixture);
  }
});

test("maxActiveWorkers 1 queues the second Worker and starts it after the first run", async () => {
  const fixture = await openFixture({
    maxActiveWorkers: 1,
    settings: { toolExecution: "sequential" },
  });
  try {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = false;
    let firstGateUsed = false;
    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      const serialized = contextText(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-two-workers")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "one",
                prompt: "worker-one-task",
                ticketTitle: "One",
              }),
              fauxToolCall("spawn_worker", {
                name: "two",
                prompt: "worker-two-task",
                ticketTitle: "Two",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("worker-one-task")) {
          firstStarted = true;
          if (!firstGateUsed) {
            firstGateUsed = true;
            return firstGate.then(() =>
              fauxAssistantMessage([fauxToolCall("write", { path: "one.txt", content: "one" })], {
                stopReason: "toolUse",
              }),
            );
          }
        }
        if (text.includes("worker-two-task")) {
          return fauxAssistantMessage(
            [fauxToolCall("write", { path: "two.txt", content: "two" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("Worker one") && text.includes("worker one done")) {
          return fauxAssistantMessage("router saw one");
        }
        if (text.includes("Worker two") && text.includes("worker two done")) {
          return fauxAssistantMessage("router saw two");
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("router delegated");
        if (last.toolName === "write" && serialized.includes("one.txt")) {
          return fauxAssistantMessage("worker one done");
        }
        if (last.toolName === "write" && serialized.includes("two.txt")) {
          return fauxAssistantMessage("worker two done");
        }
      }
      throw new Error(`unexpected model context: ${serialized}`);
    };
    fixture.faux.setResponses(responses(brain));

    const submission = await fixture.project.send("spawn-two-workers");
    await waitFor(() => firstStarted, "first worker model request");

    const before = await fixture.project.workers();
    assert.equal(before.length, 2);
    const first = before.find((worker) => worker.id === "w1");
    const second = before.find((worker) => worker.id === "w2");
    assert.equal(first?.status, "running");
    assert.equal(second?.status, "queued");
    assert.ok(second !== undefined);
    const secondConversation = await fixture.project.harness.conversation(
      second.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.ok(secondConversation !== undefined);
    const secondEntries = await entries(secondConversation);
    assert.equal(
      secondEntries.some((entry) => entry.kind === "pi.assistant"),
      false,
    );

    releaseFirst();
    await submission.wait(BACKGROUND_CONTEXT);
    await waitFor(
      async () => (await noticeEntries(fixture.project.root)).length === 2,
      "two handoffs",
    );
    await waitFor(async () => {
      const rootEntries = await entries(fixture.project.root);
      const texts = rootEntries.map((entry) => entryText(entry));
      return (
        texts.some((text) => text.includes("router saw one")) &&
        texts.some((text) => text.includes("router saw two"))
      );
    }, "router answers to both handoffs");

    assert.equal(await readFile(join(fixture.dir, "one.txt"), "utf8"), "one");
    assert.equal(await readFile(join(fixture.dir, "two.txt"), "utf8"), "two");
    const after = await fixture.project.workers();
    assert.deepEqual(
      after.map((worker) => [worker.id, worker.status]),
      [
        ["w1", "idle"],
        ["w2", "idle"],
      ],
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("worker status derivation covers queued, running, idle, and closed precedence", async () => {
  const worker = { id: "w9" as WorkerId, closedAt: undefined };
  assert.equal(
    deriveWorkerStatus({
      worker,
      pendingWorkerIds: ["w9"],
      hasActiveRun: false,
      hasRunningTasks: false,
    }),
    "queued",
  );
  assert.equal(
    deriveWorkerStatus({
      worker,
      pendingWorkerIds: [],
      hasActiveRun: true,
      hasRunningTasks: false,
    }),
    "running",
  );
  assert.equal(
    deriveWorkerStatus({
      worker,
      pendingWorkerIds: [],
      hasActiveRun: false,
      hasRunningTasks: true,
    }),
    "running",
  );
  assert.equal(
    deriveWorkerStatus({
      worker,
      pendingWorkerIds: [],
      hasActiveRun: false,
      hasRunningTasks: false,
    }),
    "idle",
  );
  assert.equal(
    deriveWorkerStatus({
      worker: { ...worker, closedAt: 1 },
      pendingWorkerIds: ["w9"],
      hasActiveRun: true,
      hasRunningTasks: true,
    }),
    "closed",
  );

  const fixture = await openFixture({ maxActiveWorkers: 0 });
  try {
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let workerStarted = false;
    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-status-worker")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "status",
                prompt: "status-worker-task",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("status-worker-task")) {
          workerStarted = true;
          return workerGate.then(() => fauxAssistantMessage("status worker done"));
        }
        if (text.includes("Worker status") && text.includes("status worker done")) {
          return fauxAssistantMessage("router acknowledged status worker");
        }
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("router delegated status worker");
      }
      throw new Error(`unexpected model context: ${contextText(context)}`);
    };
    fixture.faux.setResponses(responses(brain));

    const submission = await fixture.project.send("spawn-status-worker");
    await submission.wait(BACKGROUND_CONTEXT);
    let workers = await fixture.project.workers();
    assert.equal(workers[0]?.status, "queued");
    const workerId = workers[0]?.id;
    assert.ok(workerId !== undefined);

    await fixture.project.harness.commit(async (tx) => {
      const board = await tx.doc(ProjectBoardDoc);
      board.pendingStarts.splice(0, board.pendingStarts.length);
    }, BACKGROUND_CONTEXT);
    workers = await fixture.project.workers();
    assert.equal(workers[0]?.status, "idle");

    const workerState = workers[0];
    assert.ok(workerState !== undefined);
    const conversation = await fixture.project.harness.conversation(
      workerState.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.ok(conversation !== undefined);
    const continued = await conversation.submit(
      { type: "continue", requestId: "status-test-start" },
      BACKGROUND_CONTEXT,
    );
    await waitFor(() => workerStarted, "status worker model request");
    workers = await fixture.project.workers();
    assert.equal(workers[0]?.status, "running");

    releaseWorker();
    await continued.wait(BACKGROUND_CONTEXT);
    await waitFor(
      async () => (await noticeEntries(fixture.project.root)).length === 1,
      "status handoff",
    );
    workers = await fixture.project.workers();
    assert.equal(workers[0]?.status, "idle");

    await fixture.project.harness.commit(async (tx) => {
      const board = await tx.doc(TasksBoardDoc, workerState.conversationId);
      const taskId = `task-${board.nextSeq}`;
      board.nextSeq += 1;
      board.order.push(taskId);
      const record = await tx.doc(TaskRecordDoc, workerState.conversationId, taskId, null);
      record.id = taskId;
      record.command = "sleep 60";
      record.status = "running";
      record.startedAt = 1;
    }, BACKGROUND_CONTEXT);
    workers = await fixture.project.workers();
    assert.equal(workers[0]?.status, "running");

    await fixture.project.harness.commit(async (tx) => {
      const record = await tx.doc(TaskRecordDoc, workerState.conversationId, "task-1", null);
      record.status = "completed";
      record.exitCode = 0;
      record.endedAt = 2;
    }, BACKGROUND_CONTEXT);
    workers = await fixture.project.workers();
    assert.equal(workers[0]?.status, "idle");

    await fixture.project.harness.commit(async (tx) => {
      const board = await tx.doc(ProjectBoardDoc);
      board.pendingStarts.push({ workerId, requestId: "closed-precedence" });
      const doc = await tx.doc(WorkerDoc, workerId, null);
      doc.closedAt = 3;
    }, BACKGROUND_CONTEXT);
    workers = await fixture.project.workers();
    assert.equal(workers[0]?.status, "closed");
  } finally {
    await closeFixture(fixture);
  }
});

test("reopening shared storage resumes a Worker mid-run and hands off exactly once", async () => {
  const storage = new MemoryStorage();
  storage.close = () => Promise.resolve();
  const first = await openFixture({ storage });
  const dir = first.dir;
  try {
    let workerStarted = false;
    const firstBrain: FauxResponseFactory = (context, options) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-restart-worker")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "restarter",
                prompt: "restart-worker-task",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("restart-worker-task")) {
          workerStarted = true;
          return new Promise((_, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("host closed")), {
              once: true,
            });
          });
        }
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("router delegated restart worker");
      }
      throw new Error(`unexpected first model context: ${contextText(context)}`);
    };
    first.faux.setResponses(responses(firstBrain));
    const submission = await first.project.send("spawn-restart-worker");
    await submission.wait(BACKGROUND_CONTEXT);
    await waitFor(() => workerStarted, "worker model request before close");
    await first.project.close();

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const reopened = await openProject(storage, {
      cwd: dir,
      models,
      modelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      baseExtensionOptions: { globalDir: join(dir, "no-global-context") },
    });
    try {
      const restartedBrain: FauxResponseFactory = (context) => {
        const last = lastMessage(context);
        const serialized = contextText(context);
        if (last?.role === "user") {
          const text = messageText(last);
          if (text.includes("restart-worker-task")) {
            return fauxAssistantMessage(
              [fauxToolCall("write", { path: "restart.txt", content: "resumed" })],
              { stopReason: "toolUse" },
            );
          }
          if (text.includes("Worker restarter") && text.includes("restart worker done")) {
            return fauxAssistantMessage("router saw restarted worker");
          }
        }
        if (last?.role === "toolResult" && last.toolName === "write") {
          return fauxAssistantMessage("restart worker done");
        }
        throw new Error(`unexpected restarted model context: ${serialized}`);
      };
      faux.setResponses(responses(restartedBrain));

      await waitFor(async () => {
        const rootEntries = await entries(reopened.root);
        return rootEntries.some((entry) =>
          entryText(entry).includes("router saw restarted worker"),
        );
      }, "restarted worker handoff and router answer");
      assert.equal(await readFile(join(dir, "restart.txt"), "utf8"), "resumed");
      assert.equal((await noticeEntries(reopened.root)).length, 1);
      const workers = await reopened.workers();
      assert.equal(workers[0]?.status, "idle");
    } finally {
      await reopened.close().catch(() => undefined);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
