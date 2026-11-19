import assert from "node:assert/strict";
import { test } from "node:test";
import type { TicketView } from "../../src/api/contract.ts";
import type { Job, Question, Ticket, TicketId, TicketStage } from "../../src/contracts/index.ts";
import {
  collectRunningJobs,
  countPendingQuestions,
  effectiveStage,
  groupTickets,
  reportStage,
  resolveRailTab,
  ticketQuestionSummary,
} from "./board.ts";

function makeTicket(
  id: TicketId,
  stage: TicketStage,
  overrides: {
    status?: Ticket["status"];
    jobs?: Job[];
  } = {},
): TicketView {
  return {
    ticket: {
      id,
      role: "worker",
      title: `Ticket ${id}`,
      goal: `Complete ${id}`,
      inputs: [],
      acceptance: [],
      deliverTo: [],
      conversationId: 1,
      status: overrides.status ?? "open",
      createdAt: 1000,
    },
    stage,
    reports: [],
    jobs: overrides.jobs ?? [],
  };
}

test("effectiveStage uses terminal status for closed tickets", () => {
  assert.equal(effectiveStage(makeTicket("t1", "working")), "working");
  assert.equal(effectiveStage(makeTicket("t2", "idle", { status: "done" })), "done");
  assert.equal(effectiveStage(makeTicket("t3", "blocked", { status: "cancelled" })), "cancelled");
});

test("groupTickets partitions by stage — answer, review, blocked, active — and closed", () => {
  const input = [
    makeTicket("t1", "idle"),
    makeTicket("t2", "cancelled" as TicketStage, { status: "cancelled" }),
    makeTicket("t3", "working"),
    makeTicket("t4", "answer"),
    makeTicket("t5", "done" as TicketStage, { status: "done" }),
    makeTicket("t6", "review"),
    makeTicket("t7", "queued"),
    makeTicket("t8", "blocked"),
    makeTicket("t9", "jobs"),
    makeTicket("t10", "waiting"),
    makeTicket("t11", "working"),
    makeTicket("t12", "answer"),
  ];

  const groups = groupTickets(input);

  assert.deepEqual(
    groups.answer.map((t) => t.ticket.id),
    ["t4", "t12"],
  );
  assert.deepEqual(
    groups.review.map((t) => t.ticket.id),
    ["t6"],
  );
  assert.deepEqual(
    groups.blocked.map((t) => t.ticket.id),
    ["t8"],
  );
  assert.deepEqual(
    groups.active.map((t) => t.ticket.id),
    ["t3", "t11", "t9", "t7", "t10", "t1"],
  );
  assert.deepEqual(
    groups.closed.map((t) => t.ticket.id),
    ["t5", "t2"],
  );
  assert.equal(groups.openCount, 10);
});

test("ticketQuestionSummary picks first unanswered question text for the ticket", () => {
  const questions: Question[] = [
    {
      id: "q1",
      items: [{ text: "Router question", options: ["A"] }],
      askedAt: 100,
    },
    {
      id: "q2",
      ticketId: "t4",
      items: [{ text: "Answered question", options: ["A"] }],
      answer: "A",
      askedAt: 110,
      answeredAt: 120,
    },
    {
      id: "q3",
      ticketId: "t4",
      items: [{ text: "Use a linear axis\nor a log axis?", options: ["Linear", "Log"] }],
      askedAt: 130,
    },
  ];

  assert.equal(ticketQuestionSummary("t4", questions), "Use a linear axis or a log axis?");
  assert.equal(ticketQuestionSummary("t5", questions), undefined);
  assert.equal(countPendingQuestions({ openQuestions: questions }), 2);
});

test("collectRunningJobs returns running jobs only from open tickets", () => {
  const tickets: TicketView[] = [
    makeTicket("t1", "jobs", {
      jobs: [
        { id: "j1", ticketId: "t1", command: "sleep 10", status: "running", startedAt: 10 },
        {
          id: "j2",
          ticketId: "t1",
          command: "echo done",
          status: "exited",
          startedAt: 5,
          endedAt: 6,
        },
      ],
    }),
    makeTicket("t2", "idle", {
      status: "done",
      jobs: [{ id: "j3", ticketId: "t2", command: "stale", status: "running", startedAt: 1 }],
    }),
    makeTicket("t3", "working", {
      jobs: [
        { id: "j4", ticketId: "t3", command: "python sim.py", status: "running", startedAt: 20 },
      ],
    }),
  ];

  const running = collectRunningJobs(tickets);
  assert.deepEqual(
    running.map((item) => [item.job.id, item.ticket.id]),
    [
      ["j1", "t1"],
      ["j4", "t3"],
    ],
  );
});

test("resolveRailTab falls back from detail outside worker view and reportStage maps statuses", () => {
  assert.equal(resolveRailTab("detail", false), "tickets");
  assert.equal(resolveRailTab("detail", true), "detail");
  assert.equal(resolveRailTab("jobs", false), "jobs");

  assert.equal(reportStage("progress"), "progress");
  assert.equal(reportStage("waiting"), "waiting");
  assert.equal(reportStage("ready"), "review");
  assert.equal(reportStage("blocked"), "blocked");
  assert.equal(reportStage("failed"), "blocked");
  assert.equal(reportStage("dropped"), "cancelled");
});
