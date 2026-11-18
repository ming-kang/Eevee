import assert from "node:assert/strict";
import { test } from "node:test";
import type { Report, ReportStatus, TicketId } from "../../contracts/index.ts";
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
    "Background job job://j2 finished (Exit code 0).\nTail of its output:\ndone",
  );
  assert.deepEqual(job?.notice, {
    type: "job-finished",
    jobId: "j2",
    outcome: { status: "exited", exitCode: 0 },
    tail: "done",
  });
});
