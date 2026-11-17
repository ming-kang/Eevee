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

test("没有任何事实时是闲置", () => {
  assert.equal(deriveStage(facts()), "idle");
});

test("待回答的问题优先级最高", () => {
  assert.equal(
    deriveStage(facts({ openQuestion: true, reports: [report(1, "ready")], running: true })),
    "answer",
  );
});

test("未处理的 ready 是待验收；处理过后看运行状态", () => {
  assert.equal(deriveStage(facts({ reports: [report(1, "ready")] })), "review");
  assert.equal(
    deriveStage(facts({ reports: [report(1, "ready", true)], running: true })),
    "working",
  );
});

test("未处理的 blocked / failed / dropped 都是受阻", () => {
  for (const status of ["blocked", "failed", "dropped"] as const) {
    assert.equal(deriveStage(facts({ reports: [report(1, status)] })), "blocked", status);
  }
});

test("中途报告不影响阶段，只看最新的收尾报告", () => {
  const reports = [report(1, "ready", true), report(2, "waiting", true), report(3, "progress")];
  assert.equal(deriveStage(facts({ reports })), "waiting");
});

test("本轮结束但后台作业在跑", () => {
  assert.equal(deriveStage(facts({ jobsRunning: true })), "jobs");
});
