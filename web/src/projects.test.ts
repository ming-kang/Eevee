import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardView, ProjectSummary, TicketView } from "../../src/api/contract.ts";
import type { TicketId, TicketStage } from "../../src/contracts/index.ts";
import { buildPaletteItems, deriveProjectState, filterPaletteItems } from "./projects.ts";

function makeTicket(id: TicketId, stage: TicketStage, jobs = 0, closed = false): TicketView {
  return {
    ticket: {
      id,
      role: "worker",
      title: `工单 ${id}`,
      goal: "",
      inputs: [],
      acceptance: [],
      deliverTo: [],
      conversationId: 1,
      status: closed ? "done" : "open",
      createdAt: 100,
    },
    stage,
    reports: [],
    jobs: Array.from({ length: jobs }, (_, i) => ({
      id: `j${i + 1}`,
      ticketId: id,
      command: "sleep 10",
      status: "running" as const,
      startedAt: 100,
    })),
  };
}

test("deriveProjectState 严格按 待回答 > Router 失败 > 执行中 > 静息 优先级判断", () => {
  const runningBoard: BoardView = {
    tickets: [makeTicket("t1", "working"), makeTicket("t2", "jobs", 1), makeTicket("t3", "idle")],
    openQuestions: [],
    router: { running: false },
  };

  // 4. 空闲 / 静息
  const idle = deriveProjectState({
    board: { tickets: [makeTicket("t1", "idle")], openQuestions: [], router: { running: false } },
    activeAt: 12345,
  });
  assert.equal(idle.kind, "rest");
  assert.equal(idle.activeAt, 12345);

  // 3a. 有工单在执行中
  const runTicket = deriveProjectState({ board: runningBoard });
  assert.equal(runTicket.kind, "run");
  assert.equal(runTicket.openCount, 3);
  assert.equal(runTicket.runningTickets, 2);
  assert.equal(runTicket.jobCount, 1);

  // 3b. Router 运行中
  const runRouter = deriveProjectState({
    board: { tickets: [], openQuestions: [], router: { running: false } },
    router: { running: true },
  });
  assert.equal(runRouter.kind, "run");
  assert.equal(runRouter.routerRunning, true);

  // 3c. 未传 live 时回退使用 BoardView.router 状态与失败原因
  const boardRouterRun = deriveProjectState({
    board: { tickets: [], openQuestions: [], router: { running: true } },
  });
  assert.equal(boardRouterRun.kind, "run");
  assert.equal(boardRouterRun.routerRunning, true);

  const boardRouterFailed = deriveProjectState({
    board: {
      tickets: [],
      openQuestions: [],
      router: { running: false, failure: { reason: "model_error", detail: "401" } },
    },
  });
  assert.equal(boardRouterFailed.kind, "bad");
  assert.equal(boardRouterFailed.routerFailed, "模型调用失败：401");

  // 2. Router 失败优先于执行中
  const failed = deriveProjectState({
    board: runningBoard,
    router: { running: false, failure: { reason: "model_error", detail: "429 Too Many Requests" } },
  });
  assert.equal(failed.kind, "bad");

  // 1. 待回答问题优先级最高（过滤已回答问题）
  const answer = deriveProjectState({
    board: {
      ...runningBoard,
      openQuestions: [
        { id: "q1", items: [{ text: "Q1", options: ["A"] }], answer: "A", askedAt: 1 },
        { id: "q2", items: [{ text: "Q2", options: ["A"] }], askedAt: 2 },
      ],
    },
    router: { running: false, failure: { reason: "model_error", detail: "429" } },
  });
  assert.equal(answer.kind, "user");
  assert.equal(answer.questionCount, 1);
});

test("buildPaletteItems 与 filterPaletteItems 生成并过滤页面、工单、项目与操作", () => {
  const projects: ProjectSummary[] = [
    { id: "p1", title: "光学论文", workspace: "D:/papers/optics", createdAt: 1 },
    { id: "p2", title: "后端重构", workspace: "D:/work/eevee", createdAt: 2 },
  ];
  const boards = {
    p1: {
      board: {
        tickets: [makeTicket("t4", "answer")],
        openQuestions: [],
        router: { running: false },
      },
    },
    p2: { board: { tickets: [], openQuestions: [], router: { running: false } } },
  };

  const items = buildPaletteItems({
    projects,
    boards,
    activeProjectId: "p1",
    sideShortcut: "Ctrl B",
  });

  assert.equal(
    items.some((i) => i.group === "工单" && i.id === "ticket:p1:t4"),
    true,
  );
  assert.equal(
    items.some((i) => i.group === "项目" && i.meta === "1 张未结"),
    true,
  );
  assert.equal(filterPaletteItems(items, "t4").length, 1);
  assert.equal(filterPaletteItems(items, "eevee").length, 1);
});
