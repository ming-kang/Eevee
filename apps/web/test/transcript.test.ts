import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BoardViewPayload,
  ConversationViewPayload,
  EntryRecordPayload,
} from "@eevee/protocol";
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
    type: "task_notification",
    taskId: "task-1",
    taskStatus: "cancelled",
    taskCancelReason: "user",
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
