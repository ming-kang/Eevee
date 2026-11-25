import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Conversation, ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createCodingToolsExtension } from "../src/extensions/coding-tools/index.ts";
import {
  type BackgroundTaskRecord,
  clampReadBytes,
  createTasksExtension,
  getConversationTask,
  readOutputFileSlice,
  sliceOutputText,
  sliceRetainedOutput,
  TASK_NOTIFICATION_ENTRY_KIND,
  TASK_READ_DEFAULT_BYTES,
  TASK_READ_MAX_BYTES,
  TASK_READ_MIN_BYTES,
  TaskManager,
  TasksBoardDoc,
} from "../src/extensions/tasks/index.ts";
import { createTestHarness, type TestHarness } from "./harness.ts";

type ToolResultEntry = {
  toolName?: string;
  isError?: boolean;
  content?: unknown;
};

async function toolResults(conversation: Conversation): Promise<ToolResultEntry[]> {
  const entries = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
  const results: ToolResultEntry[] = [];
  for (const entry of entries.items) {
    if (entry.kind !== "pi.tool-result") continue;
    const model = (entry as { model?: unknown[] }).model;
    const first = Array.isArray(model) ? (model[0] as ToolResultEntry) : undefined;
    if (first !== undefined) results.push(first);
  }
  return results;
}

function resultText(result: ToolResultEntry): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}

async function conversationEntries(conversation: Conversation): Promise<EntryRecord[]> {
  const entries = await conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT);
  return [...entries.items];
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function taskRecord(
  th: TestHarness,
  conversationId: ConversationId,
  taskId: string,
): Promise<BackgroundTaskRecord | undefined> {
  return getConversationTask(th.harness, conversationId, taskId, BACKGROUND_CONTEXT);
}

async function waitForRecord(
  th: TestHarness,
  conversationId: ConversationId,
  taskId: string,
  status: BackgroundTaskRecord["status"],
): Promise<BackgroundTaskRecord> {
  let record: BackgroundTaskRecord | undefined;
  await waitFor(async () => {
    record = await taskRecord(th, conversationId, taskId);
    return record?.status === status;
  }, `task ${taskId} to be ${status}`);
  assert.ok(record);
  return record;
}

async function hasNotification(conversation: Conversation): Promise<boolean> {
  const entries = await conversationEntries(conversation);
  return entries.some((entry) => entry.kind === TASK_NOTIFICATION_ENTRY_KIND);
}

test("clampReadBytes applies the read window bounds", () => {
  assert.equal(clampReadBytes(undefined), TASK_READ_DEFAULT_BYTES);
  assert.equal(clampReadBytes(Number.NaN), TASK_READ_DEFAULT_BYTES);
  assert.equal(clampReadBytes(5), TASK_READ_MIN_BYTES);
  assert.equal(clampReadBytes(100_000), TASK_READ_MAX_BYTES);
  assert.equal(clampReadBytes(1000), 1000);
});

test("sliceOutputText slices head and tail within the clamped window", () => {
  const text = "x".repeat(1000);
  const tail = sliceOutputText(text);
  assert.deepEqual(tail, {
    text,
    totalBytes: 1000,
    truncated: false,
    fromByte: 0,
    endByte: 1000,
  });
  const head = sliceOutputText(text, { mode: "head", bytes: 300 });
  assert.equal(head.text, "x".repeat(300));
  assert.equal(head.fromByte, 0);
  assert.equal(head.endByte, 300);
  assert.equal(head.truncated, true);
  const tailSlice = sliceOutputText(text, { mode: "tail", bytes: 300 });
  assert.equal(tailSlice.text, "x".repeat(300));
  assert.equal(tailSlice.fromByte, 700);
  assert.equal(tailSlice.endByte, 1000);
  assert.equal(tailSlice.truncated, true);
});

test("sliceOutputText reads incrementally with sinceBytes", () => {
  const text = "y".repeat(600);
  const first = sliceOutputText(text, { mode: "head", bytes: 256 });
  assert.equal(first.endByte, 256);
  const second = sliceOutputText(text, { mode: "tail", sinceBytes: first.endByte });
  assert.equal(second.fromByte, 256);
  assert.equal(second.endByte, 600);
  assert.equal(second.text, "y".repeat(344));
  assert.equal(second.truncated, false);
  const done = sliceOutputText(text, { mode: "tail", sinceBytes: second.endByte });
  assert.deepEqual(done, {
    text: "",
    totalBytes: 600,
    truncated: false,
    fromByte: 600,
    endByte: 600,
  });
  const invalidCursor = sliceOutputText(text, { mode: "head", bytes: 256, sinceBytes: Number.NaN });
  assert.equal(invalidCursor.fromByte, 0);
  assert.equal(invalidCursor.endByte, 256);
});

