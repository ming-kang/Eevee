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
  type Conversation,
  type EntryRecord,
  type HarnessSettings,
  LiveDoc,
  type Storage,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { listConversationTasks } from "@eevee/agent";
import { NOTICE_ENTRY_KIND, openProject, type ProjectHandle } from "../src/index.ts";

type Fixture = {
  readonly dir: string;
  readonly faux: FauxProviderHandle;
  readonly storage: Storage;
  readonly project: ProjectHandle;
};

const MODEL_ID = "faux-1";

async function openFixture(
  options: {
    readonly maxActiveWorkers?: number;
    readonly settings?: HarnessSettings;
    readonly storage?: Storage;
  } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-3b-"));
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

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.project.close().catch(() => undefined);
  await rm(fixture.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function responses(brain: FauxResponseFactory, count = 40): FauxResponseFactory[] {
  return Array.from({ length: count }, () => brain);
}

function messageText(message: Message): string {
  if (message.role === "user") return contentText(message.content);
  if (message.role === "assistant") return contentText(message.content);
  if (message.role === "toolResult") return contentText(message.content);
  return "";
}

function entryText(entry: EntryRecord): string {
  const message = entry.model?.[0];
  return message === undefined ? "" : messageText(message);
}

async function entries(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries(
    { order: "ascending" },
    500,
    undefined,
    BACKGROUND_CONTEXT,
  );
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

test("extended bidirectional scenario: message_router, message_worker, reuse with newTicket, and close_ticket(closeWorker)", async () => {
  const fixture = await openFixture();
  try {
    const brain: FauxResponseFactory = (context) => {
      const last = context.messages.at(-1);
      const serialized = JSON.stringify(context.messages);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("start-paper-project")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "analyst",
                prompt: "worker-task-1: need wavelength parameter",
                ticketTitle: "Draft section 1",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("worker-task-1: need wavelength")) {
          return fauxAssistantMessage(
            [fauxToolCall("message_router", { message: "Need target wavelength in nm." })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("Need target wavelength in nm.")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("message_worker", {
                workerId: "w1",
                message: "wavelength-answer: 1550nm",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("wavelength-answer: 1550nm")) {
          return fauxAssistantMessage(
            [fauxToolCall("write", { path: "sec1.txt", content: "1550nm" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("section 1 complete")) {
          return fauxAssistantMessage(
            [fauxToolCall("close_ticket", { ticketId: "t1", status: "done", note: "verified" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("followup-without-ticket")) {
          return fauxAssistantMessage("ack without open ticket");
        }
        if (text.includes("ack without open ticket")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("message_worker", {
                workerId: "w1",
                message: "worker-task-2: write sec2",
                newTicket: { title: "Draft section 2" },
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("worker-task-2: write sec2")) {
          return fauxAssistantMessage(
            [fauxToolCall("write", { path: "sec2.txt", content: "section 2" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("section 2 complete")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("close_ticket", {
                ticketId: "t2",
                status: "done",
                note: "all done",
                closeWorker: true,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("spawned analyst");
        if (last.toolName === "message_router")
          return fauxAssistantMessage("waiting for wavelength");
        if (last.toolName === "message_worker") return fauxAssistantMessage("sent to analyst");
        if (last.toolName === "write" && serialized.includes("sec2.txt")) {
          return fauxAssistantMessage("section 2 complete");
        }
        if (last.toolName === "write" && serialized.includes("sec1.txt")) {
          return fauxAssistantMessage("section 1 complete");
        }
        if (last.toolName === "close_ticket" && serialized.includes("all done")) {
          return fauxAssistantMessage("project wrapped up");
        }
        if (last.toolName === "close_ticket") {
          return fauxAssistantMessage(
            [
              fauxToolCall("message_worker", {
                workerId: "w1",
                message: "followup-without-ticket",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
      }
      throw new Error(`unexpected context: ${serialized}`);
    };
    fixture.faux.setResponses(responses(brain));

    const sub = await fixture.project.send("start-paper-project");
    await sub.wait(BACKGROUND_CONTEXT);

    await waitFor(async () => {
      const rootEntries = await entries(fixture.project.root);
      return rootEntries.some((entry) => entryText(entry).includes("project wrapped up"));
    }, "full bidirectional scenario completion");

    assert.equal(await readFile(join(fixture.dir, "sec1.txt"), "utf8"), "1550nm");
    assert.equal(await readFile(join(fixture.dir, "sec2.txt"), "utf8"), "section 2");

    const workers = await fixture.project.workers();
    assert.equal(workers.length, 1);
    assert.equal(workers[0]?.id, "w1");
    assert.equal(workers[0]?.status, "closed");
    assert.equal(workers[0]?.activeTicketId, undefined);

    const tickets = await fixture.project.tickets();
    assert.equal(tickets.length, 2);
    assert.equal(tickets[0]?.id, "t1");
    assert.equal(tickets[0]?.status, "done");
    assert.equal(tickets[0]?.note, "verified");
    assert.equal(tickets[1]?.id, "t2");
    assert.equal(tickets[1]?.status, "done");
    assert.equal(tickets[1]?.note, "all done");

    // In round 1, Worker's last tool call was message_router -> NO duplicate handoff for "waiting for wavelength".
    const notices = await noticeEntries(fixture.project.root);
    assert.equal(
      notices.some((entry) => entryText(entry).includes("waiting for wavelength")),
      false,
      "last-round message_router must suppress automatic handoff",
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("handoff dedupes only when message_router is in the last tool round, not an earlier round", async () => {
  const fixture = await openFixture();
  try {
    const brain: FauxResponseFactory = (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-progress-worker")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "reporter",
                prompt: "progress-then-work-task",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("progress-then-work-task")) {
          return fauxAssistantMessage(
            [fauxToolCall("message_router", { message: "halfway progress update" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("halfway progress update")) {
          return fauxAssistantMessage("router noted progress");
        }
        if (text.includes("final conclusion after later tool")) {
          return fauxAssistantMessage("router noted final handoff");
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("delegated reporter");
        if (last.toolName === "message_router") {
          return fauxAssistantMessage(
            [fauxToolCall("write", { path: "done.txt", content: "finished" })],
            { stopReason: "toolUse" },
          );
        }
        if (last.toolName === "write") {
          return fauxAssistantMessage("final conclusion after later tool");
        }
      }
      throw new Error(`unexpected context: ${JSON.stringify(context.messages)}`);
    };
    fixture.faux.setResponses(responses(brain));

    const sub = await fixture.project.send("spawn-progress-worker");
    await sub.wait(BACKGROUND_CONTEXT);

    await waitFor(async () => {
      const notices = await noticeEntries(fixture.project.root);
      return notices.length === 2;
    }, "both progress worker_message and final handoff notices");

    const notices = await noticeEntries(fixture.project.root);
    const types = notices.map((n) => (n.data as { type?: string }).type);
    assert.deepEqual(types, ["worker_message", "handoff"]);
    assert.ok(entryText(notices[0] as EntryRecord).includes("halfway progress update"));
    assert.ok(entryText(notices[1] as EntryRecord).includes("final conclusion after later tool"));
  } finally {
    await closeFixture(fixture);
  }
});

test("Worker waiting on background bash stays running without occupying run slot and hands off after completion", async () => {
  const fixture = await openFixture({
    maxActiveWorkers: 1,
    settings: { toolExecution: "sequential" },
  });
  try {
    const bgCmd = "node -e \"setTimeout(() => console.log('sim-result-ok'), 250)\"";
    let worker2RanWhileWorker1BgActive = false;

    const brain: FauxResponseFactory = async (context) => {
      const last = context.messages.at(-1);
      const serialized = JSON.stringify(context.messages);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("launch-bg-and-peer")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", { name: "sim", prompt: "run-sim-bg" }),
              fauxToolCall("spawn_worker", { name: "peer", prompt: "run-peer-fast" }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("run-sim-bg")) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: bgCmd, background: true })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("run-peer-fast")) {
          const workers = await fixture.project.workers();
          const sim = workers.find((w) => w.id === "w1");
          if (sim?.status === "running") {
            const live = await fixture.project.harness.snapshot(
              LiveDoc,
              sim.conversationId,
              BACKGROUND_CONTEXT,
            );
            if (live?.run === undefined) worker2RanWhileWorker1BgActive = true;
          }
          return fauxAssistantMessage("peer finished quickly");
        }
        if (text.includes("sim-result-ok")) {
          return fauxAssistantMessage("sim finished after background task");
        }
        if (
          text.includes("peer finished quickly") ||
          text.includes("sim finished after background task")
        ) {
          return fauxAssistantMessage("router acknowledged");
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("delegated sim and peer");
        if (last.toolName === "bash") return fauxAssistantMessage("background sim started");
      }
      throw new Error(`unexpected context: ${serialized}`);
    };
    fixture.faux.setResponses(responses(brain));

    const sub = await fixture.project.send("launch-bg-and-peer");
    await sub.wait(BACKGROUND_CONTEXT);

    await waitFor(
      async () => (await noticeEntries(fixture.project.root)).length === 2,
      "both peer and sim handoffs",
    );

    assert.equal(
      worker2RanWhileWorker1BgActive,
      true,
      "w2 must start while w1 is running only a background task (slot free)",
    );
    const notices = await noticeEntries(fixture.project.root);
    assert.equal(
      notices.some((n) => entryText(n).includes("background sim started")),
      false,
      "w1 must not hand off while background task is still running",
    );
    assert.ok(notices.some((n) => entryText(n).includes("sim finished after background task")));
  } finally {
    await closeFixture(fixture);
  }
});

test("model error reports worker_failed once across restarts while interrupt stays silent", async () => {
  const storage = new MemoryStorage();
  storage.close = () => Promise.resolve();
  const fixture = await openFixture({
    storage,
    settings: { retry: { enabled: false } },
  });
  const dir = fixture.dir;

  try {
    const brain: FauxResponseFactory = (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-failing-worker")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "crasher", prompt: "trigger-model-error" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("trigger-model-error")) {
          return fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "provider exploded",
          });
        }
        if (text.includes("run failed") && text.includes("provider exploded")) {
          return fauxAssistantMessage("router handled failure");
        }
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("delegated crasher");
      }
      throw new Error(`unexpected context: ${JSON.stringify(context.messages)}`);
    };
    fixture.faux.setResponses(responses(brain));

    const sub = await fixture.project.send("spawn-failing-worker");
    await sub.wait(BACKGROUND_CONTEXT);

    await waitFor(async () => {
      const notices = await noticeEntries(fixture.project.root);
      return notices.length === 1;
    }, "worker_failed notice");

    const notice = (await noticeEntries(fixture.project.root))[0];
    assert.ok(notice);
    assert.equal((notice.data as { type?: string }).type, "worker_failed");
    assert.ok(entryText(notice).includes("provider exploded"));
    await fixture.project.root.waitForIdle(BACKGROUND_CONTEXT);
    await fixture.project.close();

    // Reopen on the same storage: pump runs again and MUST NOT duplicate the failure notice.
    const faux2 = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models2 = createModels();
    models2.setProvider(faux2.provider);
    faux2.setResponses(responses(() => fauxAssistantMessage("unexpected router wake")));
    const reopened = await openProject(storage, {
      cwd: dir,
      models: models2,
      modelSlots: {
        router: { provider: faux2.provider.id, modelId: MODEL_ID },
        worker: { provider: faux2.provider.id, modelId: MODEL_ID },
      },
      baseExtensionOptions: { globalDir: join(dir, "no-global-context") },
      settings: { retry: { enabled: false } },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal((await noticeEntries(reopened.root)).length, 1);
      assert.equal(faux2.state.callCount, 0);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("aborting Router preserves queued Worker notices (onAbort keep) for the next run", async () => {
  const fixture = await openFixture();
  try {
    let routerPaused = false;
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let nextRouterContext: TranscriptContext | undefined;

    const brain: FauxResponseFactory = (context, options) => {
      const last = context.messages.at(-1);
      const serialized = JSON.stringify(context.messages);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-keep-worker")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "keeper", prompt: "keeper-task" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("keeper-task")) {
          return workerGate.then(() => fauxAssistantMessage("important kept handoff payload"));
        }
        if (text.includes("pause-router-now")) {
          routerPaused = true;
          return new Promise((_, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        }
        if (text.includes("after-abort-prompt")) {
          nextRouterContext = context;
          return fauxAssistantMessage("router saw kept handoff and prompt");
        }
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("spawned keeper");
      }
      throw new Error(`unexpected context: ${serialized}`);
    };
    fixture.faux.setResponses(responses(brain));

    const first = await fixture.project.send("spawn-keep-worker");
    await first.wait(BACKGROUND_CONTEXT);

    // Start a Router run that hangs so the Worker's handoff queues in Router's inbox.
    void fixture.project.send("pause-router-now");
    await waitFor(() => routerPaused, "router paused mid-run");

    releaseWorker();
    const workers = await fixture.project.workers();
    const keeper = workers[0];
    assert.ok(keeper);
    await waitFor(
      async () => (await fixture.project.workers())[0]?.status === "idle",
      "keeper handoff queued while router paused",
    );

    // User aborts Router; queued Worker handoff MUST survive due to onAbort: "keep".
    await fixture.project.root.abort(BACKGROUND_CONTEXT);

    const after = await fixture.project.send("after-abort-prompt");
    await after.wait(BACKGROUND_CONTEXT);

    assert.ok(nextRouterContext !== undefined);
    const contextDump = JSON.stringify(nextRouterContext.messages);
    assert.ok(
      contextDump.includes("important kept handoff payload"),
      "queued Worker notice must survive Router abort",
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("multiple concurrent Worker handoffs batch into a single Router run (followUpMode all)", async () => {
  const fixture = await openFixture();
  try {
    let routerBusy = false;
    let releaseRouter!: () => void;
    const routerGate = new Promise<void>((resolve) => {
      releaseRouter = resolve;
    });
    let releaseWorkers!: () => void;
    const workersGate = new Promise<void>((resolve) => {
      releaseWorkers = resolve;
    });
    let batchRunCount = 0;
    let batchedContext: TranscriptContext | undefined;

    const brain: FauxResponseFactory = (context) => {
      const last = context.messages.at(-1);
      const serialized = JSON.stringify(context.messages);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-batch-workers")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", { name: "alpha", prompt: "alpha-batch-task" }),
              fauxToolCall("spawn_worker", { name: "beta", prompt: "beta-batch-task" }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("alpha-batch-task")) {
          return workersGate.then(() => fauxAssistantMessage("alpha-batch-done"));
        }
        if (text.includes("beta-batch-task")) {
          return workersGate.then(() => fauxAssistantMessage("beta-batch-done"));
        }
        if (text.includes("hold-router-busy")) {
          routerBusy = true;
          return routerGate.then(() => fauxAssistantMessage("router finished holding"));
        }
        if (text.includes("alpha-batch-done") || text.includes("beta-batch-done")) {
          batchRunCount += 1;
          batchedContext = context;
          return fauxAssistantMessage("router processed batched handoffs");
        }
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("spawned alpha and beta");
      }
      throw new Error(`unexpected context: ${serialized}`);
    };
    fixture.faux.setResponses(responses(brain));

    const first = await fixture.project.send("spawn-batch-workers");
    await first.wait(BACKGROUND_CONTEXT);

    const hold = await fixture.project.send("hold-router-busy");
    await waitFor(() => routerBusy, "router busy");

    releaseWorkers();
    await waitFor(async () => {
      const workers = await fixture.project.workers();
      return workers.length === 2 && workers.every((w) => w.status === "idle");
    }, "both workers finished and queued handoffs");

    releaseRouter();
    await hold.wait(BACKGROUND_CONTEXT);

    await waitFor(async () => {
      const rootEntries = await entries(fixture.project.root);
      return rootEntries.some((entry) =>
        entryText(entry).includes("router processed batched handoffs"),
      );
    }, "batched router reply");
    await fixture.project.root.waitForIdle(BACKGROUND_CONTEXT);

    assert.equal(batchRunCount, 1, "both queued handoffs must be processed in a single Router run");
    const dump = JSON.stringify(batchedContext?.messages ?? []);
    assert.ok(dump.includes("alpha-batch-done"));
    assert.ok(dump.includes("beta-batch-done"));
  } finally {
    await closeFixture(fixture);
  }
});

test("stop_worker close kills background tasks, prevents waking, and cancels the open Ticket; interrupt spares bg tasks", async () => {
  const fixture = await openFixture();
  try {
    const longCmd = 'node -e "setTimeout(() => {}, 60000)"';
    let bgTaskStarted = false;

    const brain: FauxResponseFactory = (context) => {
      const last = context.messages.at(-1);
      const serialized = JSON.stringify(context.messages);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-long-bg")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "sleeper", prompt: "launch-long-bg-task" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("launch-long-bg-task")) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: longCmd, background: true })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("interrupt-sleeper")) {
          return fauxAssistantMessage(
            [fauxToolCall("stop_worker", { workerId: "w1", action: "interrupt" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("close-sleeper")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("stop_worker", {
                workerId: "w1",
                action: "close",
                note: "cancelled by user",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("delegated sleeper");
        if (last.toolName === "bash") {
          bgTaskStarted = true;
          return fauxAssistantMessage("long bg running");
        }
        if (last.toolName === "stop_worker") return fauxAssistantMessage("stopped sleeper");
      }
      throw new Error(`unexpected context: ${serialized}`);
    };
    fixture.faux.setResponses(responses(brain));

    const first = await fixture.project.send("spawn-long-bg");
    await first.wait(BACKGROUND_CONTEXT);
    await waitFor(() => bgTaskStarted, "long background task started");

    const worker = (await fixture.project.workers())[0];
    assert.ok(worker);
    await waitFor(async () => {
      const live = await fixture.project.harness.snapshot(
        LiveDoc,
        worker.conversationId,
        BACKGROUND_CONTEXT,
      );
      return live?.run === undefined;
    }, "sleeper run ended while bg task running");

    // First: stop_worker interrupt keeps background task running and sends no worker_failed notice.
    const interruptSub = await fixture.project.send("interrupt-sleeper");
    await interruptSub.wait(BACKGROUND_CONTEXT);
    const tasksAfterInterrupt = await listConversationTasks(
      fixture.project.harness,
      worker.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.equal(tasksAfterInterrupt[0]?.status, "running");
    assert.equal((await fixture.project.workers())[0]?.status, "running");
    assert.equal((await noticeEntries(fixture.project.root)).length, 0);

    // Second: stop_worker close kills background task, cancels open ticket with note, and closes worker.
    const closeSub = await fixture.project.send("close-sleeper");
    await closeSub.wait(BACKGROUND_CONTEXT);

    const afterWorkers = await fixture.project.workers();
    assert.equal(afterWorkers[0]?.status, "closed");
    assert.equal(afterWorkers[0]?.activeTicketId, undefined);

    const afterTickets = await fixture.project.tickets();
    assert.equal(afterTickets[0]?.status, "cancelled");
    assert.equal(afterTickets[0]?.note, "cancelled by user");

    const tasksAfterClose = await listConversationTasks(
      fixture.project.harness,
      worker.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.equal(tasksAfterClose[0]?.status, "killed");

    // Closed worker stays idle/unwoken (no new assistant message after close).
    await new Promise((resolve) => setTimeout(resolve, 100));
    const workerConv = await fixture.project.harness.conversation(
      worker.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.ok(workerConv);
    const assistantCount = (await entries(workerConv)).filter(
      (entry) => entry.kind === "pi.assistant",
    ).length;
    assert.equal(assistantCount, 2);
  } finally {
    await closeFixture(fixture);
  }
});

test("Ticket and Worker tool error paths and queued message_worker behavior", async () => {
  const fixture = await openFixture({
    maxActiveWorkers: 0,
    settings: { toolExecution: "sequential" },
  });
  try {
    const brain: FauxResponseFactory = (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("exercise-all-errors")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", { name: "queuedOne", prompt: "initial" }),
              // Queued worker accepts message_worker passively without starting:
              fauxToolCall("message_worker", { workerId: "w1", message: "extra queued note" }),
              // Worker already has open ticket t1 -> newTicket must fail:
              fauxToolCall("message_worker", {
                workerId: "w1",
                message: "nope",
                newTicket: { title: "Conflict" },
              }),
              // Unknown worker / unknown ticket:
              fauxToolCall("message_worker", { workerId: "w99", message: "missing" }),
              fauxToolCall("close_ticket", { ticketId: "t99", status: "done" }),
              fauxToolCall("stop_worker", { workerId: "w99", action: "close" }),
              // Close ticket + worker, then try double-closing & messaging closed worker:
              fauxToolCall("close_ticket", {
                ticketId: "t1",
                status: "done",
                closeWorker: true,
              }),
              fauxToolCall("close_ticket", { ticketId: "t1", status: "cancelled" }),
              fauxToolCall("message_worker", { workerId: "w1", message: "after close" }),
              fauxToolCall("stop_worker", { workerId: "w1", action: "close" }),
            ],
            { stopReason: "toolUse" },
          );
        }
      }
      if (last?.role === "toolResult") {
        return fauxAssistantMessage("all error paths exercised");
      }
      throw new Error(`unexpected context: ${JSON.stringify(context.messages)}`);
    };
    fixture.faux.setResponses(responses(brain));

    const sub = await fixture.project.send("exercise-all-errors");
    await sub.wait(BACKGROUND_CONTEXT);

    const rootEntries = await entries(fixture.project.root);
    const toolResults = rootEntries
      .map((entry) => entry.model?.[0])
      .filter((msg): msg is Extract<Message, { role: "toolResult" }> => msg?.role === "toolResult");

    assert.equal(toolResults.length, 10);
    // 0: spawn_worker ok
    assert.equal(toolResults[0]?.isError, false);
    // 1: message_worker to queued worker ok
    assert.equal(toolResults[1]?.isError, false);
    assert.ok(contentText(toolResults[1]?.content ?? []).includes("queued"));
    // 2: message_worker with newTicket while t1 open -> error
    assert.equal(toolResults[2]?.isError, true);
    assert.ok(contentText(toolResults[2]?.content ?? []).includes("close_ticket"));
    // 3: unknown worker -> error
    assert.equal(toolResults[3]?.isError, true);
    // 4: unknown ticket -> error
    assert.equal(toolResults[4]?.isError, true);
    // 5: stop unknown worker -> error
    assert.equal(toolResults[5]?.isError, true);
    // 6: close_ticket(t1, done, closeWorker: true) -> ok
    assert.equal(toolResults[6]?.isError, false);
    // 7: close already-closed t1 -> error
    assert.equal(toolResults[7]?.isError, true);
    // 8: message closed w1 -> error
    assert.equal(toolResults[8]?.isError, true);
    // 9: stop already-closed w1 -> error
    assert.equal(toolResults[9]?.isError, true);

    const workers = await fixture.project.workers();
    const firstWorker = workers[0];
    assert.ok(firstWorker);
    assert.equal(firstWorker.status, "closed");
    const workerConv = await fixture.project.harness.conversation(
      firstWorker.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.ok(workerConv);
    const workerEntries = await entries(workerConv);
    assert.equal(workerEntries.filter((e) => e.kind === "pi.user").length, 2);
    assert.equal(
      workerEntries.some((e) => e.kind === "pi.assistant"),
      false,
    );
  } finally {
    await closeFixture(fixture);
  }
});
