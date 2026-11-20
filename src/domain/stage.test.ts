import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportStatus } from "./domain.ts";
import { deriveStage, type StageFacts } from "./stage.ts";

const facts = (overrides: Partial<StageFacts> = {}): StageFacts => ({
  openQuestion: false,
  reports: [],
  queued: false,
  running: false,
  jobsRunning: false,
  ...overrides,
});

const report = (seq: number, status: ReportStatus, handled = false) => ({ seq, status, handled });

test("idle when there are no facts", () => {
  assert.equal(deriveStage(facts()), "idle");
});

test("an open question has the highest priority", () => {
  assert.equal(
    deriveStage(facts({ openQuestion: true, reports: [report(1, "ready")], running: true })),
    "answer",
  );
});

test("an unhandled ready is awaiting review; once handled it depends on run state", () => {
  assert.equal(deriveStage(facts({ reports: [report(1, "ready")] })), "review");
  assert.equal(
    deriveStage(facts({ reports: [report(1, "ready", true)], running: true })),
    "working",
  );
});

test("unhandled blocked / failed / dropped are all blocked", () => {
  for (const status of ["blocked", "failed", "dropped"] as const) {
    assert.equal(deriveStage(facts({ reports: [report(1, status)] })), "blocked", status);
  }
});

test("interim reports do not affect the stage; only the latest final report counts", () => {
  const reports = [report(1, "ready", true), report(2, "waiting", true), report(3, "progress")];
  assert.equal(deriveStage(facts({ reports })), "waiting");
});

test("the run ended but background jobs are running", () => {
  assert.equal(deriveStage(facts({ jobsRunning: true })), "jobs");
});
