import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryProposal, Report, ReportStatus, TicketId } from "../../domain/index.ts";
import { route } from "./delivery.ts";

const ticket = {
  id: "t1" as const,
  role: "worker" as const,
  title: "Simulation",
  deliverTo: [] as TicketId[],
};
const report = (status: ReportStatus, seq = 1): Report => ({
  ticketId: "t1",
  seq,
  status,
  summary: "Done",
  artifacts: [{ path: "out/data.csv", note: "Simulation data" }],
  handled: false,
  reminded: false,
  at: 0,
});

test("all proposal decisions go to the Router; only rejected and stale decisions wake it", () => {
  for (const kind of ["router", "dreaming"] as const) {
    for (const status of ["approved", "rejected", "stale"] as const) {
      const proposal: MemoryProposal = {
        id: "m1",
        scope: "global",
        conversationId: 42,
        source: { kind, ticketId: "t9" },
        summary: "edit MEMORY.md",
        actions: [],
        status,
        createdAt: 0,
        reason: "Keep the old advice",
      };
      const [delivery] = route({
        type: "proposal-decided",
        proposal,
        ...(status === "stale" ? { file: "MEMORY.md" } : {}),
      });
      assert.deepEqual(delivery?.target, { kind: "router" });
      assert.equal(delivery?.mode, status === "approved" ? "record" : "wake");
      assert.match(delivery?.text ?? "", /m1.*global/);
      assert.match(delivery?.text ?? "", /Keep the old advice/);
      if (status === "stale") assert.match(delivery?.text ?? "", /Conflicting file: MEMORY.md/);
    }
  }
});

test("A closing report wakes the Router, an interim one is only recorded", () => {
  const [final] = route({ type: "report", ticket, report: report("ready") });
  assert.deepEqual(
    [final?.target, final?.mode, final?.whenBusy],
    [{ kind: "router" }, "wake", "followUp"],
  );
  assert.match(final?.text ?? "", /report:\/\/t1#1/);

  const [progress] = route({ type: "report", ticket, report: report("progress", 2) });
  assert.equal(progress?.mode, "record");
});

test("A dreamer ticket's report does not wake the Router", () => {
  const [delivery] = route({
    type: "report",
    ticket: { ...ticket, role: "dreamer" },
    report: report("ready"),
  });
  assert.equal(delivery?.mode, "record");
});

test("After review the result goes straight to the tickets in deliverTo, the Router only records it", () => {
  const deliveries = route({
    type: "ticket-accepted",
    ticket: { ...ticket, deliverTo: ["t2", "t3"] },
    report: report("ready"),
  });
  assert.deepEqual(
    deliveries.map((d) => [d.target, d.mode]),
    [
      [{ kind: "ticket", id: "t2" }, "wake"],
      [{ kind: "ticket", id: "t3" }, "wake"],
      [{ kind: "router" }, "record"],
    ],
  );
  assert.equal(route({ type: "ticket-accepted", ticket, report: undefined }).length, 0);
});

test("The answer to a ticket's question goes straight to its worker conversation", () => {
  const deliveries = route({
    type: "question-answered",
    question: { id: "q1", ticketId: "t1", items: [], answer: "Use 1550nm", askedAt: 0 },
  });
  assert.deepEqual(deliveries[0]?.target, { kind: "ticket", id: "t1" });
  assert.equal(deliveries[1]?.mode, "record");
  // Nothing marks a delivery as skipping the slot any more: only a ticket's start ever waits for one.
  assert.deepEqual(
    deliveries.map((d) => "direct" in d),
    [false, false],
  );
});

test("The requestId comes from the event, so a repeated submit can be deduplicated", () => {
  const event = { type: "report", ticket, report: report("ready", 3) } as const;
  assert.equal(route(event)[0]?.requestId, route(event)[0]?.requestId);
  assert.equal(route(event)[0]?.requestId, "report:t1#3");
});

test("What the Engine says carries notice data, the user's own words do not", () => {
  const [wake] = route({ type: "report", ticket, report: report("ready") });
  assert.deepEqual(wake?.notice, {
    type: "report",
    ticketId: "t1",
    title: "Simulation",
    report: report("ready"),
  });
  const [toWorker, routerCopy] = route({
    type: "panel-message",
    id: "m1",
    ticketId: "t1",
    text: "Run 45° first",
    whenBusy: "steer",
  });
  assert.equal(toWorker?.notice, undefined);
  assert.deepEqual(routerCopy?.notice, {
    type: "panel-message",
    ticketId: "t1",
    text: "Run 45° first",
  });
  const [job] = route({
    type: "job-finished",
    ticketId: "t1",
    jobId: "j2",
    outcome: { status: "exited", exitCode: 0 },
    tail: "done",
  });
  assert.equal(
    job?.text,
    "Background job job://j2 finished (exit code 0).\nTail of its output:\ndone",
  );
  assert.deepEqual(job?.notice, {
    type: "job-finished",
    jobId: "j2",
    outcome: { status: "exited", exitCode: 0 },
    tail: "done",
  });
});

test("a single-item answer names the question; the withdrawn-message record goes to the Router", () => {
  const [toWorker, routerCopy] = route({
    type: "question-answered",
    question: {
      id: "q2",
      ticketId: "t1",
      items: [{ text: "which port", options: ["1550nm"] }],
      answer: "1550nm",
      askedAt: 0,
    },
  });
  assert.equal(toWorker?.text, "The user answered question q2 (“which port”):\n1550nm");
  assert.deepEqual(toWorker?.notice, {
    type: "answer",
    questionId: "q2",
    question: ["which port"],
    answer: "1550nm",
  });
  assert.equal(routerCopy?.notice?.type, "answer");

  const [withdrawn] = route({ type: "panel-withdrawn", id: "s4", ticketId: "t1", text: "wait" });
  assert.deepEqual(withdrawn?.target, { kind: "router" });
  assert.equal(withdrawn?.mode, "record");
  assert.equal(
    withdrawn?.text,
    "The user withdrew the message sent to t1 before it was read:\nwait",
  );
  assert.equal(withdrawn?.requestId, "panel-withdrawn:s4");
});
