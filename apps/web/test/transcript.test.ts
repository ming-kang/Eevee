import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BoardViewPayload,
  ConversationViewPayload,
  EntryRecordPayload,
} from "@eevee/protocol";
import { noticeMetaLabel } from "../src/components/transcript/noticeMeta.ts";
import {
  buildDisplayItems,
  closedWorkedItems,
  deriveBoardSummary,
  findMatches,
  foldTurns,
  lastContextUsage,
  outlineEntries,
  parseAgentDoc,
  parseInbox,
  parseLiveDoc,
} from "../src/lib/transcript.ts";

function makeView(docs: Record<string, Record<string, unknown>>): ConversationViewPayload {
  return {
    conversation: { id: 1 },
    entries: [],
    docs,
  };
}

test("parseLiveDoc handles empty/invalid docs and extracts partial state and active tools", () => {
  assert.deepEqual(parseLiveDoc(undefined), {
    busy: false,
    turns: 0,
    partialText: "",
    partialThinking: "",
    partialTools: [],
    activeTools: [],
    compacting: false,
  });

  assert.equal(
    parseLiveDoc(
      makeView({ "pi.live": { tools: [{ callId: "x", name: "bash", status: "bogus" }] } }),
    ).busy,
    false,
  );

  const live = parseLiveDoc(
    makeView({
      "pi.live": {
        run: { turns: 3 },
        generation: {
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "checking files" },
              {
                type: "toolCall",
                id: "tc1",
                name: "read",
                arguments: { path: "src/app.ts", offset: 10 },
              },
              { type: "text", text: "Looking at it" },
            ],
          },
          retry: { error: "rate limit" },
        },
        tools: [
          {
            callId: "tc2",
            name: "bash",
            status: "running",
            output: "running tests...",
            diagnostics: [{ severity: "warning", message: "slow command" }],
          },
        ],
        compactions: [{}],
        runFailure: { reason: "model_error", detail: "503" },
      },
    }),
  );

  assert.equal(live.busy, true);
  assert.equal(live.turns, 3);
  assert.equal(live.partialText, "Looking at it");
  assert.equal(live.partialThinking, "checking files");
  assert.equal(live.compacting, true);
  assert.equal(live.retryError, "rate limit");
  assert.deepEqual(live.runFailure, { reason: "model_error", detail: "503" });
  assert.deepEqual(live.partialTools, [
    {
      id: "tc1",
      name: "read",
      label: "src/app.ts:10",
      arguments: { path: "src/app.ts", offset: 10 },
      status: "pending",
    },
  ]);
  assert.deepEqual(live.activeTools, [
    {
      id: "tc2",
      name: "bash",
      label: "bash",
      arguments: {},
      status: "running",
      streamingOutput: "running tests...",
      diagnostics: [{ severity: "warning", message: "slow command" }],
    },
  ]);
});

test("parseInbox, parseAgentDoc, and lastContextUsage parse protocol docs and usage", () => {
  const view = makeView({
    "pi.inbox": {
      items: [
        { id: 1, mode: "steer", content: "focus on tests" },
        { id: 2, mode: "write", entry: { kind: "pi.reset" } },
        { id: 3, mode: "followUp", content: [{ type: "text", text: "then summarize" }] },
      ],
    },
    "pi.agent": {
      model: { provider: "anthropic", modelId: "claude-sonnet-4" },
      thinkingLevel: "high",
      cwd: "/repo",
    },
  });

  assert.deepEqual(parseInbox(view), [
    { id: 1, mode: "steer", text: "focus on tests" },
    { id: 3, mode: "followUp", text: "then summarize" },
  ]);
  assert.deepEqual(parseAgentDoc(view), {
    modelLabel: "anthropic/claude-sonnet-4",
    thinkingLevel: "high",
    cwd: "/repo",
  });

  const entries: EntryRecordPayload[] = [
    {
      id: 1,
      conversationId: 1,
      kind: "pi.assistant",
      model: [{ role: "assistant", content: "hi", usage: { input: 100, cacheRead: 20 } }],
    },
    {
      id: 2,
      conversationId: 1,
      kind: "pi.assistant",
      model: [{ role: "assistant", content: "next", usage: { input: 250, cacheRead: 150 } }],
    },
  ];
  assert.deepEqual(lastContextUsage(entries), { used: 400, cached: 150 });
});

