import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  type BackgroundTaskRecord,
  type RunningCommand,
  sliceRetainedOutput,
  TASK_READ_MAX_BYTES,
  TaskManager,
} from "@eevee/agent";
import type { BoardView, WorkerId as CoreWorkerId, ProjectHandle } from "@eevee/core";
import { EeveeClient, type TaskStreamEvent, type WorkerId } from "@eevee/protocol";
import { subscribeWorkerTaskStream } from "../src/engine-task-stream.ts";
import { startEngineHttpServer } from "../src/http.ts";
import { type Engine, startForegroundEngine } from "../src/index.ts";

const MODEL_ID = "faux-1";

function messageText(message: Message): string {
  if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
    return contentText(message.content);
  }
  return "";
}

function lastMessage(context: TranscriptContext): Message | undefined {
  return context.messages.findLast((message) => message.role !== "system");
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

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-task-stream-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function createStubHandle(options: {
  readonly task: BackgroundTaskRecord;
  readonly taskManager: TaskManager;
  readonly conversationId: ConversationId;
  readonly readOutput: (
    opts?: Parameters<ProjectHandle["readWorkerTaskOutput"]>[2],
  ) => ReturnType<ProjectHandle["readWorkerTaskOutput"]>;
}) {
  let currentTask = options.task;
  const boardListeners = new Set<(board: BoardView) => void>();
  const workerId = "w1" as CoreWorkerId;

  const makeBoard = (task: BackgroundTaskRecord): BoardView => ({
    workers: [
      {
        id: workerId,
        name: "worker",
        conversationId: options.conversationId,
        cwd: ".",
        status: "running",
        createdAt: 1,
        tasks: [task],
        activeTaskCount: task.status === "running" ? 1 : 0,
      },
    ],
    tickets: [],
    questions: [],
  });

  const handle = {
    tasks: options.taskManager,
    harness: {
      snapshot: async () => currentTask,
    },
    workers: async () => [
      {
        id: workerId,
        name: "worker",
        conversationId: options.conversationId,
        cwd: ".",
        status: "running",
        createdAt: 1,
      },
    ],
    listWorkerTasks: async () => [currentTask],
    resolveWorkerTask: async () => ({
      worker: {
        id: workerId,
        name: "worker",
        conversationId: options.conversationId,
        cwd: ".",
        createdAt: 1,
      },
      record: currentTask,
    }),
    readWorkerTaskOutput: async (
      _workerId: CoreWorkerId,
      _taskId: string,
      readOpts?: Parameters<ProjectHandle["readWorkerTaskOutput"]>[2],
    ) => options.readOutput(readOpts),
    subscribeBoard: (listener: (board: BoardView) => void) => {
      boardListeners.add(listener);
      return () => {
        boardListeners.delete(listener);
      };
    },
  } as unknown as ProjectHandle;

  const emitBoard = (nextTask: BackgroundTaskRecord) => {
    currentTask = nextTask;
    const board = makeBoard(nextTask);
    for (const listener of [...boardListeners]) {
      listener(board);
    }
  };

  return { handle, emitBoard };
}

test("subscribeWorkerTaskStream reports onEnd('failed', message) when processBoard terminal drain throws", async () => {
  const manager = new TaskManager();
  const convId = 1 as ConversationId;
  const runningTask: BackgroundTaskRecord = {
    id: "task-1",
    command: "echo hi",
    status: "running",
    startedAt: 1,
  };
  let outputText = "hello\n";
  const listeners = new Set<(chunk: string) => void>();
  const running: RunningCommand = {
    shell: "bash",
    command: "echo hi",
    rewrittenNul: false,
    settled: false,
    ready: Promise.resolve(),
    killed: false,
    done: new Promise(() => {}),
    output: () => ({
      text: outputText,
      totalBytes: Buffer.byteLength(outputText, "utf8"),
      droppedBytes: 0,
    }),
    onOutput: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    kill: () => {},
    detachCancel: () => {},
  };
  manager.attach(convId, "task-1", running);

  let readCalls = 0;
  const { handle, emitBoard } = createStubHandle({
    task: runningTask,
    taskManager: manager,
    conversationId: convId,
    readOutput: async () => {
      readCalls += 1;
      throw new Error("simulated terminal drain failure");
    },
  });

  const stream = await subscribeWorkerTaskStream(handle, "w1" as CoreWorkerId, "task-1");
  assert.equal(stream.terminal, false);

  const ended = new Promise<{ reason: string; message?: string }>((resolve) => {
    stream.start({
      onChunk: () => {},
      onStatus: () => {},
      onEnd: (reason, message) => resolve({ reason, message }),
    });
  });

  emitBoard({ ...runningTask, status: "completed", exitCode: 0, endedAt: 2 });
  const result = await ended;
  assert.equal(result.reason, "failed");
  assert.equal(result.message, "simulated terminal drain failure");
  assert.equal(readCalls, 1);

  outputText += "ignored";
  for (const listener of listeners) listener("ignored");
  assert.equal(listeners.size, 0);
  manager.killAll();
});

test("handleTaskStream forwards end reason='failed' and message over SSE", async () => {
  const manager = new TaskManager();
  const convId = 2 as ConversationId;
  const runningTask: BackgroundTaskRecord = {
    id: "task-1",
    command: "echo sse",
    status: "running",
    startedAt: 1,
  };
  const running: RunningCommand = {
    shell: "bash",
    command: "echo sse",
    rewrittenNul: false,
    settled: false,
    ready: Promise.resolve(),
    killed: false,
    done: new Promise(() => {}),
    output: () => ({ text: "initial\n", totalBytes: 8, droppedBytes: 0 }),
    onOutput: () => () => {},
    kill: () => {},
    detachCancel: () => {},
  };
  manager.attach(convId, "task-1", running);

  const { handle, emitBoard } = createStubHandle({
    task: runningTask,
    taskManager: manager,
    conversationId: convId,
    readOutput: async () => {
      throw new Error("disk log vanished");
    },
  });

  const stubEngine = {
    acquireStream: () => () => {},
    projects: {
      subscribeWorkerTaskStream: (
        _projectId: string,
        workerId: WorkerId,
        taskId: string,
        opts?: Parameters<ProjectHandle["readWorkerTaskOutput"]>[2],
      ) => subscribeWorkerTaskStream(handle, workerId as CoreWorkerId, taskId, opts),
    },
  } as unknown as Engine;

  const server = await startEngineHttpServer(stubEngine, {
    port: 0,
    token: "stream-fail-test",
    webDistDir: false,
  });
  try {
    const client = new EeveeClient({ baseUrl: server.url, token: "stream-fail-test" });
    const events: TaskStreamEvent[] = [];
    const loop = (async () => {
      for await (const evt of client.streamWorkerTask("proj-1", "w1", "task-1")) {
        events.push(evt);
        if (evt.type === "snapshot") {
          emitBoard({ ...runningTask, status: "completed", exitCode: 0, endedAt: 2 });
        }
      }
    })();
    await loop;
    assert.deepEqual(
      events.map((e) => e.type),
      ["snapshot", "end"],
    );
    const end = events[1];
    assert.equal(end?.type, "end");
    if (end?.type === "end") {
      assert.equal(end.reason, "failed");
      assert.equal(end.message, "disk log vanished");
    }
  } finally {
    await server.close();
    manager.killAll();
  }
});

test("subscribeWorkerTaskStream with head mode catches up [endByte, live.totalBytes) in bounded slices before live chunks", async () => {
  const manager = new TaskManager();
  const convId = 3 as ConversationId;
  const runningTask: BackgroundTaskRecord = {
    id: "task-1",
    command: "emit-many",
    status: "running",
    startedAt: 1,
  };

  const headBytes = "H".repeat(255);
  const emoji = "🦀";
  const middleBytes = "M".repeat(TASK_READ_MAX_BYTES + 123);
  const initialTotalText = `${headBytes}${emoji}${middleBytes}`;
  let currentText = initialTotalText;
  const listeners = new Set<(chunk: string) => void>();

  const running: RunningCommand = {
    shell: "bash",
    command: "emit-many",
    rewrittenNul: false,
    settled: false,
    ready: Promise.resolve(),
    killed: false,
    done: new Promise(() => {}),
    output: () => ({
      text: currentText,
      totalBytes: Buffer.byteLength(currentText, "utf8"),
      droppedBytes: 0,
    }),
    onOutput: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    kill: () => {},
    detachCancel: () => {},
  };
  manager.attach(convId, "task-1", running);

  const { handle, emitBoard } = createStubHandle({
    task: runningTask,
    taskManager: manager,
    conversationId: convId,
    readOutput: async (opts) => ({
      task: { ...runningTask, status: "completed", exitCode: 0, endedAt: 2 },
      output: sliceRetainedOutput(
        Buffer.from(currentText, "utf8"),
        0,
        Buffer.byteLength(currentText, "utf8"),
        opts,
      ),
    }),
  });

  const stream = await subscribeWorkerTaskStream(handle, "w1" as CoreWorkerId, "task-1", {
    mode: "head",
    bytes: 256,
  });

  // Push a live chunk after subscribing but before start() to verify bufferedChunks replay ordering.
  const bufferedLiveChunk = "LIVE_BUFFERED_1\n";
  currentText += bufferedLiveChunk;
  for (const listener of listeners) listener(bufferedLiveChunk);

  const chunks: { text: string; fromByte: number; endByte: number; totalBytes: number }[] = [];
  const ended = new Promise<string>((resolve) => {
    stream.start({
      onChunk: (chunk) => chunks.push(chunk),
      onStatus: () => {},
      onEnd: (reason) => resolve(reason),
    });
  });

  // Push an active live chunk after start() and a final tail chunk drained on terminal transition.
  const activeLiveChunk = "LIVE_AFTER_START\n";
  currentText += activeLiveChunk;
  for (const listener of listeners) listener(activeLiveChunk);

  const terminalTailChunk = "TERMINAL_TAIL\n";
  currentText += terminalTailChunk;
  emitBoard({ ...runningTask, status: "completed", exitCode: 0, endedAt: 2 });

  assert.equal(await ended, "completed");

  assert.equal(stream.snapshot.output.fromByte, 0);
  assert.equal(stream.snapshot.output.endByte, 255);
  assert.equal(stream.snapshot.output.text, headBytes);

  let expectedByte = stream.snapshot.output.endByte;
  let combined = stream.snapshot.output.text;
  assert.ok(chunks.length >= 4);
  for (const chunk of chunks) {
    assert.equal(chunk.fromByte, expectedByte);
    assert.equal(chunk.endByte, chunk.fromByte + Buffer.byteLength(chunk.text, "utf8"));
    assert.ok(chunk.endByte - chunk.fromByte <= TASK_READ_MAX_BYTES);
    expectedByte = chunk.endByte;
    combined += chunk.text;
  }
  assert.equal(combined, currentText);
  assert.equal(expectedByte, Buffer.byteLength(currentText, "utf8"));
  manager.killAll();
});

test("subscribeWorkerTaskStream with head mode catches up pre-retained disk bytes when droppedBytes > 0", async () => {
  await withTempDir(async (dir) => {
    const manager = new TaskManager();
    const convId = 4 as ConversationId;
    const logPath = join(dir, "task.log");
    const preRetained = `${"A".repeat(400)}pre-retained\n`;
    const retained = "retained-live\n";
    const diskText = `${preRetained}${retained}`;
    await writeFile(logPath, diskText, "utf8");

    const droppedBytes = Buffer.byteLength(preRetained, "utf8");
    const runningTask: BackgroundTaskRecord = {
      id: "task-1",
      command: "stream-big",
      status: "running",
      startedAt: 1,
      logPath,
    };

    let currentFullText = diskText;
    let currentRetained = retained;
    const listeners = new Set<(chunk: string) => void>();
    const running: RunningCommand = {
      shell: "bash",
      command: "stream-big",
      rewrittenNul: false,
      settled: false,
      ready: Promise.resolve(),
      killed: false,
      done: new Promise(() => {}),
      output: () => ({
        text: currentRetained,
        totalBytes: Buffer.byteLength(currentFullText, "utf8"),
        droppedBytes,
      }),
      onOutput: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      kill: () => {},
      detachCancel: () => {},
    };
    manager.attach(convId, "task-1", running);

    const { handle, emitBoard } = createStubHandle({
      task: runningTask,
      taskManager: manager,
      conversationId: convId,
      readOutput: async (opts) => ({
        task: runningTask,
        output: await manager.readOutput(convId, "task-1", runningTask, opts),
      }),
    });

    const stream = await subscribeWorkerTaskStream(handle, "w1" as CoreWorkerId, "task-1", {
      mode: "head",
      bytes: 256,
    });
    assert.equal(stream.snapshot.output.fromByte, 0);
    assert.equal(stream.snapshot.output.endByte, 256);

    const liveChunk = "after-sub-live\n";
    currentFullText += liveChunk;
    currentRetained += liveChunk;
    await writeFile(logPath, currentFullText, "utf8");
    for (const listener of listeners) listener(liveChunk);

    const chunks: { text: string; fromByte: number; endByte: number }[] = [];
    const ended = new Promise<string>((resolve) => {
      stream.start({
        onChunk: (chunk) => chunks.push(chunk),
        onStatus: () => {},
        onEnd: (reason) => resolve(reason),
      });
    });

    await waitFor(() => chunks.some((c) => c.text.includes("after-sub-live")), "catch-up + live");
    emitBoard({ ...runningTask, status: "completed", exitCode: 0, endedAt: 2 });
    assert.equal(await ended, "completed");

    let expectedByte = stream.snapshot.output.endByte;
    let combined = stream.snapshot.output.text;
    for (const chunk of chunks) {
      assert.equal(chunk.fromByte, expectedByte);
      assert.equal(chunk.endByte, chunk.fromByte + Buffer.byteLength(chunk.text, "utf8"));
      expectedByte = chunk.endByte;
      combined += chunk.text;
    }
    assert.equal(combined, currentFullText);
    manager.killAll();
  });
});

test("EeveeClient.streamWorkerTask with head bytes=256 streams zero-gap catch-up end-to-end", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });
    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const nodeBin = JSON.stringify(process.execPath.replace(/\\/g, "/"));
    const cmd = `${nodeBin} -e 'process.stdout.write("A".repeat(400) + "\\n"); setTimeout(() => { process.stdout.write("LATE_PART\\n"); process.exit(0); }, 200);'`;

    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-head-stream")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "head-runner", prompt: "launch-head-task" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("launch-head-task")) {
          return fauxAssistantMessage([fauxToolCall("bash", { command: cmd, background: true })], {
            stopReason: "toolUse",
          });
        }
        if (text.includes("Background task")) {
          return fauxAssistantMessage("worker noted completion");
        }
        if (text.includes("worker noted completion")) {
          return fauxAssistantMessage("router noted completion");
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("spawned");
        if (last.toolName === "bash") return fauxAssistantMessage("started");
      }
      return fauxAssistantMessage("ack");
    };
    faux.setResponses(Array.from({ length: 15 }, () => brain));

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const projectId = (await client.createProject({ workspaces: [ws], title: "HeadStream" }))
        .project.id;

      await client.sendMessage(projectId, "router", { text: "spawn-head-stream" });
      await waitFor(async () => {
        const board = await client.getBoard(projectId);
        const w1 = board.workers.find((w) => w.id === "w1");
        if (!w1?.tasks.some((t) => t.id === "task-1" && t.status === "running")) return false;
        const read = await client.readWorkerTask(projectId, "w1", "task-1", {
          mode: "head",
          bytes: 512,
        });
        return read.output.totalBytes >= 401;
      }, "task-1 running with > 400 bytes");

      const events: TaskStreamEvent[] = [];
      for await (const evt of client.streamWorkerTask(projectId, "w1", "task-1", {
        mode: "head",
        bytes: 256,
      })) {
        events.push(evt);
      }

      const snapshot = events[0];
      assert.equal(snapshot?.type, "snapshot");
      if (snapshot?.type === "snapshot") {
        assert.equal(snapshot.output.endByte, 256);
      }

      let expectedByte = snapshot?.type === "snapshot" ? snapshot.output.endByte : 0;
      let combined = snapshot?.type === "snapshot" ? snapshot.output.text : "";
      for (const evt of events) {
        if (evt.type !== "chunk") continue;
        assert.equal(evt.fromByte, expectedByte);
        assert.equal(evt.endByte, evt.fromByte + Buffer.byteLength(evt.text, "utf8"));
        expectedByte = evt.endByte;
        combined += evt.text;
      }
      assert.ok(combined.startsWith(`${"A".repeat(400)}\n`), combined);
      assert.ok(combined.includes("LATE_PART\n"), combined);
    } finally {
      await foreground.close();
    }
  });
});
