import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "@earendil-works/pi-schema";
import {
  AnswerQuestionRequestSchema,
  AnswerQuestionResponseSchema,
  AuthTypeSchema,
  BackgroundTaskStatusSchema,
  type BoardStreamEvent,
  BoardViewSchema,
  ConfigBundleSchema,
  ConversationFailedEventSchema,
  ConversationPatchEventSchema,
  ConversationRefSchema,
  ConversationSnapshotEventSchema,
  type ConversationStreamEvent,
  ConversationViewPayloadSchema,
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  DeleteProjectResponseSchema,
  EeveeApiError,
  EeveeClient,
  EngineSettingsSchema,
  GetProjectResponseSchema,
  HealthResponseSchema,
  KillWorkerTaskResponseSchema,
  ListEntriesResponseSchema,
  ListModelsResponseSchema,
  ListProjectsResponseSchema,
  ListProvidersResponseSchema,
  ListWorkerTasksResponseSchema,
  LoginAuthEventSchema,
  LoginCompleteEventSchema,
  LoginErrorEventSchema,
  LoginInputRequestSchema,
  LoginPromptEventSchema,
  type LoginStreamEvent,
  McpServerSnapshotSchema,
  McpStateResponseSchema,
  ModelChoiceSchema,
  ModelInfoSchema,
  ModelProfileSchema,
  ModelProfilesDocumentSchema,
  ModelSlotsOverrideSchema,
  OkResponseSchema,
  OutputSliceSchema,
  PROTOCOL_VERSION,
  ProblemSchema,
  ProjectIdSchema,
  ProjectMemoryResponseSchema,
  ProjectSummarySchema,
  ProjectUsageResponseSchema,
  ProviderSummarySchema,
  PutMcpConfigRequestSchema,
  PutProjectMemoryRequestSchema,
  parseSseStream,
  parseWithSchema,
  QuestionIdSchema,
  QuestionRecordSchema,
  ReadWorkerTaskResponseSchema,
  ReconnectMcpRequestSchema,
  ReconnectMcpResponseSchema,
  RefreshModelsRequestSchema,
  RefreshModelsResponseSchema,
  ScanOrderSchema,
  SchemaValidationError,
  SendMessageRequestSchema,
  SendMessageResponseSchema,
  SetApiKeyRequestSchema,
  StartLoginRequestSchema,
  StartLoginResponseSchema,
  StreamEndEventSchema,
  SubmissionStatusSchema,
  TaskCancelReasonSchema,
  TaskListStatusFilterSchema,
  TaskOutputSliceSchema,
  TaskReadModeSchema,
  TaskShellSchema,
  TaskStreamChunkEventSchema,
  type TaskStreamEvent,
  TaskStreamSnapshotEventSchema,
  TaskStreamStatusEventSchema,
  ThinkingLevelSchema,
  TicketIdSchema,
  TicketRecordSchema,
  TicketStatusSchema,
  UpdateProjectRequestSchema,
  UpsertMcpServerRequestSchema,
  UsageMetricsSchema,
  UsageStateSchema,
  WhenBusySchema,
  WorkerBoardItemSchema,
  WorkerIdSchema,
  WorkerStatusSchema,
} from "../src/index.ts";

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

test("protocol schemas validate canonical IDs and health payloads", () => {
  const checkWorker = compile(WorkerIdSchema);
  const checkTicket = compile(TicketIdSchema);
  const checkHealth = compile(HealthResponseSchema);

  assert.equal(checkWorker.check("w1"), true);
  assert.equal(checkWorker.check("w0"), false);
  assert.equal(checkTicket.check("t12"), true);
  assert.equal(checkTicket.check("x1"), false);
  assert.equal(
    checkHealth.check({ ok: true, protocolVersion: PROTOCOL_VERSION, engineVersion: "0.0.1" }),
    true,
  );
  assert.equal(
    checkHealth.check({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      engineVersion: "0.0.1",
      pid: 1234,
    }),
    true,
  );
  assert.equal(
    checkHealth.check({
      ok: false,
      protocolVersion: PROTOCOL_VERSION,
      engineVersion: "0.0.1",
    }),
    false,
  );
});

