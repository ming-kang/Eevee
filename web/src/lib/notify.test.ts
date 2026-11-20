import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardView, TicketView } from "../../../src/api/contract.ts";
import type { Question, TicketId, TicketStage } from "../../../src/contracts/index.ts";
import { boardEvents } from "./notify.ts";

function ticket(id: TicketId, stage: TicketStage, closed = false, createdAt = 100): TicketView {
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
      createdAt,
    },
    stage,
    reports: [],
    jobs: [],
  };
}

function question(id: `q${number}`, text = `Question ${id}`): Question {
  return { id, items: [{ text, options: [] }], askedAt: 1 };
}

function board(partial: Partial<BoardView>): BoardView {
  return { tickets: [], openQuestions: [], router: { running: false }, ...partial };
}

const PROJECT = { id: "p1", title: "Optics" };

test("the first snapshot seeds and emits nothing", () => {
  const next = board({
    openQuestions: [question("q1")],
    tickets: [ticket("t1", "blocked")],
    router: { running: false, failure: { reason: "model_error" } },
  });
  assert.deepEqual(boardEvents(undefined, next, PROJECT), []);
});

test("a new open question notifies; an answered or already-present one does not", () => {
  const prev = board({ openQuestions: [question("q1")] });
  const next = board({ openQuestions: [question("q1"), question("q2", "  Which\n template?  ")] });
  const events = boardEvents(prev, next, PROJECT);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.tag, "p1:q:q2");
  assert.equal(events[0]?.title, "Optics asks you");
  assert.equal(events[0]?.body, "Which template?");
  assert.deepEqual(events[0]?.route, { name: "chat", pid: "p1" });

  const answered = board({
    openQuestions: [question("q1"), { ...question("q3"), answer: "x" }],
  });
  assert.deepEqual(boardEvents(prev, answered, PROJECT), []);
});

test("a ticket whose stage becomes blocked notifies once, pointing at the worker", () => {
  const prev = board({ tickets: [ticket("t3", "working"), ticket("t4", "blocked")] });
  const next = board({ tickets: [ticket("t3", "blocked"), ticket("t4", "blocked")] });
  const events = boardEvents(prev, next, PROJECT);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.tag, "p1:t:t3:blocked");
  assert.equal(events[0]?.body, "Ticket t3");
  assert.deepEqual(events[0]?.route, { name: "worker", pid: "p1", tid: "t3" });
});

test("a Router failure notifies when it newly appears, not while it persists", () => {
  const prev = board({});
  const failed = board({
    router: { running: false, failure: { reason: "model_error", detail: "429" } },
  });
  const events = boardEvents(prev, failed, PROJECT);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.title, "The Router failed · Optics");
  assert.equal(events[0]?.body, "Model call failed: 429");
  assert.deepEqual(events[0]?.route, { name: "chat", pid: "p1" });

  assert.deepEqual(boardEvents(failed, failed, PROJECT), []);
});
