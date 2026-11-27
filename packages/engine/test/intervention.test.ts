import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import { LiveDoc } from "@earendil-works/pi-durable";
import { ProjectBoardDoc, QuestionDoc, type QuestionId } from "@eevee/core";
import {
  AnswerQuestionResponseSchema,
  EeveeApiError,
  EeveeClient,
  KillWorkerTaskResponseSchema,
  ListEntriesResponseSchema,
  ListWorkerTasksResponseSchema,
  OkResponseSchema,
  ProblemSchema,
  parseWithSchema,
  ReadWorkerTaskResponseSchema,
  SendMessageResponseSchema,
  type TaskStreamEvent,
} from "@eevee/protocol";
import { startForegroundEngine } from "../src/index.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "eevee-engine-4b-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("4B routes enforce bearer auth, 405 Allow headers, and strict param/query validation", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

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
      const auth = { Authorization: `Bearer ${foreground.token}` };
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const created = await client.createProject({ workspaces: [ws], title: "Validation" });
      const projectId = created.project.id;

      const unauthRoutes: [string, string][] = [
        ["GET", `/projects/${projectId}/conversations/router/entries`],
        ["POST", `/projects/${projectId}/conversations/router/interrupt`],
        ["POST", `/projects/${projectId}/conversations/router/retry`],
        ["POST", `/projects/${projectId}/questions/q1/answer`],
        ["GET", `/projects/${projectId}/workers/w1/tasks`],
        ["GET", `/projects/${projectId}/workers/w1/tasks/task-1`],
        ["GET", `/projects/${projectId}/workers/w1/tasks/task-1/stream`],
        ["POST", `/projects/${projectId}/workers/w1/tasks/task-1/kill`],
      ];
      for (const [method, path] of unauthRoutes) {
        const res = await fetch(`${foreground.url}${path}`, { method });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get("www-authenticate"), "Bearer");
        parseWithSchema(ProblemSchema, await res.json());
      }

      const methodChecks: [string, string, string][] = [
        ["POST", `/projects/${projectId}/conversations/router/entries`, "GET"],
        ["GET", `/projects/${projectId}/conversations/router/interrupt`, "POST"],
        ["GET", `/projects/${projectId}/conversations/router/retry`, "POST"],
        ["GET", `/projects/${projectId}/questions/q1/answer`, "POST"],
        ["POST", `/projects/${projectId}/workers/w1/tasks`, "GET"],
        ["POST", `/projects/${projectId}/workers/w1/tasks/task-1`, "GET"],
        ["POST", `/projects/${projectId}/workers/w1/tasks/task-1/stream`, "GET"],
        ["GET", `/projects/${projectId}/workers/w1/tasks/task-1/kill`, "POST"],
      ];
      for (const [method, path, allow] of methodChecks) {
        const res = await fetch(`${foreground.url}${path}`, { method, headers: auth });
        assert.equal(res.status, 405);
        assert.equal(res.headers.get("allow"), allow);
        parseWithSchema(ProblemSchema, await res.json());
      }

      const invalidRequests: [string, RequestInit][] = [
        [
          `/projects/${projectId}/conversations/router/entries?limit=0`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/conversations/router/entries?limit=501`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/conversations/router/entries?order=sideways`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/conversations/router/entries?minEntryId=0`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/conversations/router/entries?maxEntryId=abc`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/conversations/router/entries?cursor=not!valid`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/questions/bad-id/answer`,
          {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/json" },
            body: JSON.stringify({ answers: ["ok"] }),
          },
        ],
        [
          `/projects/${projectId}/questions/q1/answer`,
          {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/json" },
            body: JSON.stringify({ answers: [] }),
          },
        ],
        [
          `/projects/${projectId}/workers/bad-worker/tasks/task-1`,
          { method: "GET", headers: auth },
        ],
        [`/projects/${projectId}/workers/w1/tasks/%20`, { method: "GET", headers: auth }],
        [`/projects/${projectId}/workers/w1/tasks?status=bogus`, { method: "GET", headers: auth }],
        [`/projects/${projectId}/workers/w1/tasks?limit=0`, { method: "GET", headers: auth }],
        [`/projects/${projectId}/workers/w1/tasks?limit=101`, { method: "GET", headers: auth }],
        [
          `/projects/${projectId}/workers/w1/tasks/task-1?mode=middle`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/workers/w1/tasks/task-1?bytes=0`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/workers/w1/tasks/task-1?sinceBytes=-1`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/workers/w1/tasks/task-1?endByte=-1`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/workers/w1/tasks/task-1?filter=`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/workers/w1/tasks/task-1?filter=${encodeURIComponent("/[/")}`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/workers/w1/tasks/task-1?filter=ok&contextLines=-1`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/workers/w1/tasks/task-1?filter=ok&contextLines=6`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/workers/w1/tasks/task-1?contextLines=1`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/workers/w1/tasks/task-1/stream?mode=middle`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/workers/w1/tasks/task-1/stream?bytes=0`,
          { method: "GET", headers: auth },
        ],
        [
          `/projects/${projectId}/workers/w1/tasks/task-1/stream?sinceBytes=-1`,
          { method: "GET", headers: auth },
        ],
      ];
      for (const [path, init] of invalidRequests) {
        const res = await fetch(`${foreground.url}${path}`, init);
        assert.equal(res.status, 400, `expected 400 for ${init.method} ${path}`);
        parseWithSchema(ProblemSchema, await res.json());
      }
    } finally {
      await foreground.close();
    }
  });
});