test("protocol schemas validate IDs, enums, project, message, board, and stream payloads", () => {
  assert.equal(compile(ProjectIdSchema).check("demo-1.a_b"), true);
  assert.equal(compile(ProjectIdSchema).check("-bad"), false);
  assert.equal(compile(ProjectIdSchema).check("a".repeat(65)), false);
  assert.equal(compile(QuestionIdSchema).check("q1"), true);
  assert.equal(compile(QuestionIdSchema).check("q0"), false);

  const checkRef = compile(ConversationRefSchema);
  assert.equal(checkRef.check("router"), true);
  assert.equal(checkRef.check("w1"), true);
  assert.equal(checkRef.check("w0"), false);
  assert.equal(checkRef.check("other"), false);

  assert.equal(compile(WorkerStatusSchema).check("queued"), true);
  assert.equal(compile(WorkerStatusSchema).check("paused"), false);
  assert.equal(compile(TicketStatusSchema).check("cancelled"), true);
  const checkTaskStatus = compile(BackgroundTaskStatusSchema);
  for (const status of [
    "queued",
    "running",
    "stopping",
    "completed",
    "failed",
    "timed_out",
    "cancelled",
    "interrupted",
  ]) {
    assert.equal(checkTaskStatus.check(status), true);
  }
  assert.equal(checkTaskStatus.check("exited"), false);
  assert.equal(checkTaskStatus.check("killed"), false);
  assert.equal(compile(TaskShellSchema).check("bash"), true);
  assert.equal(compile(TaskShellSchema).check("powershell"), true);
  assert.equal(compile(TaskShellSchema).check("zsh"), false);
  assert.equal(compile(TaskCancelReasonSchema).check("user"), true);
  assert.equal(compile(TaskCancelReasonSchema).check("tool"), true);
  assert.equal(compile(TaskCancelReasonSchema).check("abort"), true);
  assert.equal(compile(TaskListStatusFilterSchema).check("all"), true);
  assert.equal(compile(TaskListStatusFilterSchema).check("active"), true);
  assert.equal(compile(TaskListStatusFilterSchema).check("finished"), true);
  assert.equal(compile(TaskListStatusFilterSchema).check("unknown"), false);
  assert.equal(compile(ThinkingLevelSchema).check("xhigh"), true);
  assert.equal(compile(WhenBusySchema).check("steer"), true);
  assert.equal(compile(SubmissionStatusSchema).check("unanswered"), true);

  assert.equal(compile(ProblemSchema).check({ code: "bad", message: "Nope" }), true);
  assert.equal(compile(ProblemSchema).check({ code: "", message: "Nope" }), false);

  const model = { provider: "openai", modelId: "gpt-4o", thinkingLevel: "medium" as const };
  assert.equal(compile(ModelChoiceSchema).check(model), true);
  assert.equal(
    compile(ModelSlotsOverrideSchema).check({ router: model, worker: model, dreamer: model }),
    true,
  );

  const project = {
    id: "demo",
    title: "Demo",
    workspaces: ["/tmp/demo"],
    memory: "Keep tests fast",
    models: { router: model },
    createdAt: 1,
    updatedAt: 2,
  };
  assert.equal(compile(ProjectSummarySchema).check(project), true);
  assert.equal(compile(CreateProjectRequestSchema).check({ workspaces: ["/tmp/demo"] }), true);
  assert.equal(compile(CreateProjectRequestSchema).check({ workspaces: [] }), false);
  assert.equal(compile(CreateProjectResponseSchema).check({ project }), true);
  assert.equal(compile(ListProjectsResponseSchema).check({ projects: [project] }), true);
  assert.equal(compile(GetProjectResponseSchema).check({ project }), true);

  assert.equal(
    compile(SendMessageRequestSchema).check({ text: "hello", whenBusy: "reject" }),
    true,
  );
  assert.equal(compile(SendMessageRequestSchema).check({ text: "" }), false);
  assert.equal(
    compile(SendMessageResponseSchema).check({ submissionId: 1, status: "placed" }),
    true,
  );

  const board = {
    workers: [
      {
        id: "w1",
        name: "builder",
        cwd: "/tmp/demo",
        conversationId: 2,
        model,
        activeTicketId: "t1",
        createdAt: 10,
        status: "running",
        activeTaskCount: 1,
        tasks: [
          {
            id: "task-1",
            durableTaskId: 4,
            shell: "bash",
            command: "npm test",
            cwd: "/tmp/demo",
            status: "running",
            logPath: "/tmp/log.txt",
            logTruncated: false,
            startedAt: 11,
          },
        ],
      },
    ],
    tickets: [
      {
        id: "t1",
        workerId: "w1",
        title: "Build it",
        status: "open",
        createdAt: 10,
      },
    ],
    questions: [
      {
        id: "q1",
        items: [{ question: "Which target?", options: ["a", "b"], recommended: "a" }],
        askedAt: 12,
      },
    ],
  };
  assert.equal(compile(WorkerBoardItemSchema).check(board.workers[0]), true);
  assert.equal(compile(TicketRecordSchema).check(board.tickets[0]), true);
  assert.equal(compile(QuestionRecordSchema).check(board.questions[0]), true);
  assert.equal(compile(BoardViewSchema).check(board), true);
  assert.equal(
    compile(BoardViewSchema).check({ ...board, workers: [{ ...board.workers[0], extra: 1 }] }),
    false,
  );

  const view = {
    conversation: { id: 1 },
    entries: [
      { id: 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "hi" }] },
    ],
    docs: { "pi.live": {} },
  };
  assert.equal(compile(ConversationViewPayloadSchema).check(view), true);
  assert.equal(compile(ConversationSnapshotEventSchema).check({ view }), true);
  assert.equal(compile(ConversationPatchEventSchema).check({ ops: [], retired: false }), true);
  assert.equal(compile(ConversationFailedEventSchema).check({ message: "boom" }), true);
  assert.equal(compile(StreamEndEventSchema).check({ reason: "ended" }), true);
  assert.equal(compile(StreamEndEventSchema).check({ reason: "terminal" }), true);
  assert.equal(compile(StreamEndEventSchema).check({ reason: "completed" }), true);

  assert.deepEqual(parseWithSchema(ProblemSchema, { code: "x", message: "y" }), {
    code: "x",
    message: "y",
  });
  assert.throws(
    () => parseWithSchema(SendMessageRequestSchema, { text: "" }, "send request"),
    SchemaValidationError,
  );
});

