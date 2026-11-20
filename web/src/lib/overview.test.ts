import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question, TicketId, TicketStage } from "../../../src/domain/index.ts";
import type { BoardView, ProjectSummary, TicketView } from "../../../src/protocol/contract.ts";
import { buildOverviewBoard, DONE_WINDOW_MS, overviewProjectId, pendingRoute } from "./overview.ts";

const NOW = 1_000_000_000;

test("pending memory proposals are board attention rows, including global proposals", () => {
  const overview = buildOverviewBoard({
    projects: [{ id: "p1", title: "Project", workspaces: ["/work"], createdAt: 0 }],
    boards: {
      p1: {
        board: {
          tickets: [],
          openQuestions: [],
          router: { running: false },
          openProposals: [
            {
              id: "m1",
              scope: "global",
              summary: "Advice",
              source: { kind: "dreaming", ticketId: "t1" },
            },
          ],
        },
      },
    },
    now: NOW,
  });
  assert.equal(overview.pending[0]?.kind, "proposal");
  assert.ok(overview.pending[0]?.kind === "proposal" && overview.pending[0].proposal.id === "m1");
  assert.equal(overview.pendingCount, 1);
  assert.deepEqual(pendingRoute(overview.pending[0]), {
    name: "control",
    section: "memory",
    pid: "p1",
  });
});

function project(id: string, title = `Project ${id}`): ProjectSummary {
  return { id, title, workspaces: [`/work/${id}`], createdAt: 1 };
}

function ticket(
  id: TicketId,
  stage: TicketStage,
  opts: { jobs?: number; createdAt?: number; closed?: boolean; closedAt?: number } = {},
): TicketView {
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
      status: opts.closed ? "done" : "open",
      createdAt: opts.createdAt ?? 100,
      ...(opts.closedAt === undefined ? {} : { closedAt: opts.closedAt }),
    },
    stage,
    reports: [],
    jobs: Array.from({ length: opts.jobs ?? 0 }, (_, i) => ({
      id: `j${i + 1}` as const,
      ticketId: id,
      command: "sleep 10",
      status: "running" as const,
      startedAt: 500 + i,
    })),
  };
}

function question(id: `q${number}`, askedAt: number, ticketId?: TicketId): Question {
  return {
    id,
    ...(ticketId === undefined ? {} : { ticketId }),
    items: [{ text: `Question ${id}\nwith extra lines`, options: [] }],
    askedAt,
  };
}

function board(partial: Partial<BoardView>): BoardView {
  return {
    tickets: [],
    openProposals: [],
    openQuestions: [],
    router: { running: false },
    ...partial,
  };
}

test("an empty set of projects or boards gives an empty overview board", () => {
  const empty = buildOverviewBoard({ projects: [], boards: {}, now: NOW });
  assert.deepEqual(empty, {
    pending: [],
    running: [],
    done: [],
    pendingCount: 0,
    runningCount: 0,
    doneCount: 0,
  });

  const unwatched = buildOverviewBoard({
    projects: [project("p1")],
    boards: {},
    now: NOW,
  });
  assert.equal(unwatched.pending.length, 0);
  assert.equal(unwatched.running.length, 0);
});

test("Pending lists open questions newest first, then failed Routers", () => {
  const projects = [project("p1", "One"), project("p2", "Two")];
  const boards = {
    p1: {
      board: board({
        openProposals: [],
        openQuestions: [
          question("q1", 10),
          { ...question("q2", 20, "t3"), answer: "yes" },
          question("q3", 30, "t4"),
        ],
      }),
    },
    p2: {
      board: board({
        openProposals: [],
        openQuestions: [question("q9", 5)],
        router: { running: false, failure: { reason: "model_error", detail: "401" } },
      }),
    },
  };

  const overview = buildOverviewBoard({ projects, boards, now: NOW });
  assert.equal(overview.pending.length, 4);
  assert.deepEqual(
    overview.pending.map((row) => (row.kind === "question" ? row.question.id : row.kind)),
    ["q3", "q1", "q9", "router"],
  );
  const q3 = overview.pending[0];
  assert.equal(q3?.kind, "question");
  assert.equal(q3?.kind === "question" ? q3.text : "", "Question q3 with extra lines");
  assert.equal(q3?.kind === "question" ? q3.question.ticketId : "", "t4");
  const failure = overview.pending[3];
  assert.equal(failure?.kind, "router");
  assert.equal(failure?.kind === "router" ? failure.failure : "", "Model call failed: 401");
});

test("Running lists working and jobs tickets newest activity first, then running Routers", () => {
  const projects = [project("p1"), project("p2"), project("p3")];
  const boards = {
    p1: {
      board: board({
        tickets: [
          ticket("t1", "working", { createdAt: 900 }),
          ticket("t2", "jobs", { jobs: 2, createdAt: 100 }),
          ticket("t3", "answer"),
          ticket("t4", "idle", { closed: true, closedAt: NOW - 100 }),
        ],
      }),
    },
    p2: { board: board({ router: { running: true } }) },
    p3: { board: board({}) },
  };

  const overview = buildOverviewBoard({ projects, boards, now: NOW });
  // t1's creation (900) is newer than t2's latest job start (501); answer/idle/closed stay out.
  assert.deepEqual(
    overview.running.map((row) => (row.kind === "ticket" ? row.view.ticket.id : "router")),
    ["t1", "t2", "router"],
  );
  const t2 = overview.running[1];
  assert.equal(t2?.kind, "ticket");
  assert.equal(t2?.kind === "ticket" ? t2.runningJobs : 0, 2);
  // `at` tracks the newest running job when it beats the ticket's creation.
  assert.equal(t2?.kind === "ticket" ? t2.at : 0, 501);
  assert.equal(overview.runningCount, 3);
});

