import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  type SystemMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type Conversation,
  type EntryRecord,
  InboxDoc,
  LiveDoc,
  type Storage,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { listConversationTasks, TASK_NOTIFICATION_ENTRY_KIND } from "@eevee/agent";
import { NOTICE_ENTRY_KIND, openProject, type ProjectHandle } from "../src/index.ts";

type Fixture = {
  readonly dir: string;
  readonly faux: FauxProviderHandle;
  readonly storage: Storage;
  readonly project: ProjectHandle;
};

const MODEL_ID = "faux-1";

async function openFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-core-steer-"));
  const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const storage: Storage = new MemoryStorage();
  const project = await openProject(storage, {
    cwd: dir,
    models,
    modelSlots: {
      router: { provider: faux.provider.id, modelId: MODEL_ID },
      worker: { provider: faux.provider.id, modelId: MODEL_ID },
    },
    baseExtensionOptions: { globalDir: join(dir, "no-global-context") },
  });
  return { dir, faux, storage, project };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.project.close().catch(() => undefined);
  await rm(fixture.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

function lastMessage(context: TranscriptContext): Message | undefined {
  return context.messages.findLast((message) => message.role !== "system");
}

function isWorkerContext(context: TranscriptContext): boolean {
  const sys = context.messages[0] as SystemMessage | undefined;
  return sys?.sections?.["worker-role"] !== undefined;
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

test("multiple queued steers batch into a single postTools turn (steeringMode: all)", async () => {
  const fixture = await openFixture();
  try {
    const workerContexts: TranscriptContext[] = [];
    let releaseWorkerTool: (() => void) | undefined;
    const workerToolEntered = new Promise<void>((resolve) => {
      releaseWorkerTool = resolve;
    });

    let steerTurnSawBoth = false;

    const brain: FauxResponseFactory = async (context) => {
      if (isWorkerContext(context)) workerContexts.push(context);
      const last = lastMessage(context);

      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("start-steer-batch")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "steerer", prompt: "run-slow-tool" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("run-slow-tool")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command: "node -e \"setTimeout(() => console.log('slow-fg-done'), 250)\"",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("steer-beta")) {
          const allText = context.messages.map(messageText).join("\n");
          steerTurnSawBoth = allText.includes("steer-alpha") && allText.includes("steer-beta");
          return fauxAssistantMessage("handled batched steers");
        }
        if (text.includes("handled batched steers")) {
          return fauxAssistantMessage("router received batch summary");
        }
      }

      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") {
          return fauxAssistantMessage("spawned steerer");
        }
        if (last.toolName === "bash") {
          return fauxAssistantMessage("unexpected unsteered tool result");
        }
      }

      throw new Error(`unexpected context: ${JSON.stringify(context.messages)}`);
    };

    fixture.faux.setResponses(Array.from({ length: 20 }, () => brain));

    const routerSub = await fixture.project.send("start-steer-batch");
    await routerSub.wait(BACKGROUND_CONTEXT);

    await waitFor(
      async () => (await fixture.project.workers())[0]?.status === "running",
      "worker running slow tool",
    );
    const w1 = (await fixture.project.workers())[0];
    assert.ok(w1);

    await waitFor(async () => {
      const live = await fixture.project.harness.snapshot(
        LiveDoc,
        w1.conversationId,
        BACKGROUND_CONTEXT,
      );
      return (live?.tools?.length ?? 0) > 0;
    }, "worker tool slot active");
    releaseWorkerTool?.();
    await workerToolEntered;

    await fixture.project.send("w1", "steer-alpha", { whenBusy: "steer" });
    await fixture.project.send("w1", "steer-beta", { whenBusy: "steer" });

    await waitFor(
      async () => (await noticeEntries(fixture.project.root)).length === 1,
      "single handoff after batched steers",
    );
    await fixture.project.root.waitForIdle(BACKGROUND_CONTEXT);

    assert.equal(steerTurnSawBoth, true, "both steers must arrive in a single postTools turn");
    assert.equal(
      workerContexts.length,
      2,
      "worker takes initial tool turn + single batched steer turn",
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("fast background task settling before Worker turn finishes queues steer in InboxDoc and suppresses premature handoff", async () => {
  const fixture = await openFixture();
  try {
    let workerConvId = 0 as number;
    let delayedResolve: (() => void) | undefined;

    const brain: FauxResponseFactory = async (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("launch-fast-bg")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "fastbg", prompt: "start-fast-bg" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("start-fast-bg")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command: "node -e \"setTimeout(() => console.log('FAST_BG_RESULT'), 50)\"",
                background: true,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("FAST_BG_RESULT")) {
          return fauxAssistantMessage("final wrap-up with FAST_BG_RESULT");
        }
        if (text.includes("final wrap-up with FAST_BG_RESULT")) {
          return fauxAssistantMessage("router acknowledged final wrap-up");
        }
      }

      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("spawned fastbg");
        if (last.toolName === "bash") {
          // Hold the Worker's current answer long enough for the fast bg task to finish
          // and enqueue its completion steer into InboxDoc BEFORE the Worker's turn ends.
          await new Promise<void>((resolve) => {
            delayedResolve = resolve;
            void waitFor(async () => {
              const workers = await fixture.project.workers();
              const w = workers[0];
              if (w === undefined) return false;
              workerConvId = w.conversationId;
              const inbox = await fixture.project.harness.snapshot(
                InboxDoc,
                w.conversationId,
                BACKGROUND_CONTEXT,
              );
              return (inbox?.items ?? []).some((item) => item.mode === "steer");
            }, "fast bg steer queued in InboxDoc").then(() => resolve());
          });
          return fauxAssistantMessage("intermediate summary before noticing bg");
        }
      }

      throw new Error(`unexpected context: ${JSON.stringify(context.messages)}`);
    };

    fixture.faux.setResponses(Array.from({ length: 20 }, () => brain));

    const sub = await fixture.project.send("launch-fast-bg");
    await sub.wait(BACKGROUND_CONTEXT);

    await waitFor(
      async () => (await noticeEntries(fixture.project.root)).length === 1,
      "exactly one final handoff after steer processed",
    );
    await fixture.project.root.waitForIdle(BACKGROUND_CONTEXT);

    assert.ok(delayedResolve !== undefined);
    assert.ok(workerConvId > 0);
    const notices = await noticeEntries(fixture.project.root);
    assert.equal(notices.length, 1, "premature intermediate handoff must be suppressed");
    assert.ok(entryText(notices[0] as EntryRecord).includes("final wrap-up with FAST_BG_RESULT"));
    assert.equal(
      notices.some((n) => entryText(n).includes("intermediate summary")),
      false,
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("killWorkerTask delivers cancelled-by-user steer notice while stop_worker(close) stays silent", async () => {
  const fixture = await openFixture();
  try {
    const longCmd = "node -e \"setTimeout(() => console.log('NEVER'), 60000)\"";

    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-two-workers")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", { name: "userkill", prompt: "launch-w1" }),
              fauxToolCall("spawn_worker", { name: "closer", prompt: "launch-w2" }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("launch-w1") || text.includes("launch-w2")) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: longCmd, background: true })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("cancelled by the user")) {
          return fauxAssistantMessage("w1 acknowledged user cancellation");
        }
        if (text.includes("w1 acknowledged user cancellation")) {
          return fauxAssistantMessage("router noted w1 wrap-up");
        }
        if (text.includes("close-w2")) {
          return fauxAssistantMessage(
            [fauxToolCall("stop_worker", { workerId: "w2", action: "close" })],
            { stopReason: "toolUse" },
          );
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("spawned both");
        if (last.toolName === "bash") return fauxAssistantMessage("bg running");
        if (last.toolName === "stop_worker") return fauxAssistantMessage("closed w2");
      }
      throw new Error(`unexpected context: ${JSON.stringify(context.messages)}`);
    };

    fixture.faux.setResponses(Array.from({ length: 30 }, () => brain));

    await (await fixture.project.send("spawn-two-workers")).wait(BACKGROUND_CONTEXT);

    await waitFor(async () => {
      const workers = await fixture.project.workers();
      const first = workers[0];
      const second = workers[1];
      if (first === undefined || second === undefined) return false;
      const w1Tasks = await listConversationTasks(
        fixture.project.harness,
        first.conversationId,
        BACKGROUND_CONTEXT,
      );
      const w2Tasks = await listConversationTasks(
        fixture.project.harness,
        second.conversationId,
        BACKGROUND_CONTEXT,
      );
      return w1Tasks[0]?.status === "running" && w2Tasks[0]?.status === "running";
    }, "both workers have running background tasks");

    const workers = await fixture.project.workers();
    const w1 = workers[0];
    const w2 = workers[1];
    assert.ok(w1 !== undefined && w2 !== undefined);

    // Wait for initial runs to go idle while background tasks keep running.
    await waitFor(async () => {
      const l1 = await fixture.project.harness.snapshot(
        LiveDoc,
        w1.conversationId,
        BACKGROUND_CONTEXT,
      );
      const l2 = await fixture.project.harness.snapshot(
        LiveDoc,
        w2.conversationId,
        BACKGROUND_CONTEXT,
      );
      return l1?.run === undefined && l2?.run === undefined;
    }, "both workers idle after starting bg tasks");

    // Kill w1's task using unique prefix "1" -> cancelled by user + steer wake + handoff.
    const killedW1 = await fixture.project.killWorkerTask("w1", "1");
    assert.equal(killedW1.id, "task-1");
    assert.equal(killedW1.status, "cancelled");
    assert.equal(killedW1.cancelReason, "user");

    await waitFor(
      async () => (await noticeEntries(fixture.project.root)).length === 1,
      "w1 wrap-up handoff after user kill",
    );
    await fixture.project.root.waitForIdle(BACKGROUND_CONTEXT);

    const w1Conv = await fixture.project.harness.conversation(
      w1.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.ok(w1Conv);
    const w1Notes = (await entries(w1Conv)).filter((e) => e.kind === TASK_NOTIFICATION_ENTRY_KIND);
    assert.equal(w1Notes.length, 1);
    assert.ok(JSON.stringify(w1Notes[0]?.model ?? []).includes("cancelled by the user"));

    // Close w2 via stop_worker(close) -> task cancelled with abort, NO wake, NO notification!
    await (await fixture.project.send("close-w2")).wait(BACKGROUND_CONTEXT);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const w2TasksAfterClose = await fixture.project.listWorkerTasks("w2");
    assert.equal(w2TasksAfterClose[0]?.status, "cancelled");
    assert.equal(w2TasksAfterClose[0]?.cancelReason, "abort");

    const w2Conv = await fixture.project.harness.conversation(
      w2.conversationId,
      BACKGROUND_CONTEXT,
    );
    assert.ok(w2Conv);
    const w2Entries = await entries(w2Conv);
    assert.equal(
      w2Entries.some((e) => e.kind === TASK_NOTIFICATION_ENTRY_KIND),
      false,
      "stop_worker(close) must not send notification",
    );
    assert.equal(
      w2Entries.filter((e) => e.kind === "pi.assistant").length,
      2,
      "closed worker must not be woken",
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("listWorkerTasks, subscribeWorkerTaskOutput, and inspect_worker prefix/filter/endByte work", async () => {
  const fixture = await openFixture();
  try {
    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("start-inspect-test")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "inspector", prompt: "run-bg-logs" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("run-bg-logs")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command:
                  "node -e \"console.log('line1'); setTimeout(() => { console.log('MATCH_HERE'); console.log('line3'); }, 80)\"",
                background: true,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("MATCH_HERE")) {
          return fauxAssistantMessage("worker saw MATCH_HERE");
        }
        if (text.includes("worker saw MATCH_HERE")) {
          return fauxAssistantMessage("router saw handoff");
        }
        if (text.includes("inspect-prefix-filter")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("inspect_worker", {
                workerId: "w1",
                include: "tasks",
                taskId: "1",
                filter: "match",
                contextLines: 1,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("spawned");
        if (last.toolName === "bash") return fauxAssistantMessage("started");
        if (last.toolName === "inspect_worker")
          return fauxAssistantMessage("inspected filtered output");
      }
      throw new Error(`unexpected context: ${JSON.stringify(context.messages)}`);
    };

    fixture.faux.setResponses(Array.from({ length: 20 }, () => brain));

    await (await fixture.project.send("start-inspect-test")).wait(BACKGROUND_CONTEXT);

    await waitFor(
      async () => (await fixture.project.listWorkerTasks("w1", { status: "active" })).length === 1,
      "active task listed",
    );

    let streamed = "";
    const unsub = await fixture.project.subscribeWorkerTaskOutput("w1", "1", (chunk) => {
      streamed += chunk;
    });
    assert.ok(unsub !== undefined);

    await waitFor(
      async () =>
        (await fixture.project.listWorkerTasks("w1", { status: "finished" })).length === 1,
      "task completed",
    );
    unsub();
    await fixture.project.root.waitForIdle(BACKGROUND_CONTEXT);
    assert.ok(streamed.includes("MATCH_HERE"), streamed);

    await (await fixture.project.send("inspect-prefix-filter")).wait(BACKGROUND_CONTEXT);
    const rootEntries = await entries(fixture.project.root);
    const inspectResult = rootEntries.find((entry) => {
      if (entry.kind !== "pi.tool-result") return false;
      const first = entry.model?.[0];
      return first?.role === "toolResult" && first.toolName === "inspect_worker";
    });
    assert.ok(inspectResult);
    const resultStr = JSON.stringify(inspectResult.model ?? []);
    assert.ok(resultStr.includes("1- line1"), resultStr);
    assert.ok(resultStr.includes("2: MATCH_HERE"), resultStr);
    assert.ok(resultStr.includes("3- line3"), resultStr);
  } finally {
    await closeFixture(fixture);
  }
});
