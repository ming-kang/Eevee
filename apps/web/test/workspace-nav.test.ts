import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BoardViewPayload,
  ProjectId,
  ProjectSummary,
  TicketRecordPayload,
  WorkerBoardItemPayload,
  WorkerId,
} from "@eevee/protocol";
import {
  aggregateProjectsStage,
  openBoardQuestions,
  partitionBoardTickets,
  partitionSidebarWorkers,
  workerStage,
} from "../src/lib/workspace-nav.ts";

function makeWorker(
  id: string,
  status: WorkerBoardItemPayload["status"],
  overrides: Partial<WorkerBoardItemPayload> = {},
): WorkerBoardItemPayload {
  return {
    id: id as WorkerId,
    name: `worker-${id}`,
    cwd: "/tmp/work",
    conversationId: 2,
    createdAt: 100,
    status,
    activeTaskCount: 0,
    tasks: [],
    ...overrides,
  };
}

function makeTicket(
  id: string,
  workerId: string,
  status: TicketRecordPayload["status"],
  overrides: Partial<TicketRecordPayload> = {},
): TicketRecordPayload {
  return {
    id: id as TicketRecordPayload["id"],
    workerId: workerId as WorkerId,
    title: `Ticket ${id}`,
    status,
    createdAt: 100,
    ...overrides,
  };
}

function makeProject(id: string): ProjectSummary {
  return {
    id: id as ProjectId,
    title: id,
    workspaces: ["/tmp/work"],
    createdAt: 1,
    updatedAt: 1,
  };
}

test("partitionSidebarWorkers separates active and closed workers sorted by urgency and recency", () => {
  const { active, closed } = partitionSidebarWorkers([
    makeWorker("w1", "idle", { createdAt: 10 }),
    makeWorker("w2", "closed", { createdAt: 20, closedAt: 50 }),
    makeWorker("w3", "queued", { createdAt: 30 }),
    makeWorker("w4", "running", { createdAt: 15, activeTaskCount: 1 }),
    makeWorker("w5", "running", { createdAt: 40, activeTaskCount: 0 }),
    makeWorker("w6", "closed", { createdAt: 5, closedAt: 90 }),
  ]);

  assert.deepEqual(
    active.map((w) => w.id),
    ["w4", "w5", "w3", "w1"],
  );
  assert.deepEqual(
    closed.map((w) => w.id),
    ["w6", "w2"],
  );
  assert.equal(workerStage(makeWorker("w4", "running")), "working");
  assert.equal(workerStage(makeWorker("w3", "queued")), "queued");
  assert.equal(workerStage(makeWorker("w1", "idle")), "idle");
  assert.equal(workerStage(makeWorker("w2", "closed")), "done");
});

test("aggregateProjectsStage prioritizes answer over working over idle and excludes active project", () => {
  const idleProject = makeProject("p3");
  const projects = [makeProject("p1"), makeProject("p2"), idleProject];
  const boards: Record<string, BoardViewPayload> = {
    p1: {
      workers: [],
      tickets: [],
      questions: [
        {
          id: "q1" as BoardViewPayload["questions"][number]["id"],
          items: [{ question: "Proceed?" }],
          askedAt: 10,
        },
      ],
    },
    p2: {
      workers: [makeWorker("w1", "running")],
      tickets: [],
      questions: [],
    },
    p3: {
      workers: [makeWorker("w1", "idle")],
      tickets: [],
      questions: [],
    },
  };

  assert.equal(aggregateProjectsStage(projects, boards), "answer");
  assert.equal(aggregateProjectsStage(projects, boards, "p1" as ProjectId), "working");
  assert.equal(aggregateProjectsStage([idleProject], boards), "idle");
  assert.equal(openBoardQuestions(boards.p1).length, 1);
  assert.equal(openBoardQuestions(boards.p2).length, 0);
});

test("partitionBoardTickets filters by worker when requested and orders open and ended newest first", () => {
  const tickets = [
    makeTicket("t1", "w1", "open", { createdAt: 10 }),
    makeTicket("t2", "w2", "open", { createdAt: 30 }),
    makeTicket("t3", "w1", "done", { createdAt: 5, closedAt: 40 }),
    makeTicket("t4", "w2", "cancelled", { createdAt: 15, closedAt: 20 }),
  ];

  const all = partitionBoardTickets(tickets);
  assert.deepEqual(
    all.open.map((t) => t.id),
    ["t2", "t1"],
  );
  assert.deepEqual(
    all.ended.map((t) => t.id),
    ["t3", "t4"],
  );

  const w1Only = partitionBoardTickets(tickets, "w1" as WorkerId);
  assert.deepEqual(
    w1Only.open.map((t) => t.id),
    ["t1"],
  );
  assert.deepEqual(
    w1Only.ended.map((t) => t.id),
    ["t3"],
  );
});