test("buildDisplayItems and foldTurns render tools, notices, edits, and fold completed turns", () => {
  const entries: EntryRecordPayload[] = [
    {
      id: 1,
      conversationId: 1,
      kind: "pi.system",
      model: [{ role: "system", content: "sys" }],
    },
    {
      id: 2,
      conversationId: 1,
      kind: "pi.user",
      model: [{ role: "user", content: "Please fix the bug", timestamp: 1000 }],
    },
    {
      id: 3,
      conversationId: 1,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          timestamp: 2000,
          content: [
            { type: "thinking", thinking: "inspecting" },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
            {
              type: "toolCall",
              id: "c2",
              name: "edit",
              arguments: { path: "a.ts", oldText: "old", newText: "new1\nnew2" },
            },
            { type: "toolCall", id: "c3", name: "spawn_worker", arguments: { name: "builder" } },
            { type: "toolCall", id: "c4", name: "bash", arguments: { command: "npm test" } },
          ],
        },
      ],
    },
    {
      id: 4,
      conversationId: 1,
      kind: "pi.tool-result",
      model: [
        { role: "toolResult", toolCallId: "c1", content: "file content", isError: false },
        { role: "toolResult", toolCallId: "c2", content: "ok", isError: false },
        { role: "toolResult", toolCallId: "c3", content: "spawned w1", isError: false },
        { role: "toolResult", toolCallId: "c4", content: "all pass", isError: false },
      ],
    },
    {
      id: 5,
      conversationId: 1,
      kind: "pi.assistant",
      model: [{ role: "assistant", content: "Fixed the bug.", timestamp: 5500 }],
    },
    {
      id: 6,
      conversationId: 1,
      kind: "eevee.task-notification",
      data: {
        taskId: "task-1",
        status: "cancelled",
        command: "npm run dev",
        cancelReason: "user",
      },
      model: [{ role: "user", content: "Task cancelled", timestamp: 6000 }],
    },
  ];

  const raw = buildDisplayItems(entries, parseLiveDoc(undefined));
  assert.deepEqual(
    raw.map((item) => item.kind),
    ["user", "thinking", "tools", "edit", "dispatch", "bash", "assistant", "notice"],
  );

  const editItem = raw.find((item) => item.kind === "edit");
  assert.ok(editItem && editItem.kind === "edit");
  assert.equal(editItem.added, 2);
  assert.equal(editItem.removed, 1);

  const dispatchItem = raw.find((item) => item.kind === "dispatch");
  assert.ok(dispatchItem && dispatchItem.kind === "dispatch");
  assert.equal(dispatchItem.actions[0]?.workerId, "w1");

  const noticeItem = raw.find((item) => item.kind === "notice");
  assert.ok(noticeItem && noticeItem.kind === "notice");
  assert.deepEqual(noticeItem.meta, {
    kind: "task_notification",
    data: {
      taskId: "task-1",
      status: "cancelled",
      command: "npm run dev",
      cancelReason: "user",
    },
  });

  const folded = foldTurns(raw, false);
  assert.deepEqual(
    folded.map((item) => item.kind),
    ["user", "worked", "notice"],
  );
  const worked = folded[1];
  assert.ok(worked && worked.kind === "worked");
  assert.equal(worked.ms, 4500);
  assert.deepEqual(
    closedWorkedItems(worked).map((c) => c.kind),
    ["dispatch", "assistant"],
  );
  assert.equal(outlineEntries(folded).length, 1);
  assert.equal(outlineEntries(folded)[0]?.reply, "Fixed the bug.");
  assert.deepEqual(findMatches(folded, "bug"), [
    { key: "e:2", hits: 1 },
    { key: worked.key, hits: 1 },
  ]);

  const unfoldedWhileBusy = foldTurns(raw.slice(0, -1), true);
  assert.equal(
    unfoldedWhileBusy.some((item) => item.kind === "worked"),
    false,
  );
});