test("parseSseStream handles chunk splits, CRLF/LF/CR, multi-line data, id, comments, and cancellation", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    "\uFEFF: keepalive comment\r",
    "\nid: 1\r",
    'event: snapshot\rdata: {"a":1}\r\n',
    "data: line2\n\n",
    "data:first\n",
    "data:  second\r\r",
    "id: bad\u0000id\nevent: ignored\n\n",
    "event: trailing\ndata: incomplete",
  ];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  const events = [];
  for await (const event of parseSseStream(stream)) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { event: "snapshot", data: '{"a":1}\nline2', id: "1" },
    { event: "message", data: "first\n second", id: "1" },
  ]);

  let cancelled = false;
  const ac = new AbortController();
  const blockingStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("event: one\ndata: ok\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });

  const seen: string[] = [];
  for await (const event of parseSseStream(blockingStream, ac.signal)) {
    seen.push(event.data);
    ac.abort();
  }
  assert.deepEqual(seen, ["ok"]);
  assert.equal(cancelled, true);

  let closedOnBreak = false;
  const infiniteStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode("data: tick\n\n"));
    },
    cancel() {
      closedOnBreak = true;
    },
  });
  for await (const event of parseSseStream(infiniteStream)) {
    assert.equal(event.data, "tick");
    break;
  }
  assert.equal(closedOnBreak, true);
});

test("EeveeClient sends bearer auth, maps Problem errors, validates payloads, and applies delta patches", async () => {
  const requests: { url: string; method: string; auth?: string; body?: string }[] = [];
  const client = new EeveeClient({
    baseUrl: "http://127.0.0.1:4173/",
    token: "secret-token",
    fetch: async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        method: init?.method ?? "GET",
        auth: headers.get("authorization") ?? undefined,
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (url.endsWith("/health")) {
        return Response.json({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          engineVersion: "0.0.1",
          pid: 42,
        });
      }
      if (url.endsWith("/projects/missing")) {
        return Response.json(
          { code: "project_not_found", message: "Unknown project", detail: "missing" },
          { status: 404 },
        );
      }
      if (url.endsWith("/projects/invalid-payload")) {
        return Response.json({ project: { id: "bad!" } }, { status: 200 });
      }
      if (url.endsWith("/projects/demo/board/stream")) {
        return sseResponse([
          `event: board\ndata: ${JSON.stringify({ workers: [], tickets: [], questions: [] })}\n\n`,
          `event: end\ndata: ${JSON.stringify({ reason: "closed" })}\n\n`,
        ]);
      }
      if (url.includes("/projects/demo/conversations/router/stream")) {
        const snapshot = {
          view: {
            conversation: { id: 1 },
            entries: [
              {
                id: 1,
                conversationId: 1,
                kind: "pi.user",
                model: [{ role: "user", content: "hi" }],
              },
            ],
            docs: { "pi.live": {} },
          },
        };
        const patch1 = {
          ops: [
            [
              "s",
              ["docs", "pi.live", "generation"],
              {
                attempt: 1,
                message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
              },
            ],
          ],
          retired: false,
        };
        const patch2 = {
          ops: [["a", ["docs", "pi.live", "generation", "message", "content", 0, "text"], "lo"]],
          retired: false,
        };
        const patch3 = {
          ops: [
            ["p", ["entries"], 1, 0, [{ id: 2, conversationId: 1, kind: "pi.assistant" }]],
            ["d", ["docs", "pi.live", "generation"]],
          ],
          retired: false,
        };
        return sseResponse([
          `id: 1\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
          `event: patch\ndata: ${JSON.stringify(patch1)}\n\n`,
          `event: patch\ndata: ${JSON.stringify(patch2)}\n\n`,
          `id: 2\nevent: patch\ndata: ${JSON.stringify(patch3)}\n\n`,
          `event: failed\ndata: ${JSON.stringify({ message: "temporary" })}\n\n`,
          `event: end\ndata: ${JSON.stringify({ reason: "ended" })}\n\n`,
        ]);
      }
      if (url.includes("/projects/unsafe/conversations/router/stream")) {
        const snapshot = { view: { conversation: { id: 1 }, entries: [], docs: {} } };
        const badPatch = {
          ops: [["s", ["__proto__", "polluted"], true]],
          retired: false,
        };
        return sseResponse([
          `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
          `event: patch\ndata: ${JSON.stringify(badPatch)}\n\n`,
        ]);
      }
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  });

  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(requests[0]?.auth, "Bearer secret-token");

  await assert.rejects(
    client.getProject("missing"),
    (error: unknown) =>
      error instanceof EeveeApiError &&
      error.status === 404 &&
      error.problem.code === "project_not_found",
  );

  await assert.rejects(client.getProject("invalid-payload"), SchemaValidationError);

  const boardEvents: BoardStreamEvent[] = [];
  for await (const event of client.streamBoard("demo")) {
    boardEvents.push(event);
  }
  assert.deepEqual(boardEvents, [
    { type: "board", board: { workers: [], tickets: [], questions: [] } },
    { type: "end", reason: "closed" },
  ]);

  const convEvents: ConversationStreamEvent[] = [];
  for await (const event of client.streamConversation("demo", "router", {
    from: 1,
    min: 10,
    max: 20,
  })) {
    convEvents.push(event);
  }
  assert.equal(convEvents.length, 6);
  assert.equal(convEvents[0]?.type, "snapshot");
  assert.equal(convEvents[2]?.type, "patch");
  if (convEvents[2]?.type === "patch") {
    const live = convEvents[2].view.docs["pi.live"] as {
      generation?: { message?: { content?: Array<{ text?: string }> } };
    };
    assert.equal(live.generation?.message?.content?.[0]?.text, "Hello");
  }
  // Ensure snapshot was not mutated by applyImmutable.
  if (convEvents[0]?.type === "snapshot") {
    assert.deepEqual(convEvents[0].view.docs["pi.live"], {});
    assert.equal(convEvents[0].view.entries.length, 1);
  }
  assert.equal(convEvents[3]?.type, "patch");
  if (convEvents[3]?.type === "patch") {
    assert.equal(convEvents[3].view.entries.length, 2);
    assert.equal(
      (convEvents[3].view.docs["pi.live"] as { generation?: unknown }).generation,
      undefined,
    );
  }
  assert.deepEqual(convEvents[4], { type: "failed", message: "temporary" });
  assert.deepEqual(convEvents[5], { type: "end", reason: "ended" });

  await assert.rejects(async () => {
    for await (const _ of client.streamConversation("unsafe", "router")) {
      // consume
    }
  }, /unsafe path segment|__proto__/);
});

