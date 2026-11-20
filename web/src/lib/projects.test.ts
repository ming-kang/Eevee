import assert from "node:assert/strict";
import { test } from "node:test";
import type { TicketId, TicketStage } from "../../../src/domain/index.ts";
import type { BoardView, ProjectSummary, TicketView } from "../../../src/protocol/contract.ts";
import {
  buildPaletteItems,
  deriveProjectState,
  filterPaletteItems,
  filterSidebarProjects,
  readProjectSeen,
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
    openProposals: [],
    openQuestions: [],
    router: { running: false },
  };

  // 4. idle / at rest
  const idle = deriveProjectState({
    board: {
      tickets: [makeTicket("t1", "idle")],
      openProposals: [],
      openQuestions: [],
      router: { running: false },
    },
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
    board: { tickets: [], openProposals: [], openQuestions: [], router: { running: false } },
    router: { running: true },
  });
  assert.equal(runRouter.kind, "run");
  assert.equal(runRouter.routerRunning, true);

  // 3c. without a live value, fall back to BoardView.router status and failure
  const boardRouterRun = deriveProjectState({
    board: { tickets: [], openProposals: [], openQuestions: [], router: { running: true } },
  });
  assert.equal(boardRouterRun.kind, "run");
  assert.equal(boardRouterRun.routerRunning, true);

  const boardRouterFailed = deriveProjectState({
    board: {
      tickets: [],
      openProposals: [],
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
      openProposals: [],
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

test("pending memory proposals demand project attention even without open questions", () => {
  const state = deriveProjectState({
    board: {
      tickets: [],
      openQuestions: [],
      openProposals: [
        {
          id: "m1",
          scope: "global",
          source: { kind: "dreaming", ticketId: "t1" },
          summary: "Advice",
        },
      ],
      router: { running: false },
    },
  });
  assert.equal(state.kind, "user");
  assert.equal(state.proposalCount, 1);
  assert.equal(state.questionCount, 0);
});

test("project status priority is Pending > Failed/blocked > unread completion > Running > idle", () => {
  for (const pending of ["none", "question", "answer", "review", "proposal"]) {
    for (const failure of ["none", "router", "blocked"]) {
      for (const unread of [false, true]) {
        for (const running of ["none", "worker", "router", "jobs"]) {
          const closed = makeTicket("t9", "idle", 0, true);
          closed.ticket.closedAt = 200;
          const board: BoardView = {
            tickets: [closed],
            openQuestions: [],
            openProposals: [],
            router: {
              running: running === "router",
              ...(failure === "router"
                ? { failure: { reason: "model_error", detail: "401" } as const }
                : {}),
            },
          };
          if (pending === "question") board.openQuestions.push({ id: "q1", items: [], askedAt: 1 });
          if (pending === "answer" || pending === "review")
            board.tickets.push(makeTicket("t1", pending));
          if (pending === "proposal")
            board.openProposals.push({
              id: "m1",
              scope: "project",
              source: { kind: "dreaming", ticketId: "t1" },
              summary: "Advice",
            });
          if (failure === "blocked") board.tickets.push(makeTicket("t2", "blocked"));
          if (running === "worker") board.tickets.push(makeTicket("t3", "working"));
          if (running === "jobs") board.tickets.push(makeTicket("t4", "jobs", 1));
          const state = deriveProjectState({ board, lastSeenAt: unread ? 199 : 200 });
          const expected =
            pending !== "none"
              ? "user"
              : failure !== "none"
                ? "bad"
                : unread
                  ? "unread"
                  : running !== "none"
                    ? "run"
                    : "rest";
          assert.equal(state.kind, expected, JSON.stringify({ pending, failure, unread, running }));
          assert.equal(state.unreadCount, unread ? 1 : 0);
          assert.equal(state.reviewCount, pending === "review" ? 1 : 0);
          assert.equal(state.blockedCount, failure === "blocked" ? 1 : 0);
        }
      }
    }
  }
});

test("unread completions respect per-project persisted watermarks and ignore cancelled/undated tickets", () => {
  const closed = makeTicket("t1", "idle", 0, true);
  closed.ticket.closedAt = 200;
  const cancelled = makeTicket("t2", "idle", 0, true);
  cancelled.ticket.status = "cancelled";
  cancelled.ticket.closedAt = 300;
  const board: BoardView = {
    tickets: [closed, cancelled, makeTicket("t3", "idle", 0, true)],
    router: { running: false },
    openQuestions: [],
    openProposals: [],
  };
  const seen = readProjectSeen('{"p1":200,"p2":100}');
  assert.equal(deriveProjectState({ board, lastSeenAt: seen.p1 }).kind, "rest");
  assert.equal(deriveProjectState({ board, lastSeenAt: seen.p2 }).kind, "unread");
  assert.equal(deriveProjectState({ board }).unreadCount, 1);
  assert.equal(deriveProjectState({}).kind, "rest");
  for (const raw of [null, "", "oops", "[]", "null", "42"])
    assert.deepEqual(readProjectSeen(raw), {});
  assert.deepEqual(
    readProjectSeen('{"good":10,"zero":0,"bad":"20","negative":-1,"infinite":1e999}'),
    { good: 10, zero: 0 },
  );
});

test("buildPaletteItems and filterPaletteItems build and filter pages, tickets, projects and actions", () => {
  const projects: ProjectSummary[] = [
    { id: "p1", title: "Optics paper", workspaces: ["D:/papers/optics"], createdAt: 1 },
    { id: "p2", title: "Backend rewrite", workspaces: ["D:/work/eevee"], createdAt: 2 },
  ];
  const boards = {
    p1: {
      board: {
        tickets: [makeTicket("t4", "answer")],
        openProposals: [],
        openQuestions: [],
        router: { running: false },
      },
    },
    p2: {
      board: { tickets: [], openProposals: [], openQuestions: [], router: { running: false } },
    },
  };

  const items = buildPaletteItems({
    projects,
    boards,
    activeProjectId: "p1",
    sideShortcut: "Ctrl B",
  });

  assert.equal(
    items.some((i) => i.group === "Tickets" && i.id === "ticket:p1:t4"),
    true,
  );
  assert.equal(
    items.some((i) => i.group === "Projects" && i.meta === "1 open"),
    true,
  );
  assert.deepEqual(
    items.find((i) => i.id === "nav:overview"),
    {
      id: "nav:overview",
      group: "Go to",
      label: "Overview",
      search: "Overview overview home now dashboard",
      kind: "route",
      route: { name: "overview" },
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
    search("nav:control:general"),
    "Control · General settings general theme palette font size language",
  );
  assert.equal(search("nav:control:models"), "Control · Models settings models thinking");
  assert.equal(search("nav:control:roles"), "Control · Roles settings roles");
});

test("palette offers every Control section without requiring projects", () => {
  const items = buildPaletteItems({ projects: [], boards: {} });
  for (const section of ["memory", "usage", "general", "models", "roles", "mcp", "engine"]) {
    const item = items.find((entry) => entry.id === `nav:control:${section}`);
    assert.ok(item?.kind === "route");
    assert.deepEqual(item.route, { name: "control", section });
  }
  assert.equal(
    items.some((item) => item.id.startsWith("nav:settings:")),
    false,
  );
});

test("sidebar search filters projects by title, id and workspaces, not tickets", () => {
  const projects: ProjectSummary[] = [
    { id: "p1", title: "Optics paper", workspaces: ["D:/papers/optics"], createdAt: 1 },
    { id: "p2", title: "Backend rewrite", workspaces: ["D:/work/eevee"], createdAt: 2 },
  ];
  assert.deepEqual(filterSidebarProjects(projects, "  "), projects);
  assert.deepEqual(filterSidebarProjects(projects, " BACKEND "), [projects[1]]);
  assert.deepEqual(filterSidebarProjects(projects, "p1"), [projects[0]]);
  assert.deepEqual(filterSidebarProjects(projects, "WORK/EEVEE"), [projects[1]]);
  assert.deepEqual(filterSidebarProjects(projects, "t9"), []);
  assert.deepEqual(filterSidebarProjects(projects, "working"), []);
  assert.deepEqual(filterSidebarProjects([], ""), []);
});
