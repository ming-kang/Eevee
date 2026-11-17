import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Brain, call, openTestProject, say, textOf, toolName } from "./testing.ts";

test("Worker 运行失败后，引擎替它交一份 failed 报告并唤醒 Router，只报一次", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "worker") throw new Error("403 forbidden");
    if (last?.role === "user" && textOf(last).includes("开工")) {
      return call("ticket", {
        action: "create",
        title: "会失败",
        goal: "试试",
        acceptance: ["无"],
      });
    }
    return say("好的。");
  };
  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("开工");
    const report = await project.until(
      async () => (await project.host.board()).tickets[0]?.reports[0],
    );
    assert.equal(report.status, "failed");
    assert.match(report.summary, /模型调用失败/);
    await project.until(async () =>
      project.calls.some((c) => c.role === "router" && textOf(c.last).includes("报告 · failed")),
    );
    await sleep(400);
    assert.equal((await project.host.board()).tickets[0]?.reports.length, 1);
  } finally {
    await project.close();
  }
});

test("Dreaming 到期后开一张整理工单，列出新记录；整理完自动结单并提交记忆", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role !== "dreamer") return say("好的。");
    if (toolName(last) === "memory") {
      return call("report", { status: "ready", summary: "整理完了", artifacts: [] });
    }
    if (last?.role === "user") {
      return call("memory", {
        action: "create",
        scope: "project",
        file: "dream.md",
        content: "- 整理过\n",
      });
    }
    return say("好的。");
  };
  const project = await openTestProject(brain, { dreamIntervalMs: 300 });
  try {
    await project.host.sendUserMessage("你好");
    const done = await project.until(async () => {
      const ticket = (await project.host.board()).tickets.find((t) => t.ticket.role === "dreamer");
      return ticket?.ticket.status === "done" && ticket;
    });
    assert.equal(done.ticket.title, "整理记忆");
    assert.ok(done.ticket.inputs.some((input) => input.startsWith("transcript://")));
    // The round is committed once the run has ended, which may be just after the ticket closed.
    const subject = `dreaming ${done.ticket.id}: create dream.md`;
    await project.until(async () =>
      (await project.host.memoryLog("project")).some((c) => c.subject === subject),
    );
    // Nothing new happened since, so the next check opens no ticket.
    await sleep(700);
    const dreamers = (await project.host.board()).tickets.filter(
      (t) => t.ticket.role === "dreamer",
    );
    assert.equal(dreamers.length, 1);
  } finally {
    await project.close();
  }
});