test("listEntries paginates ascending/descending, enforces min/max bounds, and rejects bad cursors", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      () => fauxAssistantMessage("reply 1"),
      () => fauxAssistantMessage("reply 2"),
      () => fauxAssistantMessage("reply 3"),
    ]);

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
      const created = await client.createProject({ workspaces: [ws], title: "History" });
      const projectId = created.project.id;
      const handle = await foreground.engine.openProject(projectId);

      for (const text of ["msg 1", "msg 2", "msg 3"]) {
        const sent = await client.sendMessage(projectId, "router", { text });
        const sub = await handle.harness.submission(sent.submissionId as never, BACKGROUND_CONTEXT);
        await sub?.wait(BACKGROUND_CONTEXT);
      }

      const ascEntries: number[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await client.listEntries(projectId, "router", {
          order: "ascending",
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        parseWithSchema(ListEntriesResponseSchema, page);
        ascEntries.push(...page.entries.map((entry) => entry.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined);

      assert.ok(pages >= 3);
      assert.ok(ascEntries.length >= 6);
      assert.deepEqual(
        ascEntries,
        [...ascEntries].sort((a, b) => a - b),
      );

      const descEntries: number[] = [];
      cursor = undefined;
      do {
        const page = await client.listEntries(projectId, "router", {
          order: "descending",
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        parseWithSchema(ListEntriesResponseSchema, page);
        descEntries.push(...page.entries.map((entry) => entry.id));
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      assert.deepEqual([...descEntries].reverse(), ascEntries);

      const lo = ascEntries[1];
      const hi = ascEntries[ascEntries.length - 2];
      assert.ok(lo !== undefined && hi !== undefined);
      const bounded = await client.listEntries(projectId, "router", {
        order: "ascending",
        minEntryId: lo,
        maxEntryId: hi,
        limit: 50,
      });
      assert.deepEqual(
        bounded.entries.map((entry) => entry.id),
        ascEntries.slice(1, -1),
      );

      const firstAscPage = await client.listEntries(projectId, "router", {
        order: "ascending",
        limit: 2,
      });
      assert.ok(firstAscPage.nextCursor !== undefined);

      const nonObjectCursors = [
        Buffer.from(JSON.stringify([1, 2]), "utf8").toString("base64url"),
        Buffer.from(JSON.stringify(null), "utf8").toString("base64url"),
        Buffer.from(JSON.stringify("string"), "utf8").toString("base64url"),
        Buffer.from("{not-json", "utf8").toString("base64url"),
        Buffer.from(JSON.stringify({ after: "bad" }), "utf8").toString("base64url"),
      ];
      for (const badCursor of nonObjectCursors) {
        await assert.rejects(
          client.listEntries(projectId, "router", { cursor: badCursor }),
          (error: unknown) =>
            error instanceof EeveeApiError &&
            error.status === 400 &&
            error.problem.code === "invalid_query",
        );
      }

      await assert.rejects(
        client.listEntries(projectId, "router", {
          order: "descending",
          cursor: firstAscPage.nextCursor,
        }),
        (error: unknown) =>
          error instanceof EeveeApiError &&
          error.status === 400 &&
          error.problem.code === "invalid_query",
      );
    } finally {
      await foreground.close();
    }
  });
});

test("interrupt and retry handle active runs, model errors, busy/queued/closed conflicts, and unknown workers", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let worker1Started!: () => void;
    const worker1StartedPromise = new Promise<void>((resolve) => {
      worker1Started = resolve;
    });
    let releaseWorker1!: () => void;
    const worker1Gate = new Promise<void>((resolve) => {
      releaseWorker1 = resolve;
    });
    let worker1SlowUsed = false;
    let modelFailOnce = true;

    const brain: FauxResponseFactory = async (context, streamOptions) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-two")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", { name: "first", prompt: "slow-worker-1" }),
              fauxToolCall("spawn_worker", { name: "second", prompt: "queued-worker-2" }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("slow-worker-1")) {
          if (!worker1SlowUsed) {
            worker1SlowUsed = true;
            worker1Started();
            await new Promise<void>((resolve) => {
              const onAbort = () => resolve();
              if (streamOptions?.signal?.aborted) {
                resolve();
                return;
              }
              streamOptions?.signal?.addEventListener("abort", onAbort, { once: true });
              void worker1Gate.then(() => {
                streamOptions?.signal?.removeEventListener("abort", onAbort);
                resolve();
              });
            });
            if (streamOptions?.signal?.aborted) {
              return fauxAssistantMessage("", { stopReason: "aborted" });
            }
          }
          if (modelFailOnce) {
            modelFailOnce = false;
            return fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: "invalid_api_key",
            });
          }
          return fauxAssistantMessage("worker-1-recovered");
        }
        if (text.includes("queued-worker-2")) {
          return fauxAssistantMessage("worker-2-done");
        }
        if (text.includes("Worker first") && text.includes("worker-1-recovered")) {
          return fauxAssistantMessage(
            [fauxToolCall("stop_worker", { workerId: "w1", action: "close" })],
            { stopReason: "toolUse" },
          );
        }
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("router spawned workers");
      }
      if (last?.role === "toolResult" && last.toolName === "stop_worker") {
        return fauxAssistantMessage("closed w1 cleanly");
      }
      return fauxAssistantMessage("router ack");
    };
    faux.setResponses(Array.from({ length: 30 }, () => brain));

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      models,
      maxActiveWorkers: 1,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const created = await client.createProject({ workspaces: [ws], title: "Intervention" });
      const projectId = created.project.id;
      const handle = await foreground.engine.openProject(projectId);

      await assert.rejects(
        client.interrupt(projectId, "w99"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "worker_not_found",
      );
      await assert.rejects(
        client.retry(projectId, "w99"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "worker_not_found",
      );

      await client.sendMessage(projectId, "router", { text: "spawn-two" });
      await worker1StartedPromise;

      await assert.rejects(
        client.retry(projectId, "w1"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 409 &&
          err.problem.code === "conversation_busy",
      );

      await assert.rejects(
        client.retry(projectId, "w2"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 409 &&
          err.problem.code === "worker_queued",
      );

      const interrupted = await client.interrupt(projectId, "w1");
      parseWithSchema(OkResponseSchema, interrupted);
      assert.equal(interrupted.ok, true);

      const w1Record = (await handle.workers()).find((w) => w.id === "w1");
      assert.ok(w1Record !== undefined);
      await waitFor(async () => {
        const live = await handle.harness.snapshot(
          LiveDoc,
          w1Record.conversationId,
          BACKGROUND_CONTEXT,
        );
        return live?.run === undefined;
      }, "w1 interrupt to settle");

      const retry1 = await client.retry(projectId, "w1");
      parseWithSchema(SendMessageResponseSchema, retry1);
      const retry1Sub = await handle.harness.submission(
        retry1.submissionId as never,
        BACKGROUND_CONTEXT,
      );
      const settled1 = await retry1Sub?.wait(BACKGROUND_CONTEXT);
      assert.equal(settled1?.status, "unanswered");

      const retry2 = await client.retry(projectId, "w1");
      parseWithSchema(SendMessageResponseSchema, retry2);
      const retry2Sub = await handle.harness.submission(
        retry2.submissionId as never,
        BACKGROUND_CONTEXT,
      );
      const settled2 = await retry2Sub?.wait(BACKGROUND_CONTEXT);
      assert.equal(settled2?.status, "done");

      await waitFor(async () => {
        const board = await client.getBoard(projectId);
        return board.workers.some((w) => w.id === "w1" && w.status === "closed");
      }, "w1 to close via router");

      await assert.rejects(
        client.retry(projectId, "w1"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 409 &&
          err.problem.code === "worker_closed",
      );
    } finally {
      releaseWorker1();
      await foreground.close();
    }
  });
});

