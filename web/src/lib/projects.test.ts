import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardView, ProjectSummary, TicketView } from "../../src/api/contract.ts";
import type { TicketId, TicketStage } from "../../src/contracts/index.ts";
import {
  buildPaletteItems,
  deriveProjectState,
  filterPaletteItems,
  filterSidebarProjects,
  openSidebarTickets,
} from "./projects.ts";

function makeTicket(id: TicketId, stage: TicketStage, jobs = 0, closed = false): TicketView {
  return {
    ticket: {
      id,
      role: "worker",
      title: `Ticket ${id}`,
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

test("deriveProjectState ranks unanswered > Router failure > running > idle", () => {
  const runningBoard: BoardView = {
    tickets: [makeTicket("t1", "working"), makeTicket("t2", "jobs", 1), makeTicket("t3", "idle")],
    openQuestions: [],
    router: { running: false },
  };

  // 4. idle / at rest
  const idle = deriveProjectState({
    board: { tickets: [makeTicket("t1", "idle")], openQuestions: [], router: { running: false } },
    activeAt: 12345,
  });
  assert.equal(idle.kind, "rest");
  assert.equal(idle.activeAt, 12345);

  // 3a. a ticket is working
  const runTicket = deriveProjectState({ board: runningBoard });
  assert.equal(runTicket.kind, "run");
  assert.equal(runTicket.openCount, 3);
  assert.equal(runTicket.runningTickets, 2);
  assert.equal(runTicket.jobCount, 1);

  // 3b. the Router is running
  const runRouter = deriveProjectState({
    board: { tickets: [], openQuestions: [], router: { running: false } },
    router: { running: true },
  });
  assert.equal(runRouter.kind, "run");
  assert.equal(runRouter.routerRunning, true);

  // 3c. without a live value, fall back to BoardView.router status and failure
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
  assert.equal(boardRouterFailed.routerFailed, "Model call failed: 401");

  // 2. a Router failure outranks a working ticket
  const failed = deriveProjectState({
    board: runningBoard,
    router: { running: false, failure: { reason: "model_error", detail: "429 Too Many Requests" } },
  });
  assert.equal(failed.kind, "bad");

  // 1. an unanswered question outranks everything (answered ones are filtered out)
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

test("buildPaletteItems and filterPaletteItems build and filter pages, tickets, projects and actions", () => {
  const projects: ProjectSummary[] = [
    { id: "p1", title: "Optics paper", workspace: "D:/papers/optics", createdAt: 1 },
    { id: "p2", title: "Backend rewrite", workspace: "D:/work/eevee", createdAt: 2 },
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
    activePalette: "ocean",
  });

  assert.equal(
    items.some((i) => i.group === "Tickets" && i.id === "ticket:p1:t4"),
    true,
  );
  assert.equal(
    items.some((i) => i.group === "Projects" && i.meta === "1 open"),
    true,
  );
  assert.equal(
    items.some((i) => i.kind === "palette" && i.palette === "ocean" && i.meta === "Active"),
    true,
  );
  assert.deepEqual(
    items.find((i) => i.id === "nav:home"),
    {
      id: "nav:home",
      group: "Go to",
      label: "Home",
      search: "Home home now dashboard",
      kind: "route",
      route: { name: "home" },
      icon: "home",
    },
  );
  assert.equal(filterPaletteItems(items, "t4").length, 1);
  assert.equal(filterPaletteItems(items, "eevee").length, 1);
});

test("a palette page is found by plain English keywords, never a translated keyword bag", () => {
  const items = buildPaletteItems({ projects: [], boards: {} });
  const search = (id: string): string => items.find((i) => i.id === id)?.search ?? "";
  assert.equal(
    search("nav:settings:general"),
    "Settings · General settings general theme palette font size language",
  );
  assert.equal(search("nav:settings:models"), "Settings · Models settings models thinking");
  assert.equal(search("nav:settings:roles"), "Settings · Roles settings roles");
});

test("openSidebarTickets orders urgent open tickets first and omits closed ones", () => {
  const board: BoardView = {
    tickets: [
      makeTicket("t1", "working"),
      makeTicket("t2", "blocked"),
      makeTicket("t3", "answer"),
      makeTicket("t4", "idle", 0, true),
    ],
    openQuestions: [],
    router: { running: false },
  };
  assert.deepEqual(
    openSidebarTickets(board).map((v) => v.ticket.id),
    ["t3", "t2", "t1"],
  );
});

test("filterSidebarProjects filters by project or ticket and auto-expands ticket matches", () => {
  const projects: ProjectSummary[] = [
    { id: "p1", title: "Optics paper", workspace: "D:/papers/optics", createdAt: 1 },
    { id: "p2", title: "Backend rewrite", workspace: "D:/work/eevee", createdAt: 2 },
  ];
  const boards = {
    p1: {
      board: {
        tickets: [makeTicket("t1", "working"), makeTicket("t9", "idle", 0, true)],
        openQuestions: [],
        router: { running: false },
      },
    },
    p2: {
      board: {
        tickets: [makeTicket("t12", "answer")],
        openQuestions: [],
        router: { running: false },
      },
    },
  };

  const all = filterSidebarProjects(projects, boards, "  ");
  assert.equal(all.length, 2);
  assert.equal(all[0]?.forceExpand, false);
  assert.deepEqual(
    all[0]?.tickets.map((v) => v.ticket.id),
    ["t1"],
  );

  const byTicket = filterSidebarProjects(projects, boards, "t9");
  assert.equal(byTicket.length, 1);
  assert.equal(byTicket[0]?.project.id, "p1");
  assert.equal(byTicket[0]?.forceExpand, true);
  assert.deepEqual(
    byTicket[0]?.tickets.map((v) => v.ticket.id),
    ["t9"],
  );

  const byProj = filterSidebarProjects(projects, boards, "backend");
  assert.equal(byProj.length, 1);
  assert.equal(byProj[0]?.project.id, "p2");
  assert.equal(byProj[0]?.forceExpand, false);
  assert.deepEqual(
    byProj[0]?.tickets.map((v) => v.ticket.id),
    ["t12"],
  );
});
