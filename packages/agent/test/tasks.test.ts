import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { Conversation, ConversationId, EntryRecord, TaskId } from "@earendil-works/pi-durable";
import { ExecutionError, err } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createCachedCompactionExtension } from "../src/extensions/cached-compaction/index.ts";
import { createCodingToolsExtension } from "../src/extensions/coding-tools/index.ts";
import {
  type BackgroundTaskRecord,
  clampReadBytes,
  createTasksExtension,
  getConversationTask,
  listConversationTasks,
  type RunningCommand,
  readOutputFileSlice,
  sliceOutputText,
  sliceRetainedOutput,
  startCommand,
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

    const record = await waitForRecord(th, conversation.id, "task-1", "completed");
    assert.equal(record.exitCode, 0);
    assert.equal(record.shell, "bash");
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

    const record = await waitForRecord(th, conversation.id, "task-1", "completed");
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

    const record = await waitForRecord(th, conversation.id, "task-1", "cancelled");
    assert.equal(record.cancelReason, "tool");
    assert.ok(record.endedAt !== undefined);
    const log = await manager.readOutput(conversation.id, "task-1", record, {});
    assert.ok(log.text.includes("listed-output"), log.text);
    const kill = results.find(
      (entry) => entry.toolName === "tasks" && resultText(entry).includes("cancelled"),
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
    await waitForRecord(th, conversation.id, "task-1", "completed");
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
    const record = await waitForRecord(th, conversation.id, "task-1", "cancelled");
    assert.equal(record.cancelReason, "abort");
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
    const record = await waitForRecord(th, conversation.id, "task-1", "completed");
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

test("powershell tool wraps foreground and background execution and fails preflight when unavailable", async () => {
  const unavailableTh = await createTestHarness({
    extensions: [
      createCodingToolsExtension({ powerShell: true }),
      createTasksExtension({ resolvePowerShell: async () => undefined }),
    ],
  });
  try {
    unavailableTh.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("powershell", { command: "Write-Output nope", background: true })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("ok"),
    ]);
    const conv = await unavailableTh.createConversation();
    const sub = await conv.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
    await sub.wait(BACKGROUND_CONTEXT);
    const results = await toolResults(conv);
    const ps = results.find((entry) => entry.toolName === "powershell");
    assert.ok(ps);
    assert.equal(ps.isError, true);
    assert.match(resultText(ps), /PowerShell.*unavailable/i);
    const board = await unavailableTh.harness.snapshot(TasksBoardDoc, conv.id, BACKGROUND_CONTEXT);
    assert.equal(board === undefined || board.order.length === 0, true);
  } finally {
    await unavailableTh.cleanup();
  }

  const manager = new TaskManager();
  const th = await createTestHarness({
    extensions: [
      createCodingToolsExtension({ powerShell: true }),
      createTasksExtension({
        manager,
        resolvePowerShell: async () => ({
          executable: process.execPath,
          kind: "pwsh",
          buildArgs: (cmd) => ["-e", cmd],
        }),
      }),
    ],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("powershell", {
            command: "console.log('ps-bg-hello')",
            background: true,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("started ps"),
      fauxAssistantMessage("noted ps"),
    ]);
    const conversation = await th.createConversation();
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const record = await waitForRecord(th, conversation.id, "task-1", "completed");
    assert.equal(record.shell, "powershell");
    assert.equal(record.exitCode, 0);
    await waitFor(() => hasNotification(conversation), "ps notification");
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
    const output = await manager.readOutput(conversation.id, "task-1", record, {});
    assert.ok(output.text.includes("ps-bg-hello"), output.text);
  } finally {
    await manager.close();
    await th.cleanup();
  }
});

test("background:true preflight returns inline error when command fails immediately without phantom task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-tasks-preflight-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  env.exec = async () => err(new ExecutionError("spawn_error", "immediate spawn failure"));

  const manager = new TaskManager();
  const th = await createTestHarness({
    env,
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager })],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "bad-cmd", background: true })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("handled"),
    ]);
    const conversation = await th.createConversation();
    const sub = await conversation.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
    await sub.wait(BACKGROUND_CONTEXT);
    const results = await toolResults(conversation);
    const bash = results.find((entry) => entry.toolName === "bash");
    assert.ok(bash);
    assert.equal(bash.isError, true);
    assert.match(resultText(bash), /immediate spawn failure/);
    const tasks = await listConversationTasks(th.harness, conversation.id, BACKGROUND_CONTEXT);
    assert.equal(tasks.length, 0);
  } finally {
    await manager.close();
    await th.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("TaskManager enforces maxActivePerConversation and maxActiveTotal admission limits", async () => {
  const manager = new TaskManager({ maxActivePerConversation: 2, maxActiveTotal: 3 });
  const th = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager })],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 60", background: true })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 60", background: true })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 60", background: true })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("limit seen"),
    ]);
    const conv1 = await th.createConversation();
    const sub1 = await conv1.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
    await sub1.wait(BACKGROUND_CONTEXT);
    const results1 = await toolResults(conv1);
    const bashResults = results1.filter((entry) => entry.toolName === "bash").reverse();
    assert.equal(bashResults.length, 3);
    assert.equal(bashResults[0]?.isError, false);
    assert.equal(bashResults[1]?.isError, false);
    assert.equal(bashResults[2]?.isError, true);
    assert.match(resultText(bashResults[2] as ToolResultEntry), /active limit/i);
    assert.match(resultText(bashResults[2] as ToolResultEntry), /task-1/);
    assert.match(resultText(bashResults[2] as ToolResultEntry), /task-2/);

    th.faux.appendResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 60", background: true })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 60", background: true })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("total limit seen"),
    ]);
    const conv2 = await th.createConversation();
    const sub2 = await conv2.submit({ type: "input", content: "go2" }, BACKGROUND_CONTEXT);
    await sub2.wait(BACKGROUND_CONTEXT);
    const results2 = await toolResults(conv2);
    const conv2Bash = results2.filter((entry) => entry.toolName === "bash").reverse();
    assert.equal(conv2Bash[0]?.isError, false);
    assert.equal(conv2Bash[1]?.isError, true);
    assert.match(resultText(conv2Bash[1] as ToolResultEntry), /total active limit/i);
  } finally {
    await manager.close();
    await th.cleanup();
  }
});