test("answerQuestion handles valid answers, 404, 400 count mismatch, and 409 closed/withdrawn", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("ask-me")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("ask_user", {
                questions: [
                  { question: "Port?", options: ["3000", "8080"], recommended: "3000" },
                  { question: "Host?" },
                ],
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("User answered question q1")) {
          return fauxAssistantMessage("using port 8080 on localhost");
        }
      }
      if (last?.role === "toolResult" && last.toolName === "ask_user") {
        return fauxAssistantMessage("waiting for user answers");
      }
      return fauxAssistantMessage("ok");
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
      const created = await client.createProject({ workspaces: [ws], title: "Questions" });
      const projectId = created.project.id;
      const handle = await foreground.engine.openProject(projectId);

      await assert.rejects(
        client.answerQuestion(projectId, "q99", { answers: ["a"] }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "question_not_found",
      );

      await client.sendMessage(projectId, "router", { text: "ask-me" });
      await waitFor(async () => {
        const board = await client.getBoard(projectId);
        return board.questions.some((q) => q.id === "q1");
      }, "question q1 to be recorded");

      await assert.rejects(
        client.answerQuestion(projectId, "q1", { answers: ["only-one"] }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 400 &&
          err.problem.code === "invalid_request",
      );

      const answered = await client.answerQuestion(projectId, "q1", {
        answers: ["8080", "localhost"],
      });
      parseWithSchema(AnswerQuestionResponseSchema, answered);
      assert.equal(answered.question.id, "q1");
      assert.deepEqual(answered.question.answers, ["8080", "localhost"]);
      assert.ok(answered.question.answeredAt !== undefined);

      await assert.rejects(
        client.answerQuestion(projectId, "q1", { answers: ["8080", "localhost"] }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 409 &&
          err.problem.code === "question_closed",
      );

      await waitFor(async () => {
        const page = await client.listEntries(projectId, "router", { order: "descending" });
        return page.entries.some((entry) =>
          JSON.stringify(entry).includes("using port 8080 on localhost"),
        );
      }, "router to resume after answer");

      await handle.harness.commit(async (tx) => {
        const board = await tx.doc(ProjectBoardDoc);
        const id = "q2" as QuestionId;
        board.nextQuestionSeq = Math.max(board.nextQuestionSeq, 3);
        board.questionOrder.push(id);
        const doc = await tx.doc(QuestionDoc, id, null);
        doc.id = id;
        doc.items = [{ question: "Withdrawn?" }];
        doc.askedAt = 1;
        doc.withdrawnAt = 2;
      }, BACKGROUND_CONTEXT);

      await assert.rejects(
        client.answerQuestion(projectId, "q2", { answers: ["nope"] }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 409 &&
          err.problem.code === "question_closed",
      );
    } finally {
      await foreground.close();
    }
  });
});

