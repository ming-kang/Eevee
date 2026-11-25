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
  OkResponseSchema,
  ProblemSchema,
  parseWithSchema,
  ReadWorkerTaskResponseSchema,
  SendMessageResponseSchema,
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

      // Auth checks on 4B routes
      const unauthRoutes: [string, string][] = [
        ["GET", `/projects/${projectId}/conversations/router/entries`],
        ["POST", `/projects/${projectId}/conversations/router/interrupt`],
        ["POST", `/projects/${projectId}/conversations/router/retry`],
        ["POST", `/projects/${projectId}/questions/q1/answer`],
        ["GET", `/projects/${projectId}/workers/w1/tasks/task-1`],
        ["POST", `/projects/${projectId}/workers/w1/tasks/task-1/kill`],
      ];
      for (const [method, path] of unauthRoutes) {
        const res = await fetch(`${foreground.url}${path}`, { method });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get("www-authenticate"), "Bearer");
        parseWithSchema(ProblemSchema, await res.json());
      }

      // 405 + Allow checks
      const methodChecks: [string, string, string][] = [
        ["POST", `/projects/${projectId}/conversations/router/entries`, "GET"],
        ["GET", `/projects/${projectId}/conversations/router/interrupt`, "POST"],
        ["GET", `/projects/${projectId}/conversations/router/retry`, "POST"],
        ["GET", `/projects/${projectId}/questions/q1/answer`, "POST"],
        ["POST", `/projects/${projectId}/workers/w1/tasks/task-1`, "GET"],
        ["GET", `/projects/${projectId}/workers/w1/tasks/task-1/kill`, "POST"],
      ];
      for (const [method, path, allow] of methodChecks) {
        const res = await fetch(`${foreground.url}${path}`, { method, headers: auth });
        assert.equal(res.status, 405);
        assert.equal(res.headers.get("allow"), allow);
        parseWithSchema(ProblemSchema, await res.json());
      }

      // Segment and query validation
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

      // Collect all entries ascending with limit=2
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

      // Collect all entries descending with limit=2
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

      // Bounded minEntryId / maxEntryId
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

      // Invalid cursor variants -> 400 invalid_query
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

      // Mismatched scan order with valid cursor -> 400 invalid_query
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

      // Unknown worker -> 404 worker_not_found
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

      // While w1 is running and w2 is queued:
      // 1. retry(w1) -> 409 conversation_busy
      await assert.rejects(
        client.retry(projectId, "w1"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 409 &&
          err.problem.code === "conversation_busy",
      );

      // 2. retry(w2) -> 409 worker_queued
      await assert.rejects(
        client.retry(projectId, "w2"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 409 &&
          err.problem.code === "worker_queued",
      );

      // 3. Interrupt w1 mid-turn
      const interrupted = await client.interrupt(projectId, "w1");
      parseWithSchema(OkResponseSchema, interrupted);
      assert.equal(interrupted.ok, true);

      // w1 is now idle (w2 may run on the pump; wait until w1 has no active run)
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

      // 4. First retry hits simulated model error; second retry recovers and completes!
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

      // Router closes w1 after handoff
      await waitFor(async () => {
        const board = await client.getBoard(projectId);
        return board.workers.some((w) => w.id === "w1" && w.status === "closed");
      }, "w1 to close via router");

      // 5. retry(w1) when closed -> 409 worker_closed
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

      // 404 unknown question
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

      // 400 answer count mismatch
      await assert.rejects(
        client.answerQuestion(projectId, "q1", { answers: ["only-one"] }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 400 &&
          err.problem.code === "invalid_request",
      );

      // 200 valid answer
      const answered = await client.answerQuestion(projectId, "q1", {
        answers: ["8080", "localhost"],
      });
      parseWithSchema(AnswerQuestionResponseSchema, answered);
      assert.equal(answered.question.id, "q1");
      assert.deepEqual(answered.question.answers, ["8080", "localhost"]);
      assert.ok(answered.question.answeredAt !== undefined);

      // 409 already answered
      await assert.rejects(
        client.answerQuestion(projectId, "q1", { answers: ["8080", "localhost"] }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 409 &&
          err.problem.code === "question_closed",
      );

      // Router resumes with user's answers
      await waitFor(async () => {
        const page = await client.listEntries(projectId, "router", { order: "descending" });
        return page.entries.some((entry) =>
          JSON.stringify(entry).includes("using port 8080 on localhost"),
        );
      }, "router to resume after answer");

      // Also verify withdrawn question -> 409 question_closed
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

test("readWorkerTask supports head/tail/sinceBytes and killWorkerTask stops task without waking Worker or Router", async () => {
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

      // Wait until worker finishes its turn announcing task-1
      await waitFor(async () => {
        const entries = await client.listEntries(projectId, "w1", { order: "ascending" });
        return entries.entries.some((e) => JSON.stringify(e).includes("started background task-1"));
      }, "w1 initial turn to settle");

      // Wait for at least two lines of output
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

      // Wait for additional bytes and read incrementally with sinceBytes
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

      // Tail read check
      const tailRead = await client.readWorkerTask(projectId, "w1", "task-1", {
        mode: "tail",
        bytes: 256,
      });
      parseWithSchema(ReadWorkerTaskResponseSchema, tailRead);
      assert.ok(tailRead.output.text.length > 0);

      // Unknown worker -> 404 worker_not_found on task endpoints
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

      // Unknown task -> 404 task_not_found
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

      const routerBeforeKill = await client.listEntries(projectId, "router", { limit: 500 });
      const workerBeforeKill = await client.listEntries(projectId, "w1", { limit: 500 });
      const fauxCallsBeforeKill = faux.state.callCount;

      // Kill task-1 -> 200 status="killed"
      const killed = await client.killWorkerTask(projectId, "w1", "task-1");
      parseWithSchema(KillWorkerTaskResponseSchema, killed);
      assert.equal(killed.task.status, "killed");

      // Second kill -> 409 task_not_running
      await assert.rejects(
        client.killWorkerTask(projectId, "w1", "task-1"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 409 &&
          err.problem.code === "task_not_running",
      );

      // Give event loop a brief settle window and confirm neither Worker nor Router woke up.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const routerAfterKill = await client.listEntries(projectId, "router", { limit: 500 });
      const workerAfterKill = await client.listEntries(projectId, "w1", { limit: 500 });
      assert.equal(routerAfterKill.entries.length, routerBeforeKill.entries.length);
      assert.equal(workerAfterKill.entries.length, workerBeforeKill.entries.length);
      assert.equal(faux.state.callCount, fauxCallsBeforeKill);

      const boardAfterKill = await client.getBoard(projectId);
      const w1 = boardAfterKill.workers.find((w) => w.id === "w1");
      assert.equal(w1?.status, "idle");
      assert.equal(w1?.activeTaskCount, 0);
    } finally {
      await foreground.close();
    }
  });
});