test("buildDisplayItems merges live partialTools and activeTools through buildToolCallItems", () => {
  const entries: EntryRecordPayload[] = [
    {
      id: 1,
      conversationId: 1,
      kind: "pi.user",
      model: [{ role: "user", content: "Run checks", timestamp: 1000 }],
    },
    {
      id: 2,
      conversationId: 1,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          timestamp: 1500,
          content: [
            {
              type: "toolCall",
              id: "persisted-call",
              name: "bash",
              arguments: { command: "echo hi" },
            },
          ],
        },
      ],
    },
  ];

  const live = parseLiveDoc(
    makeView({
      "pi.live": {
        run: { turns: 1 },
        generation: {
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "planning" },
              {
                type: "toolCall",
                id: "live-read",
                name: "read",
                arguments: { path: "src/index.ts", offset: 4 },
              },
              {
                type: "toolCall",
                id: "live-bash",
                name: "bash",
                arguments: { command: "npm test" },
              },
              {
                type: "toolCall",
                id: "live-edit",
                name: "edit",
                arguments: { path: "src/index.ts", oldText: "a", newText: "b\nc" },
              },
              {
                type: "toolCall",
                id: "live-dispatch",
                name: "spawn_worker",
                arguments: { name: "builder" },
              },
              { type: "text", text: "In progress" },
            ],
          },
        },
        tools: [
          {
            callId: "persisted-call",
            name: "bash",
            status: "running",
            output: "hi...",
          },
          {
            callId: "live-read",
            name: "read",
            status: "running",
            output: "reading lines",
            diagnostics: [{ severity: "info", message: "partial slice" }],
          },
          {
            callId: "live-bash",
            name: "bash",
            status: "running",
            output: "running suite...",
          },
          {
            callId: "live-edit",
            name: "edit",
            status: "running",
          },
          {
            callId: "standalone-grep",
            name: "grep",
            status: "waiting",
            output: "queued search",
          },
        ],
      },
    }),
  );

  const items = buildDisplayItems(entries, live);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["user", "bash", "thinking", "tools", "bash", "edit", "dispatch", "tools", "assistant"],
  );

  const persistedBash = items[1];
  assert.ok(persistedBash && persistedBash.kind === "bash");
  assert.equal(persistedBash.key, "e:2:bash:persisted-call");
  assert.equal(persistedBash.command, "echo hi");
  assert.equal(persistedBash.status, "run");
  assert.equal(persistedBash.output, "hi...");

  const mergedGenericTools = items[3];
  assert.ok(mergedGenericTools && mergedGenericTools.kind === "tools");
  assert.equal(mergedGenericTools.live, true);
  assert.deepEqual(mergedGenericTools.steps, [
    {
      id: "live-read",
      name: "read",
      label: "src/index.ts:4",
      arguments: { path: "src/index.ts", offset: 4 },
      status: "running",
      streamingOutput: "reading lines",
      diagnostics: [{ severity: "info", message: "partial slice" }],
    },
  ]);

  const liveBash = items[4];
  assert.ok(liveBash && liveBash.kind === "bash");
  assert.equal(liveBash.key, "live:bash:live-bash");
  assert.equal(liveBash.command, "npm test");
  assert.equal(liveBash.status, "run");
  assert.equal(liveBash.output, "running suite...");

  const liveEdit = items[5];
  assert.ok(liveEdit && liveEdit.kind === "edit");
  assert.equal(liveEdit.key, "live:edit:live-edit");
  assert.equal(liveEdit.path, "src/index.ts");
  assert.equal(liveEdit.status, "run");
  assert.equal(liveEdit.added, 2);
  assert.equal(liveEdit.removed, 1);

  const liveDispatch = items[6];
  assert.ok(liveDispatch && liveDispatch.kind === "dispatch");
  assert.equal(liveDispatch.live, true);
  assert.equal(liveDispatch.actions[0]?.target, "builder");
  assert.equal(liveDispatch.actions[0]?.status, "run");

  const standaloneTools = items[7];
  assert.ok(standaloneTools && standaloneTools.kind === "tools");
  assert.equal(standaloneTools.live, true);
  assert.deepEqual(standaloneTools.steps, [
    {
      id: "standalone-grep",
      name: "grep",
      label: "grep",
      arguments: {},
      status: "waiting",
      streamingOutput: "queued search",
    },
  ]);

  const folded = foldTurns(items, true);
  assert.equal(
    folded.some((item) => item.kind === "worked"),
    false,
  );
});

