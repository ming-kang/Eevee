import assert from "node:assert/strict";
import { test } from "node:test";
import type { Report, ReportStatus, TicketId } from "../../contracts/index.ts";
import { route } from "./delivery.ts";

const ticket = {
  id: "t1" as const,
  role: "worker" as const,
  title: "仿真",
  deliverTo: [] as TicketId[],
};
const report = (status: ReportStatus, seq = 1): Report => ({
  ticketId: "t1",
  seq,
  status,
  summary: "完成",
  artifacts: [{ path: "out/data.csv", note: "仿真数据" }],
  handled: false,
  reminded: false,
  at: 0,
});

test("收尾报告唤醒 Router，中途报告只记录", () => {
  const [final] = route({ type: "report", ticket, report: report("ready") });
  assert.deepEqual(
    [final?.target, final?.mode, final?.whenBusy],
    [{ kind: "router" }, "wake", "followUp"],
  );
  assert.match(final?.text ?? "", /report:\/\/t1#1/);

  const [progress] = route({ type: "report", ticket, report: report("progress", 2) });
  assert.equal(progress?.mode, "record");
});

test("整理工单的报告不唤醒 Router", () => {
  const [delivery] = route({
    type: "report",
    ticket: { ...ticket, role: "dreamer" },
    report: report("ready"),
  });
  assert.equal(delivery?.mode, "record");
});

test("验收后把结果直接投给 deliverTo 里的工单，Router 只记录", () => {
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

test("归属工单的问题答案直接投给执行对话", () => {
  const deliveries = route({
    type: "question-answered",
    question: { id: "q1", ticketId: "t1", items: [], answer: "用 1550nm", askedAt: 0 },
  });
  assert.deepEqual(deliveries[0]?.target, { kind: "ticket", id: "t1" });
  assert.equal(deliveries[1]?.mode, "record");
});

test("requestId 由事件决定，重复提交可以被去重", () => {
  const event = { type: "report", ticket, report: report("ready", 3) } as const;
  assert.equal(route(event)[0]?.requestId, route(event)[0]?.requestId);
  assert.equal(route(event)[0]?.requestId, "report:t1#3");
});

test("Engine 说的话带着通知数据，用户自己的话不带", () => {
  const [wake] = route({ type: "report", ticket, report: report("ready") });
  assert.deepEqual(wake?.notice, {
    type: "report",
    ticketId: "t1",
    title: "仿真",
    report: report("ready"),
  });
  const [toWorker, routerCopy] = route({
    type: "panel-message",
    id: "m1",
    ticketId: "t1",
    text: "先跑 45°",
    whenBusy: "steer",
  });
  assert.equal(toWorker?.notice, undefined);
  assert.deepEqual(routerCopy?.notice, { type: "panel-message", ticketId: "t1", text: "先跑 45°" });
  const [job] = route({
    type: "job-finished",
    ticketId: "t1",
    jobId: "j2",
    outcome: { status: "exited", exitCode: 0 },
    tail: "done",
  });
  assert.equal(job?.text, "后台作业 job://j2 已结束（退出码 0）。\n输出末尾：\ndone");
  assert.deepEqual(job?.notice, {
    type: "job-finished",
    jobId: "j2",
    outcome: { status: "exited", exitCode: 0 },
    tail: "done",
  });
});