test("finished history eviction keeps maxFinishedPerConversation and removes evicted log files", async () => {
  const logRoot = await mkdtemp(join(tmpdir(), "eevee-tasks-evict-"));
  const manager = new TaskManager({
    maxFinishedPerConversation: 2,
    logPath: (conversationId, taskId) => join(logRoot, `${conversationId}-${taskId}.log`),
  });
  const th = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager })],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo one", background: true })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("s1"),
      fauxAssistantMessage("n1"),
    ]);
    const conv = await th.createConversation();
    await (await conv.submit({ type: "input", content: "1" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    const rec1 = await waitForRecord(th, conv.id, "task-1", "completed");
    await conv.waitForIdle(BACKGROUND_CONTEXT);
    assert.ok(rec1.logPath && existsSync(rec1.logPath));

    th.faux.appendResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo two", background: true })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("s2"),
      fauxAssistantMessage("n2"),
    ]);
    await (await conv.submit({ type: "input", content: "2" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    await waitForRecord(th, conv.id, "task-2", "completed");
    await conv.waitForIdle(BACKGROUND_CONTEXT);

    th.faux.appendResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo three", background: true })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("s3"),
      fauxAssistantMessage("n3"),
    ]);
    await (await conv.submit({ type: "input", content: "3" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    const rec3 = await waitForRecord(th, conv.id, "task-3", "completed");
    if (rec3.durableTaskId !== undefined) {
      await th.harness.waitForTask(rec3.durableTaskId as TaskId, BACKGROUND_CONTEXT);
    }
    await conv.waitForIdle(BACKGROUND_CONTEXT);

    const remaining = await listConversationTasks(th.harness, conv.id, BACKGROUND_CONTEXT);
    assert.deepEqual(
      remaining.map((r) => r.id),
      ["task-2", "task-3"],
    );
    assert.equal(existsSync(rec1.logPath), false, "evicted task log file should be deleted");
  } finally {
    await manager.close();
    await th.cleanup();
    await rm(logRoot, { recursive: true, force: true });
  }
});

test("log cap enforces truncate and fail policies and surfaces log errors", async () => {
  const truncRoot = await mkdtemp(join(tmpdir(), "eevee-tasks-cap-trunc-"));
  const truncMgr = new TaskManager({
    maxLogBytes: 80,
    logOverflowPolicy: "truncate",
    logPath: (convId, taskId) => join(truncRoot, `${convId}-${taskId}.log`),
  });
  const truncTh = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager: truncMgr })],
  });
  try {
    truncTh.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", {
            command: "node -e \"console.log('x'.repeat(300))\"",
            background: true,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("started"),
      fauxAssistantMessage("noted"),
    ]);
    const conv = await truncTh.createConversation();
    await (await conv.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    const rec = await waitForRecord(truncTh, conv.id, "task-1", "completed");
    assert.equal(rec.logTruncated, true);
    assert.equal(rec.logError, undefined);
    assert.ok(rec.logPath);
    const disk = await readFile(rec.logPath, "utf8");
    assert.ok(disk.includes("[output truncated at 80B limit]"), disk);
    await conv.waitForIdle(BACKGROUND_CONTEXT);
    const entries = await conversationEntries(conv);
    const note = entries.find((e) => e.kind === TASK_NOTIFICATION_ENTRY_KIND);
    assert.ok(JSON.stringify(note?.model ?? []).includes("truncated"));
  } finally {
    await truncMgr.close();
    await truncTh.cleanup();
    await rm(truncRoot, { recursive: true, force: true });
  }

  const failRoot = await mkdtemp(join(tmpdir(), "eevee-tasks-cap-fail-"));
  const failMgr = new TaskManager({
    maxLogBytes: 64,
    logOverflowPolicy: "fail",
    logPath: (convId, taskId) => join(failRoot, `${convId}-${taskId}.log`),
  });
  const failTh = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager: failMgr })],
  });
  try {
    failTh.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", {
            command: "node -e \"setInterval(() => console.log('overflow_chunk_line'), 20)\"",
            background: true,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("started"),
      fauxAssistantMessage("saw overflow failure"),
    ]);
    const conv = await failTh.createConversation();
    await (await conv.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    const rec = await waitForRecord(failTh, conv.id, "task-1", "failed");
    assert.equal(rec.logError, "Output exceeded background log size limit");
    assert.equal(rec.error, "Output exceeded background log size limit");
    await waitFor(() => hasNotification(conv), "overflow fail notification");
    await conv.waitForIdle(BACKGROUND_CONTEXT);
  } finally {
    await failMgr.close();
    await failTh.cleanup();
    await rm(failRoot, { recursive: true, force: true });
  }

  const errRoot = await mkdtemp(join(tmpdir(), "eevee-tasks-logerr-"));
  const blockingFile = join(errRoot, "not-a-dir");
  await writeFile(blockingFile, "x");
  const errMgr = new TaskManager({
    logPath: (convId, taskId) => join(blockingFile, `${convId}-${taskId}.log`),
  });
  const errTh = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager: errMgr })],
  });
  try {
    errTh.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: "echo log-error-ok", background: true })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("started"),
      fauxAssistantMessage("noted error"),
    ]);
    const conv = await errTh.createConversation();
    await (await conv.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    const rec = await waitForRecord(errTh, conv.id, "task-1", "completed");
    assert.ok(rec.logError !== undefined && rec.logError.length > 0);
    await waitFor(() => hasNotification(conv), "log error notification");
    await conv.waitForIdle(BACKGROUND_CONTEXT);
    const entries = await conversationEntries(conv);
    const note = entries.find((e) => e.kind === TASK_NOTIFICATION_ENTRY_KIND);
    assert.ok(JSON.stringify(note?.model ?? []).includes("log write failed"));
  } finally {
    await errMgr.close();
    await errTh.cleanup();
    await rm(errRoot, { recursive: true, force: true });
  }
});

