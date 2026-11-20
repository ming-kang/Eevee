import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question, TicketId, TicketStage } from "../../../src/domain/index.ts";
import type { BoardView, ProjectSummary, TicketView } from "../../../src/protocol/contract.ts";
import { buildHomeBoard, DONE_LIMIT, DONE_WINDOW_MS } from "./home.ts";

const NOW = 1_000_000_000;

test("pending memory proposals are board attention rows, including global proposals", () => {
  const home = buildHomeBoard({
    projects: [{ id: "p1", title: "Project", workspace: "/work", createdAt: 0 }],
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
  assert.equal(home.needsYou[0]?.kind, "proposal");
  assert.ok(home.needsYou[0]?.kind === "proposal" && home.needsYou[0].proposal.id === "m1");
});

function project(id: string, title = `Project ${id}`): ProjectSummary {
  return { id, title, workspace: `/work/${id}`, createdAt: 1 };
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

test("an empty set of projects or boards gives an empty home board", () => {
  const empty = buildHomeBoard({ projects: [], boards: {}, now: NOW });
  assert.deepEqual(empty, {
    needsYou: [],
    running: [],
    done: [],
    runningCount: 0,
    doneCount: 0,
  });

  const unwatched = buildHomeBoard({
    projects: [project("p1")],
    boards: {},
    now: NOW,
  });
  assert.equal(unwatched.needsYou.length, 0);
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

  const home = buildHomeBoard({ projects, boards, now: NOW });
  assert.equal(home.needsYou.length, 4);
  assert.deepEqual(
    home.needsYou.map((row) => (row.kind === "question" ? row.question.id : row.kind)),
    ["q3", "q1", "q9", "router"],
  );
  const q3 = home.needsYou[0];
  assert.equal(q3?.kind, "question");
  assert.equal(q3?.kind === "question" ? q3.text : "", "Question q3 with extra lines");
  assert.equal(q3?.kind === "question" ? q3.question.ticketId : "", "t4");
  const failure = home.needsYou[3];
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

  const home = buildHomeBoard({ projects, boards, now: NOW });
  // t1's creation (900) is newer than t2's latest job start (501); answer/idle/closed stay out.
  assert.deepEqual(
    home.running.map((row) => (row.kind === "ticket" ? row.view.ticket.id : "router")),
    ["t1", "t2", "router"],
  );
  const t2 = home.running[1];
  assert.equal(t2?.kind, "ticket");
  assert.equal(t2?.kind === "ticket" ? t2.runningJobs : 0, 2);
  // `at` tracks the newest running job when it beats the ticket's creation.
  assert.equal(t2?.kind === "ticket" ? t2.at : 0, 501);
  assert.equal(home.runningCount, 3);
});

test("Recently done keeps tickets closed inside the window, newest first, capped", () => {
  const old = ticket("t9", "idle", { closed: true, closedAt: NOW - DONE_WINDOW_MS - 1 });
  const fresh = Array.from({ length: DONE_LIMIT + 2 }, (_, i) =>
    ticket(`t${i + 10}` as TicketId, "idle", { closed: true, closedAt: NOW - i }),
  );
  const home = buildHomeBoard({
    projects: [project("p1")],
    boards: { p1: { board: board({ tickets: [old, ...fresh] }) } },
    now: NOW,
  });

  assert.equal(home.done.length, DONE_LIMIT);
  assert.equal(home.doneCount, DONE_LIMIT + 2);
  assert.deepEqual(home.done[0]?.closedAt, NOW);
  assert.equal(
    home.done.every((row) => row.closedAt > NOW - DONE_WINDOW_MS),
    true,
  );
  // Closed tickets without a timestamp and open ones never appear.
  const noStamp = buildHomeBoard({
    projects: [project("p1")],
    boards: {
      p1: { board: board({ tickets: [ticket("t1", "idle", { closed: true })] }) },
    },
    now: NOW,
  });
  assert.equal(noStamp.doneCount, 0);
});