test("readWorkerTask supports head/tail/sinceBytes and killWorkerTask cancels task and wakes Worker with cancelled-by-user notice", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });
    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const nodeBin = JSON.stringify(process.execPath.replace(/\\/g, "/"));
    const longTaskCmd = `${nodeBin} -e 'let i=0; const t=setInterval(()=>{ i++; process.stdout.write("tick-"+i+"\\n"); }, 50); setTimeout(()=>clearInterval(t), 15000);'`;

    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("start-bg-worker")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "runner", prompt: "launch-bg-task" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("launch-bg-task")) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: longTaskCmd, background: true })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("cancelled by the user")) {
          return fauxAssistantMessage("worker noted user cancellation");
        }
        if (text.includes("worker noted user cancellation")) {
          return fauxAssistantMessage("router acknowledged cancellation");
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") {
          return fauxAssistantMessage("spawned runner");
        }
        if (last.toolName === "bash") {
          return fauxAssistantMessage("started background task-1");
        }
      }
      throw new Error(`Unexpected faux request: ${JSON.stringify(last)}`);
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
      const created = await client.createProject({ workspaces: [ws], title: "Tasks" });
      const projectId = created.project.id;

      await client.sendMessage(projectId, "router", { text: "start-bg-worker" });

      await waitFor(async () => {
        const board = await client.getBoard(projectId);
        const w1 = board.workers.find((w) => w.id === "w1");
        return w1?.tasks.some((t) => t.id === "task-1" && t.status === "running") ?? false;
      }, "worker w1 task-1 to start running");

      await waitFor(async () => {
        const entries = await client.listEntries(projectId, "w1", { order: "ascending" });
        return entries.entries.some((e) => JSON.stringify(e).includes("started background task-1"));
      }, "w1 initial turn to settle");

      let slice1 = await client.readWorkerTask(projectId, "w1", "task-1", {
        mode: "head",
        bytes: 256,
      });
      await waitFor(async () => {
        slice1 = await client.readWorkerTask(projectId, "w1", "task-1", {
          mode: "head",
          bytes: 256,
        });
        return slice1.output.text.includes("tick-1\n") && slice1.output.text.includes("tick-2\n");
      }, "initial background output ticks");
      parseWithSchema(ReadWorkerTaskResponseSchema, slice1);

      const firstCursor = slice1.output.endByte;
      assert.ok(firstCursor > 0);

      let incremental = await client.readWorkerTask(projectId, "w1", "task-1", {
        sinceBytes: firstCursor,
      });
      await waitFor(async () => {
        incremental = await client.readWorkerTask(projectId, "w1", "task-1", {
          sinceBytes: firstCursor,
        });
        return incremental.output.endByte > firstCursor;
      }, "incremental output after firstCursor");
      parseWithSchema(ReadWorkerTaskResponseSchema, incremental);
      assert.equal(incremental.output.fromByte, firstCursor);
      assert.equal(incremental.output.text.includes("tick-1\n"), false);

      const tailRead = await client.readWorkerTask(projectId, "w1", "task-1", {
        mode: "tail",
        bytes: 256,
      });
      parseWithSchema(ReadWorkerTaskResponseSchema, tailRead);
      assert.ok(tailRead.output.text.length > 0);

      await assert.rejects(
        client.readWorkerTask(projectId, "w99", "task-1"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "worker_not_found",
      );
      await assert.rejects(
        client.killWorkerTask(projectId, "w99", "task-1"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "worker_not_found",
      );

      await assert.rejects(
        client.readWorkerTask(projectId, "w1", "task-999"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "task_not_found",
      );
      await assert.rejects(
        client.killWorkerTask(projectId, "w1", "task-999"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "task_not_found",
      );

      const killed = await client.killWorkerTask(projectId, "w1", "task-1");
      parseWithSchema(KillWorkerTaskResponseSchema, killed);
      assert.equal(killed.task.status, "cancelled");
      assert.equal(killed.task.cancelReason, "user");

      await assert.rejects(
        client.killWorkerTask(projectId, "w1", "task-1"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 409 &&
          err.problem.code === "task_not_running",
      );

      await waitFor(async () => {
        const workerEntries = await client.listEntries(projectId, "w1", { limit: 500 });
        const routerEntries = await client.listEntries(projectId, "router", { limit: 500 });
        return (
          workerEntries.entries.some((e) =>
            JSON.stringify(e).includes("worker noted user cancellation"),
          ) &&
          routerEntries.entries.some((e) =>
            JSON.stringify(e).includes("router acknowledged cancellation"),
          )
        );
      }, "worker and router to settle after user kill steer notice");

      const workerAfterKill = await client.listEntries(projectId, "w1", { limit: 500 });
      assert.ok(
        workerAfterKill.entries.some((e) => JSON.stringify(e).includes("cancelled by the user")),
      );

      const handle = await foreground.engine.openProject(projectId);
      const w1Record = (await handle.workers(BACKGROUND_CONTEXT)).find((w) => w.id === "w1");
      assert.ok(w1Record !== undefined);
      await waitFor(async () => {
        const live = await handle.harness.snapshot(
          LiveDoc,
          w1Record.conversationId,
          BACKGROUND_CONTEXT,
        );
        return live?.run === undefined;
      }, "w1 to go idle after user kill wrap-up");
      await handle.root.waitForIdle(BACKGROUND_CONTEXT);

      const boardAfterKill = await client.getBoard(projectId);
      const w1 = boardAfterKill.workers.find((w) => w.id === "w1");
      assert.equal(w1?.status, "idle");
      assert.equal(w1?.activeTaskCount, 0);
    } finally {
      await foreground.close();
    }
  });
});