test("sliceOutputText never splits a multi-byte codepoint", () => {
  const text = `${"a".repeat(300)}€${"b".repeat(300)}`;
  const tail = sliceOutputText(text, { mode: "tail", bytes: 301 });
  assert.equal(tail.fromByte, 303);
  assert.equal(tail.endByte, 603);
  assert.equal(tail.text, "b".repeat(300));
  assert.equal(tail.truncated, true);
  const head = sliceOutputText(text, { mode: "head", bytes: 302 });
  assert.equal(head.fromByte, 0);
  assert.equal(head.endByte, 300);
  assert.equal(head.text, "a".repeat(300));
  assert.equal(head.truncated, true);
});

test("sliceRetainedOutput accounts for bytes dropped before the retained range", () => {
  const retained = Buffer.from("r".repeat(100), "utf8");
  const slice = sliceRetainedOutput(retained, 500, 600, { mode: "tail", bytes: 300 });
  assert.equal(slice.fromByte, 500);
  assert.equal(slice.endByte, 600);
  assert.equal(slice.text, "r".repeat(100));
  assert.equal(slice.truncated, true);
});

test("readOutputFileSlice reads windows and aligns boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-tasks-test-"));
  try {
    const file = join(dir, "out.log");
    await writeFile(file, `${"a".repeat(300)}€${"b".repeat(300)}`);
    const tail = await readOutputFileSlice(file, { mode: "tail", bytes: 301 });
    assert.equal(tail.fromByte, 303);
    assert.equal(tail.endByte, 603);
    assert.equal(tail.text, "b".repeat(300));
    assert.equal(tail.totalBytes, 603);
    const head = await readOutputFileSlice(file, { mode: "head", bytes: 302 });
    assert.equal(head.text, "a".repeat(300));
    assert.equal(head.endByte, 300);
    const empty = await readOutputFileSlice(file, { mode: "tail", sinceBytes: 603 });
    assert.deepEqual(empty, {
      text: "",
      totalBytes: 603,
      truncated: false,
      fromByte: 603,
      endByte: 603,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("foreground bash under backgroundAfterMs completes inline and touches no board", async () => {
  const th = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ backgroundAfterMs: 60_000 })],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo fg-output" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const results = await toolResults(conversation);
    const bash = results.find((entry) => entry.toolName === "bash");
    assert.ok(bash);
    assert.equal(bash.isError, false);
    assert.ok(resultText(bash).includes("fg-output"));
    const board = await th.harness.snapshot(TasksBoardDoc, conversation.id, BACKGROUND_CONTEXT);
    assert.equal(board === undefined || board.order.length === 0, true);
  } finally {
    await th.cleanup();
  }
});

test("foreground bash nonzero exit is an error result with the exit code", async () => {
  const th = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ backgroundAfterMs: 60_000 })],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo partial-out && exit 7" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const results = await toolResults(conversation);
    const bash = results.find((entry) => entry.toolName === "bash");
    assert.ok(bash);
    assert.equal(bash.isError, true);
    const text = resultText(bash);
    assert.ok(text.includes("partial-out"), text);
    assert.ok(text.includes("code 7"), text);
  } finally {
    await th.cleanup();
  }
});

test("bash background:true returns a taskId, then wakes the conversation on completion", async () => {
  const manager = new TaskManager();
  const th = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager })],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: "echo bg-output", background: true })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("started"),
      fauxAssistantMessage("task noted"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const results = await toolResults(conversation);
    const bash = results.find((entry) => entry.toolName === "bash");
    assert.ok(bash);
    assert.equal(bash.isError, false);
    assert.match(resultText(bash), /task-1/);

    const record = await waitForRecord(th, conversation.id, "task-1", "exited");
    assert.equal(record.exitCode, 0);
    assert.equal(record.command, "echo bg-output");
    await waitFor(() => hasNotification(conversation), "task notification entry");
    await conversation.waitForIdle(BACKGROUND_CONTEXT);

    const entries = await conversationEntries(conversation);
    const notification = entries.find((entry) => entry.kind === TASK_NOTIFICATION_ENTRY_KIND);
    assert.ok(notification);
    const modelText = JSON.stringify(notification.model ?? []);
    assert.ok(modelText.includes("bg-output"), modelText);
    assert.ok(modelText.includes("task-1"), modelText);

    const read = await manager.readOutput(conversation.id, "task-1", record, {});
    assert.ok(read.text.includes("bg-output"));
    assert.equal(th.faux.state.callCount, 3);
  } finally {
    manager.killAll();
    await th.cleanup();
  }
});