test("buildDisplayItems and noticeMetaLabel preserve strongly typed NoticeInfo variants", () => {
  const entries: EntryRecordPayload[] = [
    {
      id: 1,
      conversationId: 1,
      kind: "eevee.notice",
      data: { type: "handoff", workerId: "w1", workerName: "Builder", ticketId: "t1" },
      model: [{ role: "user", content: "Handoff done" }],
    },
    {
      id: 2,
      conversationId: 1,
      kind: "eevee.notice",
      data: { type: "worker_message", workerId: "w2", workerName: "Reviewer" },
      model: [{ role: "user", content: "Need feedback" }],
    },
    {
      id: 3,
      conversationId: 1,
      kind: "eevee.notice",
      data: {
        type: "worker_failed",
        workerId: "w3",
        workerName: "Tester",
        ticketId: "t2",
        reason: "crash",
      },
      model: [{ role: "user", content: "Worker crashed" }],
    },
    {
      id: 4,
      conversationId: 1,
      kind: "eevee.notice",
      data: { type: "question_answered", questionId: "q1", answers: ["Yes"] },
      model: [{ role: "user", content: "Answered Yes" }],
    },
    {
      id: 5,
      conversationId: 1,
      kind: "eevee.task-notification",
      data: { taskId: "bg-7", status: "failed", command: "npm run lint", exitCode: 2 },
      model: [{ role: "user", content: "Lint failed" }],
    },
    {
      id: 6,
      conversationId: 1,
      kind: "eevee.notice",
      data: { type: "custom_event", detail: 42 },
      model: [{ role: "user", content: "Custom notice" }],
    },
  ];

  const notices = buildDisplayItems(entries, parseLiveDoc(undefined));
  assert.equal(notices.length, 6);
  for (const item of notices) {
    assert.equal(item.kind, "notice");
  }

  const [handoff, workerMessage, workerFailed, questionAnswered, taskNote, generic] = notices as [
    Extract<(typeof notices)[number], { kind: "notice" }>,
    Extract<(typeof notices)[number], { kind: "notice" }>,
    Extract<(typeof notices)[number], { kind: "notice" }>,
    Extract<(typeof notices)[number], { kind: "notice" }>,
    Extract<(typeof notices)[number], { kind: "notice" }>,
    Extract<(typeof notices)[number], { kind: "notice" }>,
  ];

  assert.deepEqual(handoff.meta, {
    kind: "notice",
    data: { type: "handoff", workerId: "w1", workerName: "Builder", ticketId: "t1" },
  });
  assert.deepEqual(noticeMetaLabel(handoff.meta), {
    title: "Worker 交棒 · Builder",
    tone: "default",
    stage: "done",
    workerId: "w1",
    ticketId: "t1",
  });

  assert.deepEqual(noticeMetaLabel(workerMessage.meta), {
    title: "Worker 消息 · Reviewer",
    tone: "default",
    stage: "done",
    workerId: "w2",
  });

  assert.deepEqual(noticeMetaLabel(workerFailed.meta), {
    title: "Worker 失败 · Tester",
    tone: "danger",
    stage: "blocked",
    workerId: "w3",
    ticketId: "t2",
  });

  assert.deepEqual(noticeMetaLabel(questionAnswered.meta), {
    title: "用户答复 · q1",
    tone: "default",
    stage: "done",
  });

  assert.deepEqual(noticeMetaLabel(taskNote.meta), {
    title: "后台任务失败 · bg-7",
    tone: "danger",
    stage: "blocked",
    badge: { text: "failed (2)", tone: "negative" },
  });

  assert.deepEqual(generic.meta, { kind: "generic", type: "custom_event" });
  assert.deepEqual(noticeMetaLabel(generic.meta), {
    title: "通知 · custom_event",
    tone: "default",
    stage: "done",
  });
});

test("buildDisplayItems separates user images and <file> parts cleanly", () => {
  const entries: EntryRecordPayload[] = [
    {
      id: 10,
      conversationId: 1,
      kind: "pi.user",
      model: [
        {
          role: "user",
          content: [
            { type: "image", data: "AAAA", mimeType: "image/png" },
            {
              type: "text",
              text: '<file name="a.ts" path="src/a.ts" type="text/typescript" size="12">\nconst x = 1;\n</file>',
            },
            { type: "text", text: "Check @src/a.ts" },
          ],
          timestamp: 1000,
        },
      ],
    },
  ];
  const items = buildDisplayItems(entries, parseLiveDoc(undefined));
  assert.equal(items.length, 1);
  const user = items[0];
  assert.ok(user && user.kind === "user");
  assert.equal(user.text, "Check @src/a.ts");
  assert.deepEqual(user.images, [{ data: "AAAA", mimeType: "image/png" }]);
  assert.deepEqual(user.files, [
    {
      name: "a.ts",
      path: "src/a.ts",
      mimeType: "text/typescript",
      size: 12,
      content: "const x = 1;",
    },
  ]);
});

test("deriveBoardSummary computes stage priority across questions, workers, and tasks", () => {
  assert.deepEqual(deriveBoardSummary(undefined), {
    stage: "idle",
    pendingQuestions: 0,
    activeWorkers: 0,
    runningTasks: 0,
    openTickets: 0,
  });

  const worker = {
    id: "w1" as const,
    name: "worker-1",
    status: "idle" as const,
    cwd: "/repo",
    createdAt: 100,
    activeTaskCount: 0,
    tasks: [],
  };

  const baseBoard: BoardViewPayload = {
    projectId: "proj-1",
    workers: [worker],
    tickets: [{ id: "t1", title: "Task 1", status: "open", workerId: "w1", createdAt: 100 }],
    questions: [],
  };

  assert.equal(deriveBoardSummary(baseBoard).stage, "idle");

  const runningBoard: BoardViewPayload = {
    ...baseBoard,
    workers: [{ ...worker, status: "running", activeTaskCount: 2 }],
  };
  assert.deepEqual(deriveBoardSummary(runningBoard), {
    stage: "working",
    pendingQuestions: 0,
    activeWorkers: 1,
    runningTasks: 2,
    openTickets: 1,
  });

  const questionBoard: BoardViewPayload = {
    ...runningBoard,
    questions: [
      {
        id: "q1",
        askedAt: 200,
        items: [{ question: "Proceed?", options: [{ label: "Yes" }] }],
      },
    ],
  };
  assert.equal(deriveBoardSummary(questionBoard).stage, "answer");
  assert.equal(deriveBoardSummary(questionBoard).pendingQuestions, 1);
});