test("listWorkerTasks, filtered/paged readWorkerTask, ambiguous prefix 400, and streamWorkerTask SSE", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });
    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const nodeBin = JSON.stringify(process.execPath.replace(/\\/g, "/"));
    const finishedLogCmd = `${nodeBin} -e 'for (let i = 1; i <= 12; i++) console.log(i === 5 ? "ERR: boom-marker" : i === 9 ? "WARN: warn-marker" : "line-" + i);'`;
    const liveStreamCmd = `${nodeBin} -e 'console.log("init-✓"); setTimeout(() => console.log("chunk-1-🦀"), 100); setTimeout(() => { console.log("chunk-2"); process.exit(0); }, 250);'`;
    const killStreamCmd = `${nodeBin} -e 'console.log("kill-start"); const t = setInterval(() => console.log("kill-tick"), 60); setTimeout(() => clearInterval(t), 15000);'`;

    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-task-worker")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "streamer", prompt: "run-finished-logs" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("run-finished-logs")) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: finishedLogCmd, background: true })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("launch-live-stream")) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: liveStreamCmd, background: true })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("launch-kill-stream")) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: killStreamCmd, background: true })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("launch-extra-task")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command: `${nodeBin} -e 'console.log("ok")'`,
                background: true,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("Background task")) {
          return fauxAssistantMessage("worker noted task event");
        }
        if (text.includes("worker noted task event")) {
          return fauxAssistantMessage("router noted worker wrap-up");
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("spawned streamer");
        if (last.toolName === "bash") return fauxAssistantMessage("started background command");
      }
      return fauxAssistantMessage("ack");
    };
    faux.setResponses(Array.from({ length: 60 }, () => brain));

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
      const created = await client.createProject({ workspaces: [ws], title: "TaskStream" });
      const projectId = created.project.id;

      await client.sendMessage(projectId, "router", { text: "spawn-task-worker" });
      await waitFor(async () => {
        const board = await client.getBoard(projectId);
        const w1 = board.workers.find((w) => w.id === "w1");
        return w1?.tasks.some((t) => t.id === "task-1" && t.status === "completed") ?? false;
      }, "task-1 to complete");

      await assert.rejects(
        client.listWorkerTasks(projectId, "w99"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "worker_not_found",
      );
      const listedAll = await client.listWorkerTasks(projectId, "w1");
      parseWithSchema(ListWorkerTasksResponseSchema, listedAll);
      assert.equal(listedAll.tasks.length, 1);
      assert.equal(listedAll.tasks[0]?.status, "completed");
      assert.equal(
        (await client.listWorkerTasks(projectId, "w1", { status: "active" })).tasks.length,
        0,
      );
      assert.equal(
        (await client.listWorkerTasks(projectId, "w1", { status: "finished" })).tasks.length,
        1,
      );

      const headPart = await client.readWorkerTask(projectId, "w1", "task-1", {
        mode: "head",
        bytes: 256,
      });
      assert.ok(headPart.output.totalBytes > 40);
      const midSlice = await client.readWorkerTask(projectId, "w1", "task-1", {
        mode: "tail",
        bytes: 256,
        endByte: Math.floor(headPart.output.totalBytes / 2),
      });
      assert.ok(midSlice.output.endByte <= Math.floor(headPart.output.totalBytes / 2));
      assert.equal(midSlice.output.text.includes("line-12"), false);

      const substrFiltered = await client.readWorkerTask(projectId, "w1", "task-1", {
        filter: "BOOM-MARKER",
        contextLines: 1,
      });
      assert.equal(substrFiltered.output.matchedLines, 1);
      assert.equal(substrFiltered.output.totalMatchedLines, 1);
      assert.equal(substrFiltered.output.scanTruncated, false);
      assert.ok(substrFiltered.output.text.includes("4- line-4"));
      assert.ok(substrFiltered.output.text.includes("5: ERR: boom-marker"));
      assert.ok(substrFiltered.output.text.includes("6- line-6"));

      const regexFiltered = await client.readWorkerTask(projectId, "w1", "task-1", {
        filter: "/(boom|warn)-marker/i",
        contextLines: 0,
      });
      assert.equal(regexFiltered.output.matchedLines, 2);
      assert.equal(regexFiltered.output.totalMatchedLines, 2);
      assert.ok(regexFiltered.output.text.includes("5: ERR: boom-marker"));
      assert.ok(regexFiltered.output.text.includes("9: WARN: warn-marker"));

      await assert.rejects(
        client.readWorkerTask(projectId, "w1", "task-1", { filter: "/[unclosed/" }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 400 &&
          err.problem.code === "invalid_query",
      );
      await assert.rejects(
        client.readWorkerTask(projectId, "w1", "task-1", { contextLines: 1 }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 400 &&
          err.problem.code === "invalid_query",
      );

      const terminalEvents: TaskStreamEvent[] = [];
      for await (const evt of client.streamWorkerTask(projectId, "w1", "task-1")) {
        terminalEvents.push(evt);
      }
      assert.deepEqual(
        terminalEvents.map((e) => e.type),
        ["snapshot", "end"],
      );
      if (terminalEvents[0]?.type === "snapshot") {
        assert.equal(terminalEvents[0].task.status, "completed");
        assert.ok(terminalEvents[0].output.text.includes("ERR: boom-marker"));
      }
      if (terminalEvents[1]?.type === "end") {
        assert.equal(terminalEvents[1].reason, "terminal");
      }

      await assert.rejects(
        async () => {
          for await (const _ of client.streamWorkerTask(projectId, "w99", "task-1")) {
          }
        },
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "worker_not_found",
      );
      await assert.rejects(
        async () => {
          for await (const _ of client.streamWorkerTask(projectId, "w1", "task-999")) {
          }
        },
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "task_not_found",
      );

      await client.sendMessage(projectId, "w1", { text: "launch-live-stream" });
      await waitFor(async () => {
        const res = await client.listWorkerTasks(projectId, "w1", { status: "active" });
        return res.tasks.some((t) => t.id === "task-2");
      }, "task-2 to start running");

      const liveEvents: TaskStreamEvent[] = [];
      for await (const evt of client.streamWorkerTask(projectId, "w1", "task-2", {
        mode: "head",
        bytes: 8192,
      })) {
        liveEvents.push(evt);
      }
      assert.equal(liveEvents[0]?.type, "snapshot");
      assert.ok(liveEvents.some((e) => e.type === "chunk"));
      const lastStatus = liveEvents.findLast((e) => e.type === "status");
      assert.ok(lastStatus?.type === "status");
      assert.equal(lastStatus.task.status, "completed");
      assert.equal(lastStatus.task.exitCode, 0);
      const lastLiveEvt = liveEvents.at(-1);
      assert.equal(lastLiveEvt?.type, "end");
      if (lastLiveEvt?.type === "end") {
        assert.equal(lastLiveEvt.reason, "completed");
      }

      let reconstructed = "";
      let expectedByte = 0;
      if (liveEvents[0]?.type === "snapshot") {
        reconstructed += liveEvents[0].output.text;
        expectedByte = liveEvents[0].output.endByte;
      }
      for (const evt of liveEvents) {
        if (evt.type !== "chunk") continue;
        assert.equal(evt.fromByte, expectedByte);
        assert.equal(evt.endByte, evt.fromByte + Buffer.byteLength(evt.text, "utf8"));
        assert.ok(evt.totalBytes >= evt.endByte);
        expectedByte = evt.endByte;
        reconstructed += evt.text;
      }
      const diskFull = await client.readWorkerTask(projectId, "w1", "task-2", {
        mode: "head",
        bytes: 48 * 1024,
      });
      assert.equal(reconstructed, diskFull.output.text);
      assert.ok(reconstructed.includes("init-✓"));
      assert.ok(reconstructed.includes("chunk-1-🦀"));
      assert.ok(reconstructed.includes("chunk-2"));

      await client.sendMessage(projectId, "w1", { text: "launch-kill-stream" });
      await waitFor(async () => {
        const res = await client.listWorkerTasks(projectId, "w1", { status: "active" });
        return res.tasks.some((t) => t.id === "task-3");
      }, "task-3 to start running");

      const killEvents: TaskStreamEvent[] = [];
      let killTriggered = false;
      const killStreamLoop = (async () => {
        for await (const evt of client.streamWorkerTask(projectId, "w1", "task-3")) {
          killEvents.push(evt);
          if (!killTriggered && (evt.type === "snapshot" || evt.type === "chunk")) {
            const combined = killEvents
              .map((item) =>
                item.type === "snapshot"
                  ? item.output.text
                  : item.type === "chunk"
                    ? item.text
                    : "",
              )
              .join("");
            if (combined.includes("kill-tick")) {
              killTriggered = true;
              void client.killWorkerTask(projectId, "w1", "task-3");
            }
          }
        }
      })();
      await killStreamLoop;
      assert.equal(killEvents[0]?.type, "snapshot");
      const finalKillStatus = killEvents.findLast((e) => e.type === "status");
      assert.ok(finalKillStatus?.type === "status");
      assert.equal(finalKillStatus.task.status, "cancelled");
      assert.equal(finalKillStatus.task.cancelReason, "user");
      const finalKillEnd = killEvents.at(-1);
      assert.equal(finalKillEnd?.type, "end");
      if (finalKillEnd?.type === "end") {
        assert.equal(finalKillEnd.reason, "completed");
      }

      for (let idx = 4; idx <= 10; idx++) {
        await client.sendMessage(projectId, "w1", { text: "launch-extra-task" });
        await waitFor(async () => {
          const res = await client.listWorkerTasks(projectId, "w1", {
            status: "finished",
            limit: 20,
          });
          return res.tasks.some((t) => t.id === `task-${idx}`);
        }, `task-${idx} to finish`);
      }

      const limited = await client.listWorkerTasks(projectId, "w1", {
        status: "finished",
        limit: 3,
      });
      assert.deepEqual(
        limited.tasks.map((t) => t.id),
        ["task-8", "task-9", "task-10"],
      );

      await assert.rejects(
        client.readWorkerTask(projectId, "w1", "1"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 400 &&
          err.problem.code === "task_ambiguous",
      );
      await assert.rejects(
        client.killWorkerTask(projectId, "w1", "1"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 400 &&
          err.problem.code === "task_ambiguous",
      );
      await assert.rejects(
        async () => {
          for await (const _ of client.streamWorkerTask(projectId, "w1", "1")) {
          }
        },
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 400 &&
          err.problem.code === "task_ambiguous",
      );
    } finally {
      await foreground.close();
    }
  });
});