test("protocol 4B schemas and EeveeClient methods validate entries, intervention, answer, tasks, and eventId resume", async () => {
  assert.equal(compile(ScanOrderSchema).check("ascending"), true);
  assert.equal(compile(ScanOrderSchema).check("descending"), true);
  assert.equal(compile(ScanOrderSchema).check("random"), false);

  assert.equal(compile(OkResponseSchema).check({ ok: true }), true);
  assert.equal(compile(OkResponseSchema).check({ ok: false }), false);

  assert.equal(compile(AnswerQuestionRequestSchema).check({ answers: ["yes"] }), true);
  assert.equal(compile(AnswerQuestionRequestSchema).check({ answers: [] }), false);

  const answeredQuestion = {
    id: "q1",
    items: [{ question: "Proceed?" }],
    answers: ["yes"],
    askedAt: 100,
    answeredAt: 200,
  };
  assert.equal(compile(AnswerQuestionResponseSchema).check({ question: answeredQuestion }), true);

  assert.equal(compile(TaskReadModeSchema).check("head"), true);
  assert.equal(compile(TaskReadModeSchema).check("tail"), true);
  assert.equal(compile(TaskReadModeSchema).check("middle"), false);

  const outputSlice = {
    text: "line1\n",
    totalBytes: 6,
    truncated: false,
    fromByte: 0,
    endByte: 6,
    matchedLines: 1,
    totalMatchedLines: 1,
    scanTruncated: false,
  };
  assert.equal(compile(TaskOutputSliceSchema).check(outputSlice), true);
  assert.equal(compile(OutputSliceSchema).check(outputSlice), true);
  assert.equal(compile(TaskOutputSliceSchema).check({ ...outputSlice, totalBytes: -1 }), false);
  assert.equal(compile(TaskOutputSliceSchema).check({ ...outputSlice, matchedLines: -1 }), false);

  const taskRecord = {
    id: "task-1",
    durableTaskId: 4,
    shell: "bash" as const,
    command: "node -e 'console.log(1)'",
    status: "running" as const,
    startedAt: 100,
  };
  const cancelledRecord = {
    ...taskRecord,
    status: "cancelled" as const,
    cancelReason: "user" as const,
    logTruncated: true,
    logError: "disk full",
    endedAt: 300,
  };
  assert.equal(
    compile(ListWorkerTasksResponseSchema).check({ tasks: [taskRecord, cancelledRecord] }),
    true,
  );
  assert.equal(
    compile(ReadWorkerTaskResponseSchema).check({ task: taskRecord, output: outputSlice }),
    true,
  );
  assert.equal(compile(KillWorkerTaskResponseSchema).check({ task: cancelledRecord }), true);
  assert.equal(
    compile(TaskStreamSnapshotEventSchema).check({ task: taskRecord, output: outputSlice }),
    true,
  );
  assert.equal(
    compile(TaskStreamChunkEventSchema).check({
      text: "more\n",
      fromByte: 6,
      endByte: 11,
      totalBytes: 11,
    }),
    true,
  );
  assert.equal(compile(TaskStreamStatusEventSchema).check({ task: cancelledRecord }), true);

  const entriesPage = {
    entries: [
      { id: 2, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "hi" }] },
    ],
    nextCursor: "eyJhZnRlciI6Mn0",
  };
  assert.equal(compile(ListEntriesResponseSchema).check(entriesPage), true);
  assert.equal(compile(ListEntriesResponseSchema).check({ entries: [], nextCursor: "" }), false);

  const calls: { url: string; method: string; headers: Headers; body?: string }[] = [];
  const client = new EeveeClient({
    baseUrl: "http://127.0.0.1:4173",
    token: "tok-4b",
    fetch: async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (url.includes("/conversations/w1/entries")) {
        return Response.json(entriesPage);
      }
      if (url.includes("/conversations/router/entries")) {
        return Response.json({ entries: "invalid" });
      }
      if (url.endsWith("/conversations/w1/interrupt")) {
        return Response.json({ ok: true });
      }
      if (url.endsWith("/conversations/w1/retry")) {
        return Response.json({ submissionId: 9, status: "placed" }, { status: 202 });
      }
      if (url.endsWith("/questions/q1/answer")) {
        return Response.json({ question: answeredQuestion });
      }
      if (url.includes("/workers/w1/tasks/task-1/kill")) {
        return Response.json({ task: cancelledRecord });
      }
      if (url.includes("/workers/w1/tasks/task-1/stream")) {
        const completedRecord = {
          ...taskRecord,
          status: "completed" as const,
          exitCode: 0,
          endedAt: 250,
        };
        return sseResponse([
          `event: snapshot\ndata: ${JSON.stringify({ task: taskRecord, output: outputSlice })}\n\n`,
          `event: chunk\ndata: ${JSON.stringify({ text: "more\n", fromByte: 6, endByte: 11, totalBytes: 11 })}\n\n`,
          `event: status\ndata: ${JSON.stringify({ task: completedRecord })}\n\n`,
          `event: end\ndata: ${JSON.stringify({ reason: "completed" })}\n\n`,
        ]);
      }
      if (url.includes("/workers/w1/tasks/task-2/stream")) {
        const terminalRecord = {
          ...taskRecord,
          id: "task-2",
          status: "completed" as const,
          exitCode: 0,
          endedAt: 200,
        };
        return sseResponse([
          `event: snapshot\ndata: ${JSON.stringify({ task: terminalRecord, output: outputSlice })}\n\n`,
          `event: end\ndata: ${JSON.stringify({ reason: "terminal" })}\n\n`,
        ]);
      }
      if (url.includes("/workers/w1/tasks/task-1")) {
        return Response.json({ task: taskRecord, output: outputSlice });
      }
      if (url.includes("/workers/w1/tasks")) {
        return Response.json({ tasks: [taskRecord] });
      }
      if (url.includes("/conversations/router/stream")) {
        const snapshot = {
          view: {
            conversation: { id: 1 },
            entries: [
              {
                id: 5,
                conversationId: 1,
                kind: "pi.user",
                model: [{ role: "user", content: "q" }],
              },
            ],
            docs: { "pi.live": {} },
          },
        };
        const patch = {
          ops: [["p", ["entries"], 1, 0, [{ id: 6, conversationId: 1, kind: "pi.assistant" }]]],
          retired: false,
        };
        return sseResponse([
          `id: 5\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
          `id: 6\nevent: patch\ndata: ${JSON.stringify(patch)}\n\n`,
          `event: end\ndata: ${JSON.stringify({ reason: "ended" })}\n\n`,
        ]);
      }
      return Response.json({ code: "not_found", message: "missing" }, { status: 404 });
    },
  });

  const listed = await client.listEntries("demo", "w1", {
    order: "ascending",
    limit: 20,
    minEntryId: 1,
    maxEntryId: 50,
    cursor: "abc",
  });
  assert.deepEqual(listed, entriesPage);
  const listUrl = new URL(calls[0]?.url ?? "");
  assert.equal(listUrl.pathname, "/projects/demo/conversations/w1/entries");
  assert.equal(listUrl.searchParams.get("order"), "ascending");
  assert.equal(listUrl.searchParams.get("limit"), "20");
  assert.equal(listUrl.searchParams.get("minEntryId"), "1");
  assert.equal(listUrl.searchParams.get("maxEntryId"), "50");
  assert.equal(listUrl.searchParams.get("cursor"), "abc");

  await assert.rejects(client.listEntries("demo", "router"), SchemaValidationError);

  assert.deepEqual(await client.interrupt("demo", "w1"), { ok: true });
  assert.equal(calls.at(-1)?.method, "POST");
  assert.equal(calls.at(-1)?.body, undefined);

  assert.deepEqual(await client.retry("demo", "w1"), { submissionId: 9, status: "placed" });
  assert.equal(calls.at(-1)?.method, "POST");

  const answered = await client.answerQuestion("demo", "q1", { answers: ["yes"] });
  assert.equal(answered.question.id, "q1");
  assert.equal(calls.at(-1)?.body, JSON.stringify({ answers: ["yes"] }));

  const taskList = await client.listWorkerTasks("demo", "w1", { status: "active", limit: 10 });
  assert.equal(taskList.tasks.length, 1);
  const taskListUrl = new URL(calls.at(-1)?.url ?? "");
  assert.equal(taskListUrl.pathname, "/projects/demo/workers/w1/tasks");
  assert.equal(taskListUrl.searchParams.get("status"), "active");
  assert.equal(taskListUrl.searchParams.get("limit"), "10");

  const taskRead = await client.readWorkerTask("demo", "w1", "task-1", {
    mode: "head",
    bytes: 512,
    sinceBytes: 0,
    endByte: 1024,
    filter: "/line/i",
    contextLines: 2,
  });
  assert.equal(taskRead.output.text, "line1\n");
  const taskReadUrl = new URL(calls.at(-1)?.url ?? "");
  assert.equal(taskReadUrl.searchParams.get("mode"), "head");
  assert.equal(taskReadUrl.searchParams.get("bytes"), "512");
  assert.equal(taskReadUrl.searchParams.get("sinceBytes"), "0");
  assert.equal(taskReadUrl.searchParams.get("endByte"), "1024");
  assert.equal(taskReadUrl.searchParams.get("filter"), "/line/i");
  assert.equal(taskReadUrl.searchParams.get("contextLines"), "2");

  const killed = await client.killWorkerTask("demo", "w1", "task-1");
  assert.equal(killed.task.status, "cancelled");
  assert.equal(killed.task.cancelReason, "user");

  const taskStreamEvents: TaskStreamEvent[] = [];
  for await (const event of client.streamWorkerTask("demo", "w1", "task-1", {
    mode: "tail",
    bytes: 2048,
    sinceBytes: 0,
  })) {
    taskStreamEvents.push(event);
  }
  const taskStreamUrl = new URL(calls.at(-1)?.url ?? "");
  assert.equal(taskStreamUrl.pathname, "/projects/demo/workers/w1/tasks/task-1/stream");
  assert.equal(taskStreamUrl.searchParams.get("mode"), "tail");
  assert.equal(taskStreamUrl.searchParams.get("bytes"), "2048");
  assert.equal(taskStreamUrl.searchParams.get("sinceBytes"), "0");
  assert.deepEqual(
    taskStreamEvents.map((e) => e.type),
    ["snapshot", "chunk", "status", "end"],
  );
  if (taskStreamEvents[1]?.type === "chunk") {
    assert.equal(taskStreamEvents[1].text, "more\n");
    assert.equal(taskStreamEvents[1].fromByte, 6);
    assert.equal(taskStreamEvents[1].endByte, 11);
    assert.equal(taskStreamEvents[1].totalBytes, 11);
  }
  if (taskStreamEvents[3]?.type === "end") {
    assert.equal(taskStreamEvents[3].reason, "completed");
  }

  const terminalEvents: TaskStreamEvent[] = [];
  for await (const event of client.streamWorkerTask("demo", "w1", "task-2")) {
    terminalEvents.push(event);
  }
  assert.deepEqual(
    terminalEvents.map((e) => e.type),
    ["snapshot", "end"],
  );
  if (terminalEvents[1]?.type === "end") {
    assert.equal(terminalEvents[1].reason, "terminal");
  }

  const streamEvents: ConversationStreamEvent[] = [];
  for await (const event of client.streamConversation("demo", "router", { lastEventId: "4" })) {
    streamEvents.push(event);
  }
  assert.equal(calls.at(-1)?.headers.get("last-event-id"), "4");
  assert.equal(streamEvents[0]?.type, "snapshot");
  if (streamEvents[0]?.type === "snapshot") {
    assert.equal(streamEvents[0].eventId, "5");
  }
  assert.equal(streamEvents[1]?.type, "patch");
  if (streamEvents[1]?.type === "patch") {
    assert.equal(streamEvents[1].eventId, "6");
  }
});

test("protocol 4C schemas and EeveeClient methods validate providers, auth, models, mcp, settings, config, and projects", async () => {
  assert.equal(compile(AuthTypeSchema).check("oauth"), true);
  assert.equal(compile(AuthTypeSchema).check("magic"), false);

  const providerSummary = {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    authMethods: {
      apiKey: true,
      apiKeyLogin: true,
      oauth: true,
      oauthName: "Anthropic OAuth",
      oauthLabel: "Sign in with Claude",
    },
    configured: true,
    authType: "oauth" as const,
    authSource: "OAuth",
    modelCount: 3,
  };
  assert.equal(compile(ProviderSummarySchema).check(providerSummary), true);
  assert.equal(compile(ListProvidersResponseSchema).check({ providers: [providerSummary] }), true);
  assert.equal(
    compile(SetApiKeyRequestSchema).check({ key: "sk-123", env: { REGION: "us" } }),
    true,
  );
  assert.equal(compile(StartLoginRequestSchema).check({ type: "oauth" }), true);
  assert.equal(
    compile(StartLoginResponseSchema).check({
      sessionId: "s1",
      providerId: "anthropic",
      type: "oauth",
    }),
    true,
  );
  assert.equal(compile(LoginInputRequestSchema).check({ promptId: "p1", value: "code-1" }), true);
  assert.equal(
    compile(LoginAuthEventSchema).check({
      type: "auth_url",
      url: "https://example.com/auth",
      instructions: "Visit URL",
    }),
    true,
  );
  assert.equal(
    compile(LoginAuthEventSchema).check({
      type: "device_code",
      userCode: "ABCD",
      verificationUri: "https://example.com/device",
    }),
    true,
  );
  assert.equal(
    compile(LoginPromptEventSchema).check({
      promptId: "p1",
      type: "select",
      message: "Choose mode",
      options: [{ id: "pro", label: "Pro" }],
    }),
    true,
  );
  assert.equal(
    compile(LoginCompleteEventSchema).check({ providerId: "anthropic", type: "oauth" }),
    true,
  );
  assert.equal(
    compile(LoginErrorEventSchema).check({ code: "login_failed", message: "Denied" }),
    true,
  );

  const modelInfo = {
    provider: "anthropic",
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    api: "anthropic-messages",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    available: true,
  };
  assert.equal(compile(ModelInfoSchema).check(modelInfo), true);
  assert.equal(compile(ListModelsResponseSchema).check({ models: [modelInfo] }), true);
  assert.equal(
    compile(RefreshModelsRequestSchema).check({ providers: ["openrouter"], force: true }),
    true,
  );
  assert.equal(
    compile(RefreshModelsResponseSchema).check({
      refreshed: true,
      errors: { broken: "timeout" },
    }),
    true,
  );

  const profile = {
    id: "fast",
    model: { provider: "anthropic", modelId: "claude-opus-4-6", thinkingLevel: "low" as const },
    description: "Fast reasoning profile",
  };
  const profilesDoc = { profiles: [profile], notes: "Default to fast for summaries." };
  assert.equal(compile(ModelProfileSchema).check(profile), true);
  assert.equal(compile(ModelProfilesDocumentSchema).check(profilesDoc), true);

  const mcpSnapshot = {
    name: "docs",
    status: "connected" as const,
    enabled: true,
    description: "Docs server",
    instructions: "Use carefully",
    toolCount: 2,
  };
  const mcpState = {
    servers: { docs: { command: "docs-mcp", exposure: "direct" } },
    status: [mcpSnapshot],
  };
  assert.equal(compile(McpServerSnapshotSchema).check(mcpSnapshot), true);
  assert.equal(compile(McpStateResponseSchema).check(mcpState), true);
  assert.equal(compile(PutMcpConfigRequestSchema).check({ servers: mcpState.servers }), true);
  assert.equal(
    compile(UpsertMcpServerRequestSchema).check({ config: { command: "docs-mcp" } }),
    true,
  );
  assert.equal(compile(ReconnectMcpRequestSchema).check({ server: "docs" }), true);
  assert.equal(compile(ReconnectMcpResponseSchema).check({ status: [mcpSnapshot] }), true);

  const settings = {
    maxActiveWorkers: 4,
    backgroundAfterMs: 15_000,
    routerContextTokens: 64_000,
    idleHibernateMs: 300_000,
    models: { router: { provider: "anthropic", modelId: "claude-opus-4-6" } },
  };
  const bundle = {
    version: 1 as const,
    settings,
    modelProfiles: profilesDoc,
    mcpServers: mcpState.servers,
    modelsConfig: { providers: {} },
  };
  assert.equal(compile(EngineSettingsSchema).check(settings), true);
  assert.equal(compile(ConfigBundleSchema).check(bundle), true);
  assert.equal(compile(ConfigBundleSchema).check({ ...bundle, version: 2 }), false);

  assert.equal(
    compile(UpdateProjectRequestSchema).check({
      title: "New Title",
      workspaces: ["/tmp/ws1"],
      memory: null,
      models: null,
    }),
    true,
  );
  assert.equal(compile(DeleteProjectResponseSchema).check({ ok: true, id: "demo" }), true);
  assert.equal(
    compile(ProjectMemoryResponseSchema).check({ projectId: "demo", memory: null }),
    true,
  );
  assert.equal(compile(PutProjectMemoryRequestSchema).check({ memory: "Use strict TS" }), true);

  const usageMetric = {
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
    cacheWrite1h: 2,
    reasoning: 20,
    totalTokens: 150,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
  };
  const usageState = { models: { "anthropic/claude-opus-4-6": usageMetric }, tools: {} };
  assert.equal(compile(UsageMetricsSchema).check(usageMetric), true);
  assert.equal(compile(UsageStateSchema).check(usageState), true);
  assert.equal(
    compile(ProjectUsageResponseSchema).check({ projectId: "demo", usage: usageState }),
    true,
  );

  const project = {
    id: "demo",
    title: "Updated Demo",
    workspaces: ["/tmp/demo"],
    createdAt: 1,
    updatedAt: 2,
  };

  const calls: { url: string; method: string; body?: string }[] = [];
  const client = new EeveeClient({
    baseUrl: "http://127.0.0.1:4173",
    token: "tok-4c",
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (url.endsWith("/providers")) return Response.json({ providers: [providerSummary] });
      if (url.endsWith("/providers/anthropic/auth/api-key")) return Response.json({ ok: true });
      if (url.endsWith("/providers/anthropic/auth")) return Response.json({ ok: true });
      if (url.endsWith("/providers/anthropic/auth/login")) {
        return Response.json(
          { sessionId: "sid-1", providerId: "anthropic", type: "oauth" },
          { status: 201 },
        );
      }
      if (url.endsWith("/providers/anthropic/auth/login/sid-1/stream")) {
        return sseResponse([
          `event: auth\ndata: ${JSON.stringify({ type: "auth_url", url: "https://example.com" })}\n\n`,
          `event: prompt\ndata: ${JSON.stringify({ promptId: "p1", type: "manual_code", message: "Paste code" })}\n\n`,
          `event: complete\ndata: ${JSON.stringify({ providerId: "anthropic", type: "oauth" })}\n\n`,
        ]);
      }
      if (url.endsWith("/providers/anthropic/auth/login/sid-1/input")) {
        return Response.json({ ok: true });
      }
      if (url.endsWith("/providers/anthropic/auth/login/sid-1/cancel")) {
        return Response.json({ ok: true });
      }
      if (url.includes("/models/refresh")) {
        return Response.json({ refreshed: true, errors: {} });
      }
      if (url.endsWith("/models/profiles")) return Response.json(profilesDoc);
      if (url.includes("/models")) return Response.json({ models: [modelInfo] });
      if (url.endsWith("/mcp/reconnect")) return Response.json({ status: [mcpSnapshot] });
      if (url.includes("/mcp/servers/docs") || url.endsWith("/mcp")) return Response.json(mcpState);
      if (url.endsWith("/settings")) return Response.json(settings);
      if (url.endsWith("/config/export") || url.endsWith("/config/import")) {
        return Response.json(bundle);
      }
      if (url.endsWith("/projects/demo/memory")) {
        return Response.json({ projectId: "demo", memory: "Use strict TS" });
      }
      if (url.endsWith("/projects/demo/usage")) {
        return Response.json({ projectId: "demo", usage: usageState });
      }
      if (url.endsWith("/projects/demo") && method === "PATCH") {
        return Response.json({ project });
      }
      if (url.endsWith("/projects/demo") && method === "DELETE") {
        return Response.json({ ok: true, id: "demo" });
      }
      return Response.json({ code: "not_found", message: "Missing" }, { status: 404 });
    },
  });

  assert.equal((await client.listProviders()).providers[0]?.id, "anthropic");
  assert.deepEqual(await client.setProviderApiKey("anthropic", { key: "sk-1" }), { ok: true });
  assert.deepEqual(await client.logoutProvider("anthropic"), { ok: true });
  assert.equal(
    (await client.startProviderLogin("anthropic", { type: "oauth" })).sessionId,
    "sid-1",
  );
  const loginEvents: LoginStreamEvent[] = [];
  for await (const evt of client.streamLoginSession("anthropic", "sid-1")) {
    loginEvents.push(evt);
  }
  assert.deepEqual(
    loginEvents.map((e) => e.type),
    ["auth", "prompt", "complete"],
  );
  assert.deepEqual(
    await client.submitLoginInput("anthropic", "sid-1", { promptId: "p1", value: "abc" }),
    {
      ok: true,
    },
  );
  assert.deepEqual(await client.cancelLoginSession("anthropic", "sid-1"), { ok: true });

  const modelsRes = await client.listModels({ provider: "anthropic", available: true });
  assert.equal(modelsRes.models.length, 1);
  assert.ok(calls.at(-1)?.url.includes("provider=anthropic&available=true"));
  assert.equal(
    (await client.refreshModels({ providers: ["openrouter"], force: true })).refreshed,
    true,
  );
  assert.deepEqual(await client.getModelProfiles(), profilesDoc);
  assert.deepEqual(await client.putModelProfiles(profilesDoc), profilesDoc);

  assert.deepEqual(await client.getMcpState(), mcpState);
  assert.deepEqual(await client.putMcpConfig({ servers: mcpState.servers }), mcpState);
  assert.deepEqual(
    await client.upsertMcpServer("docs", { config: { command: "docs-mcp" } }),
    mcpState,
  );
  assert.deepEqual(await client.deleteMcpServer("docs"), mcpState);
  assert.deepEqual(await client.reconnectMcp({ server: "docs" }), { status: [mcpSnapshot] });

  assert.deepEqual(await client.getSettings(), settings);
  assert.deepEqual(await client.patchSettings({ maxActiveWorkers: 4 }), settings);
  assert.deepEqual(await client.putSettings(settings), settings);
  assert.deepEqual(await client.exportConfig(), bundle);
  assert.deepEqual(await client.importConfig(bundle), bundle);

  assert.deepEqual(await client.updateProject("demo", { title: "Updated Demo" }), { project });
  assert.deepEqual(await client.deleteProject("demo"), { ok: true, id: "demo" });
  assert.deepEqual(await client.getProjectMemory("demo"), {
    projectId: "demo",
    memory: "Use strict TS",
  });
  assert.deepEqual(await client.putProjectMemory("demo", { memory: "Use strict TS" }), {
    projectId: "demo",
    memory: "Use strict TS",
  });
  assert.deepEqual(await client.getProjectUsage("demo"), {
    projectId: "demo",
    usage: usageState,
  });
});