test("foreground bash hands off to a background task after backgroundAfterMs", async () => {
  const manager = new TaskManager();
  const th = await createTestHarness({
    extensions: [
      createCodingToolsExtension(),
      createTasksExtension({ manager, backgroundAfterMs: 1500 }),
    ],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", {
            command:
              'echo before-handoff && node -e "setTimeout(() => {}, 3500)" && echo after-handoff',
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("moved"),
      fauxAssistantMessage("task done"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const results = await toolResults(conversation);
    const bash = results.find((entry) => entry.toolName === "bash");
    assert.ok(bash);
    assert.equal(bash.isError, false);
    const text = resultText(bash);
    assert.ok(text.includes("before-handoff"), text);
    assert.ok(text.includes("task-1"), text);

    const record = await waitForRecord(th, conversation.id, "task-1", "exited");
    assert.equal(record.exitCode, 0);
    const read = await manager.readOutput(conversation.id, "task-1", record, {});
    assert.ok(read.text.includes("before-handoff"), read.text);
    assert.ok(read.text.includes("after-handoff"), read.text);
    await waitFor(() => hasNotification(conversation), "task notification entry");
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
  } finally {
    manager.killAll();
    await th.cleanup();
  }
});

test("tasks tool lists, reads incrementally, and kills background tasks", async () => {
  const manager = new TaskManager();
  const th = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager })],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: "echo listed-output && sleep 60", background: true })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxToolCall("tasks", { action: "list" })], { stopReason: "toolUse" }),
      fauxAssistantMessage(
        [fauxToolCall("tasks", { action: "read", taskId: "task-1", mode: "head" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxToolCall("tasks", { action: "kill", taskId: "task-1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("wrapped up"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const results = await toolResults(conversation);
    const list = results.find(
      (entry) => entry.toolName === "tasks" && resultText(entry).includes("Background tasks"),
    );
    assert.ok(list);
    assert.equal(list.isError, false);
    assert.ok(resultText(list).includes("task-1"), resultText(list));
    assert.ok(resultText(list).includes("running"), resultText(list));

    const read = results.find(
      (entry) => entry.toolName === "tasks" && resultText(entry).includes("task task-1 —"),
    );
    assert.ok(read);
    assert.ok(resultText(read).includes("next sinceBytes:"), resultText(read));

    const record = await waitForRecord(th, conversation.id, "task-1", "killed");
    assert.ok(record.endedAt !== undefined);
    const log = await manager.readOutput(conversation.id, "task-1", record, {});
    assert.ok(log.text.includes("listed-output"), log.text);
    const kill = results.find(
      (entry) => entry.toolName === "tasks" && resultText(entry).includes("killed"),
    );
    assert.ok(kill);
    assert.equal(kill.isError, false);
    assert.equal(await hasNotification(conversation), false);
    assert.equal(th.faux.state.callCount, 5);
  } finally {
    manager.killAll();
    await th.cleanup();
  }
});

test("tasks tool reports errors for missing, unknown, and ended taskIds", async () => {
  const manager = new TaskManager();
  const th = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager })],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("tasks", { action: "read" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("tasks", { action: "kill", taskId: "task-99" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const results = await toolResults(conversation);
    const tasksResults = results.filter((entry) => entry.toolName === "tasks");
    assert.equal(tasksResults.length, 2);
    for (const result of tasksResults) assert.equal(result.isError, true);
    const texts = tasksResults.map((result) => resultText(result));
    assert.ok(
      texts.some((text) => text.includes("taskId")),
      texts.join("|"),
    );
    assert.ok(
      texts.some((text) => text.includes("Unknown task")),
      texts.join("|"),
    );
  } finally {
    manager.killAll();
    await th.cleanup();
  }
});

test("killing an already-ended task is an error result", async () => {
  const manager = new TaskManager();
  const th = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager })],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo quick", background: true })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("started"),
      fauxAssistantMessage("noted"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    await waitForRecord(th, conversation.id, "task-1", "exited");
    await conversation.waitForIdle(BACKGROUND_CONTEXT);

    th.faux.appendResponses([
      fauxAssistantMessage([fauxToolCall("tasks", { action: "kill", taskId: "task-1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const second = await conversation.submit(
      { type: "input", content: "check" },
      BACKGROUND_CONTEXT,
    );
    await second.wait(BACKGROUND_CONTEXT);
    const results = await toolResults(conversation);
    const kill = results.find((entry) => entry.toolName === "tasks");
    assert.ok(kill);
    assert.equal(kill.isError, true);
    assert.ok(resultText(kill).includes("already"));
  } finally {
    manager.killAll();
    await th.cleanup();
  }
});

test("conversation.abort() spares background tasks; abort({background:true}) kills them", async () => {
  const manager = new TaskManager();
  const th = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager })],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 60", background: true })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("running it"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    await waitForRecord(th, conversation.id, "task-1", "running");

    await conversation.abort(BACKGROUND_CONTEXT);
    assert.ok(manager.get(conversation.id, "task-1") !== undefined);
    assert.equal((await taskRecord(th, conversation.id, "task-1"))?.status, "running");

    await conversation.abort(BACKGROUND_CONTEXT, { background: true });
    const record = await waitForRecord(th, conversation.id, "task-1", "killed");
    assert.ok(record.endedAt !== undefined);
    assert.equal(manager.get(conversation.id, "task-1"), undefined);
    assert.equal(await hasNotification(conversation), false);
    assert.equal(th.faux.state.callCount, 2);
  } finally {
    manager.killAll();
    await th.cleanup();
  }
});

test("a background task orphaned by a host restart recovers as interrupted", async () => {
  const storage = new MemoryStorage();
  // Harness.close() closes its storage; a reopened host would get a fresh handle
  // onto the same backend, so keep this shared instance open for the restart.
  storage.close = () => Promise.resolve();
  const manager1 = new TaskManager();
  const th1 = await createTestHarness({
    storage,
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager: manager1 })],
  });
  th1.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 600", background: true })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("running it"),
  ]);
  const first = await th1.createConversation();
  const conversationId = first.id;
  const submission = await first.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
  await waitForRecord(th1, conversationId, "task-1", "running");

  await th1.harness.close(BACKGROUND_CONTEXT);
  manager1.killAll();

  const manager2 = new TaskManager();
  const th2 = await createTestHarness({
    storage,
    env: th1.env,
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager: manager2 })],
  });
  try {
    th2.faux.setResponses([fauxAssistantMessage("recovered")]);
    th2.harness.resume();
    const record = await waitForRecord(th2, conversationId, "task-1", "interrupted");
    assert.match(record.error ?? "", /restart/i);

    const conversation = await th2.harness.conversation(conversationId, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    await waitFor(() => hasNotification(conversation), "interruption notification");
    const entries = await conversationEntries(conversation);
    const notification = entries.find((entry) => entry.kind === TASK_NOTIFICATION_ENTRY_KIND);
    const data = notification?.data as { status?: string; taskId?: string } | undefined;
    assert.equal(data?.status, "interrupted");
    assert.equal(data?.taskId, "task-1");
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
    assert.equal(th2.faux.state.callCount, 1);
  } finally {
    manager2.killAll();
    await th2.cleanup();
    await th1.cleanup();
  }
});

test("disk log mode writes the task output to a file readable after completion", async () => {
  const logRoot = await mkdtemp(join(tmpdir(), "eevee-task-logs-"));
  const manager = new TaskManager({
    logPath: (conversationId, taskId) => join(logRoot, `${conversationId}-${taskId}.log`),
  });
  const th = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager })],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", {
            command: "echo log-line-one && echo log-line-two",
            background: true,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("started"),
      fauxAssistantMessage("noted"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const record = await waitForRecord(th, conversation.id, "task-1", "exited");
    assert.ok(record.logPath !== undefined);
    const onDisk = await readFile(record.logPath, "utf8");
    assert.ok(onDisk.includes("log-line-one"), onDisk);
    assert.ok(onDisk.includes("log-line-two"), onDisk);
    assert.ok(onDisk.includes("[exited with code 0]"), onDisk);
    const slice = await manager.readOutput(conversation.id, "task-1", record, {});
    assert.ok(slice.text.includes("log-line-one"));
    const readSlice = await readOutputFileSlice(record.logPath, { mode: "tail" });
    assert.ok(readSlice.text.includes("log-line-two"));
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
  } finally {
    manager.killAll();
    await th.cleanup();
    await rm(logRoot, { recursive: true, force: true });
  }
});