test("Recently done keeps tickets closed inside the window, newest first", () => {
  const old = ticket("t9", "idle", { closed: true, closedAt: NOW - DONE_WINDOW_MS - 1 });
  const fresh = Array.from({ length: 10 }, (_, i) =>
    ticket(`t${i + 10}` as TicketId, "idle", { closed: true, closedAt: NOW - i }),
  );
  const overview = buildOverviewBoard({
    projects: [project("p1")],
    boards: { p1: { board: board({ tickets: [old, ...fresh] }) } },
    now: NOW,
  });

  assert.equal(overview.done.length, 10);
  assert.equal(overview.doneCount, 10);
  assert.deepEqual(overview.done[0]?.closedAt, NOW);
  assert.equal(
    overview.done.every((row) => row.closedAt > NOW - DONE_WINDOW_MS),
    true,
  );
  // Closed tickets without a timestamp and open ones never appear.
  const noStamp = buildOverviewBoard({
    projects: [project("p1")],
    boards: {
      p1: { board: board({ tickets: [ticket("t1", "idle", { closed: true })] }) },
    },
    now: NOW,
  });
  assert.equal(noStamp.doneCount, 0);
});

test("Pending includes reviews and blocked/failed tickets without duplicating Worker questions", () => {
  const failed = ticket("t3", "blocked");
  failed.reports.push({
    ticketId: "t3",
    seq: 1,
    status: "failed",
    summary: "Worker failed",
    at: NOW,
    artifacts: [],
    handled: false,
    reminded: false,
    origin: { type: "run-failed", failure: { reason: "model_error", detail: "403" } },
  });
  const overview = buildOverviewBoard({
    projects: [project("p1")],
    now: NOW,
    boards: {
      p1: {
        board: board({
          tickets: [
            ticket("t1", "review"),
            ticket("t2", "blocked"),
            failed,
            ticket("t4", "answer"),
            ticket("t5", "answer"),
          ],
          openQuestions: [question("q1", NOW, "t4")],
        }),
      },
    },
  });
  assert.equal(overview.pendingCount, 5);
  assert.equal(overview.runningCount, 0);
  assert.equal(overview.doneCount, 0);
  assert.deepEqual(
    overview.pending.map((row) => (row.kind === "ticket" ? row.view.ticket.id : row.kind)),
    ["question", "t3", "t1", "t2", "t5"],
  );
  const workerQuestion = overview.pending[0];
  assert.ok(workerQuestion?.kind === "question");
  assert.equal(workerQuestion.view?.ticket.title, "Ticket t4");
  assert.deepEqual(pendingRoute(workerQuestion), {
    name: "worker",
    pid: "p1",
    tid: "t4",
    qid: "q1",
  });
  const review = overview.pending.find(
    (row) => row.kind === "ticket" && row.view.ticket.id === "t1",
  );
  assert.ok(review);
  assert.deepEqual(pendingRoute(review), { name: "worker", pid: "p1", tid: "t1" });
});

test("project filters apply to every column and count; invalid saved projects fall back to All", () => {
  const projects = [project("p1"), project("p2")];
  const boards = Object.fromEntries(
    projects.map(({ id }) => [
      id,
      {
        board: board({
          openProposals: [
            {
              id: "m1",
              scope: "project",
              summary: "Advice",
              source: { kind: "dreaming", ticketId: "t1" },
            },
          ],
          tickets: [
            ticket("t1", "review"),
            ticket("t2", "working"),
            ticket("t3", "idle", { closed: true, closedAt: NOW }),
          ],
        }),
      },
    ]),
  );
  const all = buildOverviewBoard({ projects, boards, now: NOW });
  assert.deepEqual([all.pendingCount, all.runningCount, all.doneCount], [4, 2, 2]);
  const filtered = buildOverviewBoard({ projects, boards, now: NOW, projectId: "p2" });
  assert.deepEqual([filtered.pendingCount, filtered.runningCount, filtered.doneCount], [2, 1, 1]);
  assert.ok(
    [...filtered.pending, ...filtered.running, ...filtered.done].every((row) => row.pid === "p2"),
  );
  const invalid = buildOverviewBoard({ projects, boards, now: NOW, projectId: "deleted" });
  assert.deepEqual(invalid, all);
  for (const stored of [null, undefined, "", "deleted"])
    assert.equal(overviewProjectId(projects, stored), "");
  assert.equal(overviewProjectId(projects, "p2"), "p2");
  assert.equal(overviewProjectId([], "p2"), "");
});

test("Router questions and failures still navigate to the Router chat", () => {
  const overview = buildOverviewBoard({
    projects: [project("p1")],
    now: NOW,
    boards: {
      p1: {
        board: board({
          openQuestions: [question("q1", NOW)],
          router: { running: false, failure: { reason: "model_error", detail: "401" } },
        }),
      },
    },
  });
  assert.deepEqual(overview.pending.map(pendingRoute), [
    { name: "chat", pid: "p1", qid: "q1" },
    { name: "chat", pid: "p1" },
  ]);
});

test("two Pending questions on one Worker retain distinct question targets", () => {
  const overview = buildOverviewBoard({
    projects: [project("p1")],
    now: NOW,
    boards: {
      p1: {
        board: board({
          tickets: [ticket("t4", "answer")],
          openQuestions: [question("q1", 1, "t4"), question("q2", 2, "t4")],
        }),
      },
    },
  });
  assert.deepEqual(overview.pending.map(pendingRoute), [
    { name: "worker", pid: "p1", tid: "t4", qid: "q2" },
    { name: "worker", pid: "p1", tid: "t4", qid: "q1" },
  ]);
});