test("streamWorkerTask closes cleanly with end reason='closed' on server shutdown", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });
    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const nodeBin = JSON.stringify(process.execPath.replace(/\\/g, "/"));
    const idleCmd = `${nodeBin} -e 'console.log("steady"); setTimeout(() => {}, 15000);'`;

    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-idle")) {
          return fauxAssistantMessage(
            [fauxToolCall("spawn_worker", { name: "keeper", prompt: "run-steady" })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("run-steady")) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: idleCmd, background: true })],
            { stopReason: "toolUse" },
          );
        }
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "spawn_worker") return fauxAssistantMessage("spawned");
        if (last.toolName === "bash") return fauxAssistantMessage("running steady");
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
      const created = await client.createProject({ workspaces: [ws], title: "CloseStream" });
      const projectId = created.project.id;

      await client.sendMessage(projectId, "router", { text: "spawn-idle" });
      await waitFor(async () => {
        const board = await client.getBoard(projectId);
        const w1 = board.workers.find((w) => w.id === "w1");
        return w1?.tasks.some((t) => t.id === "task-1" && t.status === "running") ?? false;
      }, "task-1 running before server close");

      const events: TaskStreamEvent[] = [];
      const streamDone = (async () => {
        for await (const evt of client.streamWorkerTask(projectId, "w1", "task-1")) {
          events.push(evt);
        }
      })();
      await waitFor(() => events.length >= 1, "snapshot received before server close");
      await foreground.close();
      await streamDone;
      const lastEvent = events.at(-1);
      assert.equal(lastEvent?.type, "end");
      if (lastEvent?.type === "end") {
        assert.equal(lastEvent.reason, "closed");
      }
    } finally {
      await foreground.close();
    }
  });
});