test("tasks list filters by status/limit and tasks read/kill accept prefixes and search filters", async () => {
  const manager = new TaskManager();
  const th = await createTestHarness({
    extensions: [createCodingToolsExtension(), createTasksExtension({ manager })],
  });
  try {
    th.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: "echo alpha && echo BETA_HIT", background: true })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("started first"),
      fauxAssistantMessage("first done"),
    ]);
    const conv = await th.createConversation();
    await (await conv.submit({ type: "input", content: "1" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    await waitForRecord(th, conv.id, "task-1", "completed");
    await conv.waitForIdle(BACKGROUND_CONTEXT);

    th.faux.appendResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo two", background: true })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("started two"),
      fauxAssistantMessage("two done"),
    ]);
    await (await conv.submit({ type: "input", content: "2" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    await waitForRecord(th, conv.id, "task-2", "completed");
    await conv.waitForIdle(BACKGROUND_CONTEXT);

    th.faux.appendResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 60", background: true })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        [fauxToolCall("tasks", { action: "list", status: "finished", limit: 1 })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxToolCall("tasks", { action: "list", status: "active" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        [fauxToolCall("tasks", { action: "read", taskId: "1", filter: "beta", contextLines: 1 })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxToolCall("tasks", { action: "kill", taskId: "3" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("all done"),
    ]);
    await (await conv.submit({ type: "input", content: "3" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    const results = await toolResults(conv);
    const listFinished = results.find(
      (r) => r.toolName === "tasks" && resultText(r).includes("1 older finished omitted"),
    );
    assert.ok(listFinished);
    assert.ok(resultText(listFinished).includes("task-2"));
    assert.equal(resultText(listFinished).includes("task-1"), false);

    const listActive = results.find(
      (r) =>
        r.toolName === "tasks" &&
        resultText(r).includes("task-3") &&
        !resultText(r).includes("task-2"),
    );
    assert.ok(listActive);

    const filteredRead = results.find(
      (r) => r.toolName === "tasks" && resultText(r).includes("BETA_HIT"),
    );
    assert.ok(filteredRead);
    assert.ok(resultText(filteredRead).includes("1- alpha"), resultText(filteredRead));
    assert.ok(resultText(filteredRead).includes("2: BETA_HIT"), resultText(filteredRead));

    const killed3 = await waitForRecord(th, conv.id, "task-3", "cancelled");
    assert.equal(killed3.cancelReason, "tool");
  } finally {
    await manager.close();
    await th.cleanup();
  }
});

test("post-compaction active-task reminder is injected once per compaction and not persisted", async () => {
  const manager = new TaskManager();
  const capturedRequests: TranscriptContext[] = [];
  const th = await createTestHarness({
    extensions: [
      createCodingToolsExtension(),
      createTasksExtension({ manager }),
      createCachedCompactionExtension(),
    ],
    settings: {
      compaction: {
        enabled: true,
        keepRecentTokens: 15,
        reserveTokens: 1000,
        backgroundTokens: 0,
      },
    },
  });
  try {
    let stage = 0;
    th.faux.setResponses([
      (ctx) => {
        capturedRequests.push(ctx);
        stage += 1;
        return fauxAssistantMessage("First turn response with plenty of tokens to compact later.");
      },
      (ctx) => {
        capturedRequests.push(ctx);
        stage += 1;
        return fauxAssistantMessage(
          [fauxToolCall("bash", { command: "sleep 60", background: true })],
          { stopReason: "toolUse" },
        );
      },
      (ctx) => {
        capturedRequests.push(ctx);
        stage += 1;
        return fauxAssistantMessage("Background task started and running.");
      },
      () => fauxAssistantMessage("## Goal\nCompacted summary before reminder."),
      (ctx) => {
        capturedRequests.push(ctx);
        stage += 1;
        return fauxAssistantMessage("Turn after compaction acknowledging reminder.");
      },
      (ctx) => {
        capturedRequests.push(ctx);
        stage += 1;
        return fauxAssistantMessage("Second turn after compaction.");
      },
    ]);

    const conv = await th.createConversation();
    await (await conv.submit({ type: "input", content: "turn one" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    await (await conv.submit({ type: "input", content: "start bg" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    await waitForRecord(th, conv.id, "task-1", "running");

    const compactTaskId = await conv.compact(undefined, BACKGROUND_CONTEXT);
    await th.harness.waitForTask(compactTaskId, BACKGROUND_CONTEXT);
    await conv.waitForIdle(BACKGROUND_CONTEXT);

    await (
      await conv.submit({ type: "input", content: "continue after compact" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    await (
      await conv.submit({ type: "input", content: "second turn after compact" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);

    assert.equal(stage, 5);
    const firstPostCompact = capturedRequests[3];
    const secondPostCompact = capturedRequests[4];
    assert.ok(firstPostCompact);
    assert.ok(secondPostCompact);

    const hasReminder = (ctx: TranscriptContext) =>
      ctx.messages.some(
        (m) =>
          m.role === "user" &&
          JSON.stringify(m.content).includes("Active background tasks from before compaction"),
      );
    assert.equal(
      hasReminder(firstPostCompact),
      true,
      "first post-compaction request gets reminder",
    );
    assert.equal(
      hasReminder(secondPostCompact),
      false,
      "reminder is one-shot per compaction and not persisted in transcript",
    );

    const transcript = await conversationEntries(conv);
    assert.equal(
      transcript.some((e) =>
        JSON.stringify(e.model ?? []).includes("Active background tasks from before compaction"),
      ),
      false,
      "reminder must not be persisted to transcript",
    );
  } finally {
    await manager.close();
    await th.cleanup();
  }
});

test("TaskManager subscribeOutput streams live chunks and close() drains cleanly", async () => {
  const manager = new TaskManager();
  const dir = await mkdtemp(join(tmpdir(), "eevee-tasks-sub-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  try {
    const th = await createTestHarness({
      env,
      extensions: [createCodingToolsExtension(), createTasksExtension({ manager })],
    });
    try {
      th.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("bash", {
              command: "node -e \"setTimeout(() => console.log('live-chunk-hello'), 100)\"",
              background: true,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("started"),
        fauxAssistantMessage("done"),
      ]);
      const conv = await th.createConversation();
      await (await conv.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT)).wait(
        BACKGROUND_CONTEXT,
      );

      let chunks = "";
      const unsub = manager.subscribeOutput(conv.id, "task-1", (chunk) => {
        chunks += chunk;
      });
      assert.ok(unsub !== undefined);
      await waitForRecord(th, conv.id, "task-1", "completed");
      await conv.waitForIdle(BACKGROUND_CONTEXT);
      unsub();
      assert.ok(chunks.includes("live-chunk-hello"), chunks);
      assert.equal(
        manager.subscribeOutput(conv.id, "task-1", () => {}),
        undefined,
      );
    } finally {
      await manager.close(500);
      await th.cleanup();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TaskManager eviction and close() clear #memoryLogs and #logStates", async () => {
  const logRoot = await mkdtemp(join(tmpdir(), "eevee-tasks-memevict-"));
  const manager = new TaskManager({
    maxFinishedPerConversation: 2,
    maxLogBytes: 32,
    logOverflowPolicy: "truncate",
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
            command: "node -e \"console.log('first-' + 'a'.repeat(80))\"",
            background: true,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("s1"),
      fauxAssistantMessage("n1"),
    ]);
    const conv = await th.createConversation();
    await (await conv.submit({ type: "input", content: "1" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    const rec1 = await waitForRecord(th, conv.id, "task-1", "completed");
    await conv.waitForIdle(BACKGROUND_CONTEXT);

    assert.equal(rec1.logTruncated, true);
    assert.equal(manager.logStatus(conv.id, "task-1").logTruncated, true);
    const memBefore = await manager.readOutput(conv.id, "task-1", { ...rec1, logPath: undefined });
    assert.ok(memBefore.text.includes("first-"));
    assert.ok(memBefore.totalBytes > 0);

    th.faux.appendResponses([
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: "echo second-retained", background: true })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("s2"),
      fauxAssistantMessage("n2"),
    ]);
    await (await conv.submit({ type: "input", content: "2" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    const rec2 = await waitForRecord(th, conv.id, "task-2", "completed");
    await conv.waitForIdle(BACKGROUND_CONTEXT);

    th.faux.appendResponses([
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: "echo third-retained", background: true })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("s3"),
      fauxAssistantMessage("n3"),
    ]);
    await (await conv.submit({ type: "input", content: "3" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    const rec3 = await waitForRecord(th, conv.id, "task-3", "completed");
    if (rec3.durableTaskId !== undefined) {
      await th.harness.waitForTask(rec3.durableTaskId as TaskId, BACKGROUND_CONTEXT);
    }
    await conv.waitForIdle(BACKGROUND_CONTEXT);

    const evictedSlice = await manager.readOutput(conv.id, "task-1", {
      ...rec1,
      logPath: undefined,
    });
    assert.deepEqual(evictedSlice, {
      text: "",
      totalBytes: 0,
      truncated: false,
      fromByte: 0,
      endByte: 0,
    });
    assert.deepEqual(manager.logStatus(conv.id, "task-1"), { logTruncated: false });

    const keptSlice = await manager.readOutput(conv.id, "task-2", { ...rec2, logPath: undefined });
    assert.ok(keptSlice.text.includes("second-retained"));

    await manager.close();
    const afterCloseSlice = await manager.readOutput(conv.id, "task-2", {
      ...rec2,
      logPath: undefined,
    });
    assert.deepEqual(afterCloseSlice, {
      text: "",
      totalBytes: 0,
      truncated: false,
      fromByte: 0,
      endByte: 0,
    });
    assert.deepEqual(manager.logStatus(conv.id, "task-2"), { logTruncated: false });
  } finally {
    await manager.close();
    await th.cleanup();
    await rm(logRoot, { recursive: true, force: true });
  }
});

test("TaskManager.readOutput reads pre-retained disk bytes when a running task has droppedBytes > 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-tasks-disk-fallback-"));
  const manager = new TaskManager();
  try {
    const convId = 1 as ConversationId;
    const taskId = "task-1";
    const logPath = join(dir, "running.log");
    const earlyPart = `early-line-1\nEARLY_FILTER_HIT\n${"m".repeat(800)}\n`;
    const retainedPart = "retained-tail-line\n";
    const fullText = `${earlyPart}${retainedPart}`;
    await writeFile(logPath, fullText, "utf8");

    const droppedBytes = Buffer.byteLength(earlyPart, "utf8");
    const totalBytes = Buffer.byteLength(fullText, "utf8");
    const running: RunningCommand = {
      shell: "bash",
      command: "stream-lots",
      rewrittenNul: false,
      settled: false,
      ready: Promise.resolve(),
      killed: false,
      done: new Promise(() => {}),
      output: () => ({ text: retainedPart, totalBytes, droppedBytes }),
      onOutput: () => () => {},
      kill: () => {},
      detachCancel: () => {},
    };
    manager.attach(convId, taskId, running);

    const record: BackgroundTaskRecord = {
      id: taskId,
      command: "stream-lots",
      status: "running",
      startedAt: 1,
      logPath,
    };

    const head = await manager.readOutput(convId, taskId, record, { mode: "head", bytes: 256 });
    assert.equal(head.fromByte, 0);
    assert.ok(head.text.startsWith("early-line-1\nEARLY_FILTER_HIT\n"), head.text);

    const filtered = await manager.readOutput(convId, taskId, record, {
      filter: "EARLY_FILTER_HIT",
    });
    assert.equal(filtered.matchedLines, 1);
    assert.ok(filtered.text.includes("2: EARLY_FILTER_HIT"), filtered.text);

    const pagedTail = await manager.readOutput(convId, taskId, record, {
      mode: "tail",
      bytes: 256,
      endByte: 300,
    });
    assert.ok(pagedTail.endByte <= 300);
    assert.ok(pagedTail.text.length > 0);

    const liveTail = await manager.readOutput(convId, taskId, record, {
      mode: "tail",
      sinceBytes: droppedBytes,
      bytes: 256,
    });
    assert.equal(liveTail.fromByte, droppedBytes);
    assert.equal(liveTail.text, retainedPart);

    await rm(logPath, { force: true });
    const fallbackHead = await manager.readOutput(convId, taskId, record, {
      mode: "head",
      bytes: 256,
    });
    assert.equal(fallbackHead.fromByte, droppedBytes);
    assert.equal(fallbackHead.text, "");
  } finally {
    manager.killAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("startCommand separates kill(reason) from detachCancel() and settles ready on immediate errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-tasks-kill-ready-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  try {
    env.exec = async () => err(new ExecutionError("spawn_error", "fast fail"));
    const immediate = startCommand(env, { command: "fast-fail" });
    await immediate.ready;
    assert.equal(immediate.settled, true);
    assert.deepEqual(await immediate.done, {
      kind: "error",
      code: "spawn_error",
      message: "fast fail",
    });

    env.exec = (_cmd, _opts, context) =>
      new Promise((resolve) => {
        context.abortSignal?.addEventListener(
          "abort",
          () => resolve(err(new ExecutionError("aborted", "aborted"))),
          { once: true },
        );
      });

    const detached = startCommand(env, { command: "stay-open" });
    await detached.ready;
    assert.equal(detached.settled, false);
    detached.detachCancel();
    assert.deepEqual(await detached.done, {
      kind: "error",
      code: "aborted",
      message: "aborted",
    });
    assert.equal(detached.killed, false);

    const userKilled = startCommand(env, { command: "stay-open" });
    await userKilled.ready;
    userKilled.kill("user");
    assert.deepEqual(await userKilled.done, {
      kind: "error",
      code: "aborted",
      message: "aborted",
    });
    assert.equal(userKilled.killed, true);
    assert.equal(userKilled.killReason, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
