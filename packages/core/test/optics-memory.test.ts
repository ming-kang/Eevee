import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  type SystemMessage,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  type Conversation,
  type ConversationView,
  type EntryRecord,
  LiveDoc,
  SystemEntry,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { listConversationTasks } from "@eevee/agent";
import {
  type BoardView,
  NOTICE_ENTRY_KIND,
  openProject,
  type ProjectHandle,
} from "../src/index.ts";

const MODEL_ID = "faux-1";

function responses(brain: FauxResponseFactory, count = 60): FauxResponseFactory[] {
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

function lastMessage(context: TranscriptContext): Message | undefined {
  return context.messages.findLast((message) => message.role !== "system");
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

function makeUsage(input: number, output: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  };
}

test("full optics paper scenario: ask_user, background simulation, inspect_worker, ticket reuse, and close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-3c-optics-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = new MemoryStorage();

  const simCmd = "node -e \"setTimeout(() => console.log('LOSS_DB=0.18'), 120)\"";
  const boardSnapshots: BoardView[] = [];
  let project: ProjectHandle | undefined;

  try {
    project = await openProject(storage, {
      cwd: dir,
      title: "Optics Paper",
      workspaces: [dir],
      models,
      modelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      baseExtensionOptions: { globalDir: join(dir, "no-global") },
    });

    const unsubBoard = project.subscribeBoard((view) => boardSnapshots.push(view));

    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      const dump = JSON.stringify(context.messages);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("Write the waveguide loss section")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "writer",
                prompt: "writer-task-1: prepare optics paper outline",
                ticketTitle: "Outline waveguide section",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("writer-task-1: prepare optics paper outline")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("message_router", {
                message: "Missing target wavelength and substrate.",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("Missing target wavelength and substrate.")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("ask_user", {
                questions: [
                  {
                    question: "Target wavelength?",
                    options: ["1310nm", "1550nm"],
                    recommended: "1550nm",
                  },
                  { question: "Substrate material?" },
                ],
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("User answered question q1:")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "simulator",
                prompt: "sim-task: run waveguide loss sweep for 1550nm SiN",
                ticketTitle: "Run FDTD sweep",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("sim-task: run waveguide loss sweep")) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: simCmd, background: true })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("LOSS_DB=0.18")) {
          return fauxAssistantMessage("Simulation measured 0.18 dB/cm at 1550nm SiN.");
        }
        if (text.includes("Simulation measured 0.18 dB/cm")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("inspect_worker", {}),
              fauxToolCall("inspect_worker", {
                workerId: "w2",
                include: "tasks",
                taskId: "task-1",
              }),
              fauxToolCall("inspect_worker", { workerId: "w2", include: "transcript", limit: 10 }),
              fauxToolCall("close_ticket", {
                ticketId: "t1",
                status: "done",
                note: "outline ready",
              }),
              fauxToolCall("close_ticket", {
                ticketId: "t2",
                status: "done",
                note: "sweep complete",
                closeWorker: true,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("writer-task-2: incorporate 0.18 dB/cm")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("write", {
                path: "paper.md",
                content: "# Waveguide Loss\n1550nm SiN measured 0.18 dB/cm.\n",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("Paper section drafted in paper.md")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("close_ticket", {
                ticketId: "t3",
                status: "done",
                note: "drafted",
                closeWorker: true,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
      }

      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker" && dump.includes("Run FDTD sweep")) {
          return fauxAssistantMessage("Launched simulator worker w2.");
        }
        if (last.toolName === "spawn_worker") {
          return fauxAssistantMessage("Launched writer worker w1.");
        }
        if (last.toolName === "message_router") {
          return fauxAssistantMessage("Standing by for parameters.");
        }
        if (last.toolName === "ask_user") {
          return fauxAssistantMessage("Asked the user for wavelength and substrate.");
        }
        if (last.toolName === "bash") {
          return fauxAssistantMessage("FDTD sweep running in background.");
        }
        if (last.toolName === "close_ticket" && dump.includes('"ticketId":"t3"')) {
          return fauxAssistantMessage("Optics paper complete!");
        }
        if (last.toolName === "close_ticket" && dump.includes("sweep complete")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("message_worker", {
                workerId: "w1",
                message: "writer-task-2: incorporate 0.18 dB/cm at 1550nm SiN into paper.md",
                newTicket: { title: "Draft final section" },
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (last.toolName === "message_worker") {
          return fauxAssistantMessage("Assigned final drafting to w1.");
        }
        if (last.toolName === "write") {
          return fauxAssistantMessage("Paper section drafted in paper.md.");
        }
      }
      throw new Error(`unexpected context: ${dump}`);
    };
    faux.setResponses(responses(brain));

    const p = project;
    const first = await p.send("Write the waveguide loss section.");
    await first.wait(BACKGROUND_CONTEXT);

    await waitFor(async () => (await p.questions()).length === 1, "pending user question q1");
    const pendingQuestions = await p.questions();
    assert.equal(pendingQuestions[0]?.id, "q1");
    assert.equal(pendingQuestions[0]?.answeredAt, undefined);

    // Non-blocking ask_user let Router finish its turn cleanly before user answers.
    await p.root.waitForIdle(BACKGROUND_CONTEXT);

    // User answers q1 -> wakes Router -> launches w2 -> finishes simulation -> w1 writes paper.md -> closes all.
    const answered = await p.answerQuestion("q1", ["1550nm", "SiN"]);
    assert.deepEqual(answered.answers, ["1550nm", "SiN"]);
    assert.ok(answered.answeredAt !== undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(answered)), answered);

    await waitFor(async () => {
      const rootEntries = await entries(p.root);
      return rootEntries.some((entry) => entryText(entry).includes("Optics paper complete!"));
    }, "optics paper completion");

    assert.equal(
      await readFile(join(dir, "paper.md"), "utf8"),
      "# Waveguide Loss\n1550nm SiN measured 0.18 dB/cm.\n",
    );

    const finalBoard = await project.board();
    assert.equal(finalBoard.workers.length, 2);
    assert.equal(finalBoard.workers[0]?.status, "closed");
    assert.equal(finalBoard.workers[1]?.status, "closed");
    assert.deepEqual(
      finalBoard.tickets.map((t) => [t.id, t.status]),
      [
        ["t1", "done"],
        ["t2", "done"],
        ["t3", "done"],
      ],
    );
    assert.ok(boardSnapshots.length >= 2, "subscribeBoard should receive live updates");

    // Verify inspect_worker calls returned real task output and transcript without errors.
    const rootEntries = await entries(project.root);
    const inspectResults = rootEntries
      .map((entry) => entry.model?.[0])
      .filter(
        (msg): msg is Extract<Message, { role: "toolResult" }> =>
          msg?.role === "toolResult" && msg.toolName === "inspect_worker",
      );
    assert.equal(inspectResults.length, 3);
    assert.ok(inspectResults.every((r) => !r.isError));
    assert.ok(contentText(inspectResults[1]?.content ?? []).includes("LOSS_DB=0.18"));
    assert.ok(contentText(inspectResults[2]?.content ?? []).includes("Simulation measured 0.18"));

    unsubBoard();
  } finally {
    await project?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("user direct observation and intervention: watch, direct send, interrupt, and killWorkerTask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-3c-intervene-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = new MemoryStorage();
  const longCmd = 'node -e "setTimeout(() => {}, 60000)"';

  let project: ProjectHandle | undefined;
  try {
    project = await openProject(storage, {
      cwd: dir,
      models,
      modelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      baseExtensionOptions: { globalDir: join(dir, "no-global") },
    });

    let pauseDirectRun = false;
    const brain: FauxResponseFactory = (context, options) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-observed-worker")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "obs", prompt: "start-long-task" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("start-long-task")) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: longCmd, background: true })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("direct-user-nudge")) {
          pauseDirectRun = true;
          return new Promise((_, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("interrupted")), {
              once: true,
            });
          });
        }
        if (text.includes("cancelled by the user")) {
          return fauxAssistantMessage("user cancelled task noted");
        }
        if (text.includes("user cancelled task noted")) {
          return fauxAssistantMessage("router noted user cancel");
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("spawned obs");
        if (last.toolName === "bash") return fauxAssistantMessage("long bg running");
      }
      throw new Error(`unexpected context: ${JSON.stringify(context.messages)}`);
    };
    faux.setResponses(responses(brain));

    const p = project;
    const routerWatch = await p.watchConversation("router");
    let routerWatchUpdates = 0;
    routerWatch.start(async (call) => {
      if (call.kind === "value") routerWatchUpdates += 1;
    });
    const sub = await p.send("spawn-observed-worker");
    await sub.wait(BACKGROUND_CONTEXT);

    const w1 = (await p.workers())[0];
    assert.ok(w1);

    const observedViews: ConversationView[] = [];
    const obs = await p.observeConversation("w1", {
      advance: (call) => {
        if (call.kind === "value") observedViews.push(call.value);
      },
      end: () => {},
    });
    observedViews.push(obs.value);

    // Wait for w1's background bash task to be running and its run to finish.
    await waitFor(async () => {
      const tasks = await listConversationTasks(p.harness, w1.conversationId, BACKGROUND_CONTEXT);
      const live = await p.harness.snapshot(LiveDoc, w1.conversationId, BACKGROUND_CONTEXT);
      return tasks[0]?.status === "running" && live?.run === undefined;
    }, "w1 background task running");

    // User sends direct message to w1, then interrupts it mid-run (background task must survive!).
    void p.send("w1", "direct-user-nudge");
    await waitFor(() => pauseDirectRun, "direct message run paused");
    await p.interrupt("w1");

    const tasksAfterInterrupt = await listConversationTasks(
      p.harness,
      w1.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.equal(tasksAfterInterrupt[0]?.status, "running");

    const taskOutput = await p.readWorkerTaskOutput("w1", "task-1");
    assert.equal(taskOutput.task.id, "task-1");
    assert.equal(taskOutput.task.status, "running");
    const entryPage = await p.listEntries("w1", { order: "ascending" }, 2);
    assert.ok(entryPage.items.length >= 1);

    // Now user kills the background task directly: status becomes cancelled with cancelReason "user",
    // Worker receives the unified steer notice to wrap up cleanly, and then becomes idle.
    const killed = await p.killWorkerTask("w1", "task-1");
    assert.equal(killed.status, "cancelled");
    assert.equal(killed.cancelReason, "user");
    await waitFor(
      async () => (await noticeEntries(p.root)).length === 1,
      "worker wrap-up handoff after user cancel",
    );
    await p.root.waitForIdle(BACKGROUND_CONTEXT);
    assert.equal((await p.workers())[0]?.status, "idle");
    assert.ok(observedViews.length >= 2, "observeConversation should receive live updates");
    assert.ok(routerWatchUpdates >= 1, "watchConversation should receive live updates");

    obs.detach();
    await routerWatch.stop();
  } finally {
    await project?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("updating projectMemory appends only one incremental pi.system entry on the next request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-3c-memory-delta-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = new MemoryStorage();

  let projectMemory = "Initial project convention: use SI units.";
  const modelProfiles = "fast: faux-1 (quick drafts)";
  const capturedRouterContexts: TranscriptContext[] = [];
  const capturedWorkerContexts: TranscriptContext[] = [];

  let project: ProjectHandle | undefined;
  try {
    project = await openProject(storage, {
      cwd: dir,
      title: "Delta Test",
      workspaces: [dir],
      models,
      modelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      projectMemory: () => projectMemory,
      modelProfiles: () => modelProfiles,
      baseExtensionOptions: { globalDir: join(dir, "no-global") },
    });

    const brain: FauxResponseFactory = (context) => {
      const firstSys = context.messages[0] as SystemMessage | undefined;
      const isWorker = firstSys?.sections?.["worker-role"] !== undefined;
      if (isWorker) capturedWorkerContexts.push(context);
      else capturedRouterContexts.push(context);

      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("router-turn-1")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "memw", prompt: "worker-turn-1" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("worker-turn-1")) return fauxAssistantMessage("worker-reply-1");
        if (text.includes("worker-reply-1")) return fauxAssistantMessage("router-saw-reply-1");
        if (text.includes("router-turn-2")) return fauxAssistantMessage("router-reply-2");
        if (text.includes("worker-turn-2")) return fauxAssistantMessage("worker-reply-2");
        if (text.includes("worker-reply-2")) return fauxAssistantMessage("router-saw-reply-2");
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("spawned memw");
      }
      throw new Error(`unexpected context: ${JSON.stringify(context.messages)}`);
    };
    faux.setResponses(responses(brain));

    const p = project;
    const t1 = await p.send("router-turn-1");
    await t1.wait(BACKGROUND_CONTEXT);
    await waitFor(
      async () => (await entries(p.root)).some((e) => entryText(e).includes("router-saw-reply-1")),
      "round 1 complete",
    );
    await p.root.waitForIdle(BACKGROUND_CONTEXT);

    const w1 = (await project.workers())[0];
    assert.ok(w1);
    const workerConv = await project.harness.conversation(w1.conversationId, BACKGROUND_CONTEXT);
    assert.ok(workerConv);

    // Check initial prompt sections on Router and Worker.
    const routerFirstSys = capturedRouterContexts[0]?.messages[0] as SystemMessage;
    assert.ok(routerFirstSys.sections?.project?.includes("Delta Test"));
    assert.ok(routerFirstSys.sections?.["model-profiles"]?.includes("fast: faux-1"));
    assert.ok(routerFirstSys.sections?.["project-memory"]?.includes("use SI units"));

    const workerFirstSys = capturedWorkerContexts[0]?.messages[0] as SystemMessage;
    assert.ok(workerFirstSys.sections?.["worker-role"]?.includes("message_router"));
    assert.ok(workerFirstSys.sections?.["project-memory"]?.includes("use SI units"));

    const routerSysBefore = (await entries(project.root)).filter((e) => SystemEntry.is(e)).length;
    const workerSysBefore = (await entries(workerConv)).filter((e) => SystemEntry.is(e)).length;

    // Modify projectMemory and run one more turn on Router and Worker.
    projectMemory = "Updated convention: report wavelength in nanometers.";

    const t2 = await project.send("router-turn-2");
    await t2.wait(BACKGROUND_CONTEXT);

    const routerSysEntriesAfter = (await entries(project.root)).filter((e) => SystemEntry.is(e));
    assert.equal(
      routerSysEntriesAfter.length,
      routerSysBefore + 1,
      "Router must emit strictly one incremental pi.system entry after projectMemory change",
    );
    const routerDelta = routerSysEntriesAfter.at(-1)?.model?.[0] as SystemMessage;
    assert.deepEqual(Object.keys(routerDelta.sections ?? {}), ["project-memory"]);
    assert.ok(routerDelta.sections?.["project-memory"]?.includes("wavelength in nanometers"));

    const w2Sub = await project.send("w1", "worker-turn-2");
    await w2Sub.wait(BACKGROUND_CONTEXT);

    const workerSysEntriesAfter = (await entries(workerConv)).filter((e) => SystemEntry.is(e));
    assert.equal(
      workerSysEntriesAfter.length,
      workerSysBefore + 1,
      "Worker must emit strictly one incremental pi.system entry after projectMemory change",
    );
    const workerDelta = workerSysEntriesAfter.at(-1)?.model?.[0] as SystemMessage;
    assert.deepEqual(Object.keys(workerDelta.sections ?? {}), ["project-memory"]);
    assert.ok(workerDelta.sections?.["project-memory"]?.includes("wavelength in nanometers"));
  } finally {
    await project?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Router compaction replaces history with <memory> forest view and usage() includes Dreamer spend", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-3c-forest-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = new MemoryStorage();

  let project: ProjectHandle | undefined;
  try {
    const pad = "detailed optics analysis context ".repeat(14);
    project = await openProject(storage, {
      cwd: dir,
      models,
      modelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      baseExtensionOptions: { globalDir: join(dir, "no-global") },
      settings: {
        compaction: {
          enabled: true,
          keepRecentTokens: 20,
          reserveTokens: 1000,
          backgroundTokens: 0,
        },
      },
      memoryBudget: () => ({ compaction: null, view: { min: 45, max: 75 } }),
      memorySummarizer: () => async (task) => ({
        text: `sum(${task.input[0]?.slice(0, 32) ?? ""})`,
        modelKey: "dreamer-provider/dreamer-mini",
        usage: makeUsage(120, 30),
      }),
    });

    faux.setResponses([
      fauxAssistantMessage(`Reply 0 ${pad}`),
      fauxAssistantMessage(`Reply 1 ${pad}`),
      fauxAssistantMessage(`Reply 2 ${pad}`),
      fauxAssistantMessage("Recent reply 3 kept verbatim."),
    ]);

    for (let i = 0; i < 4; i++) {
      const sub = await project.send(`Turn ${i}: ${pad}`);
      await sub.wait(BACKGROUND_CONTEXT);
    }
    await project.memory.dreamer.sync();
    await project.memory.dreamer.idle();

    const compactTask = await project.root.compact(undefined, BACKGROUND_CONTEXT);
    const settled = await project.harness.waitForTask(compactTask, BACKGROUND_CONTEXT);
    assert.equal(settled.state.outcome.status, "completed");
    await project.root.waitForIdle(BACKGROUND_CONTEXT);

    const rootEntries = await entries(project.root);
    const compactions = rootEntries.filter((e) => CompactionEntry.is(e));
    assert.equal(compactions.length, 1);
    const summaryText = entryText(compactions[0] as EntryRecord);
    assert.ok(summaryText.includes("<memory>\n"), `Expected <memory> view:\n${summaryText}`);
    assert.ok(summaryText.includes("\n</memory>"));

    // Usage totals include both pi.usage (Router) and MemoryMetaDoc.usage (Dreamer).
    const totalUsage = await project.usage();
    assert.ok(totalUsage.models[`${faux.provider.id}/${MODEL_ID}`] !== undefined);
    assert.ok((totalUsage.models["dreamer-provider/dreamer-mini"]?.totalTokens ?? 0) >= 150);
  } finally {
    await project?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("reopening Storage preserves Workers, Tickets, and unanswered Questions and starts queued Workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-3c-reopen-"));
  const storage = new MemoryStorage();
  storage.close = () => Promise.resolve();

  const faux1 = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models1 = createModels();
  models1.setProvider(faux1.provider);

  const p1 = await openProject(storage, {
    cwd: dir,
    models: models1,
    modelSlots: {
      router: { provider: faux1.provider.id, modelId: MODEL_ID },
      worker: { provider: faux1.provider.id, modelId: MODEL_ID },
    },
    maxActiveWorkers: 0,
    baseExtensionOptions: { globalDir: join(dir, "no-global") },
  });

  try {
    const brain1: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user" && messageText(last).includes("seed-state-before-restart")) {
        return fauxAssistantMessage(
          [
            fauxToolCall("spawn_worker", {
              name: "queuedAfterRestart",
              prompt: "after-restart-worker-task",
              ticketTitle: "Queued ticket",
            }),
            fauxToolCall("ask_user", {
              questions: [{ question: "Confirm deployment target?" }],
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      if (last?.role === "toolResult") {
        return fauxAssistantMessage("Seeded queued worker and open question.");
      }
      throw new Error(`unexpected p1 context: ${JSON.stringify(context.messages)}`);
    };
    faux1.setResponses(responses(brain1));

    const sub = await p1.send("seed-state-before-restart");
    await sub.wait(BACKGROUND_CONTEXT);

    const beforeBoard = await p1.board();
    assert.equal(beforeBoard.workers.length, 1);
    assert.equal(beforeBoard.workers[0]?.status, "queued");
    assert.equal(beforeBoard.tickets.length, 1);
    assert.equal(beforeBoard.questions.length, 1);
    assert.equal(beforeBoard.questions[0]?.answeredAt, undefined);
    await p1.close();

    // Reopen on the same Storage with maxActiveWorkers: 1 so the queued Worker starts automatically!
    const faux2 = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models2 = createModels();
    models2.setProvider(faux2.provider);
    const p2 = await openProject(storage, {
      cwd: dir,
      models: models2,
      modelSlots: {
        router: { provider: faux2.provider.id, modelId: MODEL_ID },
        worker: { provider: faux2.provider.id, modelId: MODEL_ID },
      },
      maxActiveWorkers: 1,
      baseExtensionOptions: { globalDir: join(dir, "no-global") },
    });

    try {
      const brain2: FauxResponseFactory = (context) => {
        const last = lastMessage(context);
        if (last?.role === "user") {
          const text = messageText(last);
          if (text.includes("after-restart-worker-task")) {
            return fauxAssistantMessage("worker finished after reopen");
          }
          if (text.includes("worker finished after reopen")) {
            return fauxAssistantMessage("router received post-reopen handoff");
          }
          if (text.includes("User answered question q1:")) {
            return fauxAssistantMessage("router received post-reopen answer");
          }
        }
        throw new Error(`unexpected p2 context: ${JSON.stringify(context.messages)}`);
      };
      faux2.setResponses(responses(brain2));

      // Queued worker automatically starts via ProjectPump and hands off.
      await waitFor(
        async () =>
          (await entries(p2.root)).some((e) =>
            entryText(e).includes("router received post-reopen handoff"),
          ),
        "queued worker start and handoff after reopen",
      );

      // Unanswered question q1 survived reopen and can still be answered.
      const questionsAfter = await p2.questions();
      assert.equal(questionsAfter.length, 1);
      assert.equal(questionsAfter[0]?.id, "q1");
      assert.equal(questionsAfter[0]?.answeredAt, undefined);

      await p2.answerQuestion("q1", ["staging"]);
      await waitFor(
        async () =>
          (await entries(p2.root)).some((e) =>
            entryText(e).includes("router received post-reopen answer"),
          ),
        "post-reopen answer delivery to router",
      );

      const finalBoard = await p2.board();
      assert.equal(finalBoard.workers[0]?.status, "idle");
      assert.equal(finalBoard.tickets[0]?.id, "t1");
      assert.deepEqual(finalBoard.questions[0]?.answers, ["staging"]);
    } finally {
      await p2.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ProjectHandle.retry continues Router/Worker after failure and rejects queued/closed workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-4b-retry-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = new MemoryStorage();

  const project = await openProject(storage, {
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
    let failRouterOnce = true;
    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-queued")) {
          if (failRouterOnce) {
            failRouterOnce = false;
            return fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: "invalid_api_key",
            });
          }
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "qworker", prompt: "do work" })],
            { stopReason: "toolUse" },
          );
        }
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("router queued qworker");
      }
      throw new Error(`unexpected context: ${JSON.stringify(context.messages)}`);
    };
    faux.setResponses(responses(brain));

    const first = await project.send("spawn-queued");
    const firstSettled = await first.wait(BACKGROUND_CONTEXT);
    assert.equal(firstSettled.status, "unanswered");

    const retriedRouter = await project.retry("router");
    const retriedSettled = await retriedRouter.wait(BACKGROUND_CONTEXT);
    assert.equal(retriedSettled.status, "done");

    await assert.rejects(project.retry("w1"), /Worker w1 is queued/);
    await assert.rejects(project.retry("w99"), /Unknown worker w99/);
  } finally {
    await project.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
