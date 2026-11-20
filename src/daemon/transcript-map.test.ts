import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryId, EntryRecord, TranscriptItem } from "@earendil-works/pi-durable";
import { mapTranscript } from "../../web/src/lib/transcript-map.ts";
import type { JobId, Question, QuestionId, Report, TicketId } from "../domain/index.ts";
import { toSubmission } from "../engine/extensions/orchestration/deliver.ts";
import { type Delivery, route } from "../engine/extensions/orchestration/delivery.ts";

const entry = (
  id: number,
  kind: string,
  model: EntryRecord["model"],
  data?: unknown,
): TranscriptItem => ({
  kind: "entry",
  entry: {
    id: id as EntryId,
    conversationId: 1 as never,
    kind,
    model,
    ...(data === undefined ? {} : { data: data as never }),
  },
});

test("notices from the backend route() each map to one line, long content folding into detail", () => {
  // What the Engine actually persists for a delivery: the panel must read it without its prose.
  const notice = (id: number, delivery: Delivery | undefined): TranscriptItem => {
    const submission = delivery === undefined ? undefined : toSubmission(delivery);
    const data = (submission as { entry?: { data?: unknown } } | undefined)?.entry?.data;
    const text = delivery?.text ?? "";
    return entry(id, "eevee.notice", [{ role: "user", content: text, timestamp: id }], data);
  };
  const t2 = {
    id: "t2" as TicketId,
    role: "worker" as const,
    title: "run the simulation",
    deliverTo: [],
  };
  const report: Report = {
    ticketId: t2.id,
    seq: 1,
    status: "ready",
    summary: "13 angles done",
    artifacts: [{ path: "sim/out/", note: "output" }],
    handled: false,
    reminded: false,
    at: 1,
  };
  const question: Question = {
    id: "q3" as QuestionId,
    ticketId: t2.id,
    items: [{ text: "how dense should the mesh be?", options: ["λ/20", "λ/40"] }],
    answer: "λ/40",
    askedAt: 1,
  };
  const tail = Array.from({ length: 90 }, (_, i) => `[fdtd] step ${i + 1}/90`).join("\n");

  const [jobDone] = route({
    type: "job-finished",
    ticketId: t2.id,
    jobId: "j1" as JobId,
    outcome: { status: "exited", exitCode: 0 },
    tail,
  });
  const [handover] = route({
    type: "ticket-accepted",
    ticket: { ...t2, deliverTo: ["t5" as TicketId] },
    report,
  });
  const worker = mapTranscript([notice(1, jobDone), notice(2, handover)], { mode: "worker" });
  assert.deepEqual(
    worker.map((item) => item.kind === "event" && [item.eventKind, item.text]),
    [
      ["job", "Background job j1 finished (Exit 0)"],
      ["deliver", "t2 “run the simulation”, which this waits on, was accepted"],
    ],
  );
  const [jobItem, handoverItem] = worker;
  assert.ok(jobItem?.kind === "event" && jobItem.detail?.endsWith("[fdtd] step 90/90"));
  assert.ok(handoverItem?.kind === "event" && handoverItem.detail?.includes("13 angles done"));

  const [, answered] = route({ type: "question-answered", question });
  const [reportWake] = route({ type: "report", ticket: t2, report });
  const [, panelRecord] = route({
    type: "panel-message",
    id: "m1",
    ticketId: t2.id,
    text: "run 45° first",
    whenBusy: "steer",
  });
  const [interrupt] = route({ type: "panel-interrupt", id: "i1", ticketId: t2.id });
  const router = mapTranscript(
    [notice(1, answered), notice(2, reportWake), notice(3, panelRecord), notice(4, interrupt)],
    { mode: "router" },
  );
  assert.deepEqual(
    router.map((item) => item.kind === "event" && [item.eventKind, item.ticketId, item.detail]),
    [
      ["answer", "t2", "λ/40"],
      ["report", "t2", undefined],
      ["intervene", "t2", undefined],
      ["intervene", "t2", undefined],
    ],
  );
});
