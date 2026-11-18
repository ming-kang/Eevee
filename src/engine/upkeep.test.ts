import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Brain, call, openTestProject, say, textOf, toolName } from "./testing.ts";

test("when a Worker run fails, the Engine files a failed report for it and wakes the Router, once", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "worker") throw new Error("403 forbidden");
    if (last?.role === "user" && textOf(last).includes("start work")) {
      return call("ticket", {
        action: "create",
        title: "will fail",
        goal: "give it a try",
        acceptance: ["none"],
      });
    }
    return say("OK.");
  };
  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("start work");
    const report = await project.until(
      async () => (await project.host.board()).tickets[0]?.reports[0],
    );
    assert.equal(report.status, "failed");
    assert.match(report.summary, /Model call failed/);
    assert.equal(report.origin?.type, "run-failed");
    assert.match(
      report.origin?.type === "run-failed" ? (report.origin.failure.detail ?? "") : "",
      /403/,
    );
    await project.until(async () =>
      project.calls.some((c) => c.role === "router" && textOf(c.last).includes("report · failed")),
    );
    await sleep(400);
    assert.equal((await project.host.board()).tickets[0]?.reports.length, 1);
  } finally {
    await project.close();
  }
});

test("after the dreaming interval passes, a tidying ticket lists the new records; tidying closes it and commits the memory", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role !== "dreamer") return say("OK.");
    if (toolName(last) === "memory") {
      return call("report", { status: "ready", summary: "tidied up", artifacts: [] });
    }
    if (last?.role === "user") {
      return call("memory", {
        action: "create",
        scope: "project",
        file: "dream.md",
        content: "- tidied\n",
      });
    }
    return say("OK.");
  };
  const project = await openTestProject(brain, { dreamIntervalMs: 300 });
  try {
    await project.host.sendUserMessage("hello");
    const done = await project.until(async () => {
      const ticket = (await project.host.board()).tickets.find((t) => t.ticket.role === "dreamer");
      return ticket?.ticket.status === "done" && ticket;
    });
    assert.equal(done.ticket.title, "Tidy up the memory store");
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
