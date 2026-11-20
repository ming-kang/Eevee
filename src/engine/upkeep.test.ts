import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { eeveePaths } from "../shared/paths.ts";
import { type Brain, call, openTestProject, say, textOf, toolName } from "./testing.ts";

test("project upkeep captures hand edits even when Dreaming is disabled", async () => {
  const project = await openTestProject(() => say("OK."));
  try {
    const paths = eeveePaths(project.home);
    await writeFile(join(paths.project(project.host.meta.id).memory, "manual.md"), "hand edited\n");
    await writeFile(join(paths.globalMemory, "MEMORY.md"), "global hand edit\n");
    const saved = await project.until(async () => {
      const history = await project.host.memory.history("project");
      return history.find((change) => change.files.some((file) => file.path === "manual.md"));
    });
    assert.deepEqual(saved.source, { kind: "user" });
    const global = await project.until(async () =>
      (await project.host.memory.history("global")).find((change) => change.source.kind === "user"),
    );
    assert.equal(global.files[0]?.path, "MEMORY.md");
  } finally {
    await project.close();
  }
});

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
    await project.host.conversations.send("router", "start work");
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

const DREAMING = { enabled: true, idleMs: 0, minGapMs: 0, afterTickets: 1, afterLessons: 5 };

test("the dreamer's automatic acceptance withdraws the question that was waiting on its ticket", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const brain: Brain = ({ role, last }) => {
    if (role === "dreamer") {
      // Hold the tidying ticket open until the question it should have withdrawn is on the board.
      return gate.then(() =>
        call("report", { status: "ready", summary: "tidied up", artifacts: [] }),
      );
    }
    if (role === "worker") {
      return call("report", { status: "ready", summary: "did the work", artifacts: [] });
    }
    if (last?.role === "user" && textOf(last).includes("start work")) {
      return call("ticket", {
        action: "create",
        title: "some work",
        goal: "do it",
        acceptance: ["done"],
      });
    }
    if (last?.role === "user" && textOf(last).includes("report · ready")) {
      return call("ticket", { action: "review", ticketId: "t1", verdict: "accept", note: "ok" });
    }
    if (last?.role === "user" && textOf(last).includes("ask about the tidying ticket")) {
      return call("ask_user", {
        items: [{ text: "which one", options: ["alpha", "beta"], recommended: "alpha" }],
        ticketId: "t2",
      });
    }
    return say("OK.");
  };

  const project = await openTestProject(brain, { dreaming: DREAMING });
  try {
    await project.host.conversations.send("router", "start work");
    const dreaming = await project.until(async () => {
      const ticket = (await project.host.board()).tickets.find((t) => t.ticket.role === "dreamer");
      return ticket?.ticket.status === "open" ? ticket : false;
    });
    await project.host.conversations.send("router", "ask about the tidying ticket");
    const question = await project.until(async () => (await project.host.board()).openQuestions[0]);
    assert.equal(question.ticketId, dreaming.ticket.id);

    release();
    const closed = await project.until(async () => {
      const ticket = (await project.host.board()).tickets.find((t) => t.ticket.role === "dreamer");
      return ticket?.ticket.status === "done" ? ticket : false;
    });
    assert.equal(closed.ticket.role, "dreamer");
    assert.deepEqual((await project.host.board()).openQuestions, []);
    await assert.rejects(
      project.host.questions.answer(question.id, "alpha"),
      (error: unknown) =>
        (error as { problem?: { code?: string } }).problem?.code === "no_question",
    );
  } finally {
    release();
    await project.close();
  }
});

test("a closed dreaming ticket leaves proposals; approval commits and rejection wakes the Router", async () => {
  let dreamerEdits = 0;
  const brain: Brain = ({ role, last }) => {
    if (role === "dreamer") {
      if (toolName(last) === "memory") {
        if (dreamerEdits++ === 0)
          return call("memory", {
            action: "write",
            scope: "global",
            file: "MEMORY.md",
            content: "Proposed global advice\n",
          });
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
    }
    if (role === "worker") {
      return call("report", { status: "ready", summary: "did the work", artifacts: [] });
    }
    if (last?.role === "user" && textOf(last).includes("start work")) {
      return call("ticket", {
        action: "create",
        title: "some work",
        goal: "do it",
        acceptance: ["done"],
      });
    }
    if (last?.role === "user" && textOf(last).includes("report · ready")) {
      return call("ticket", { action: "review", ticketId: "t1", verdict: "accept", note: "ok" });
    }
    return say("OK.");
  };
  const project = await openTestProject(brain, { dreaming: DREAMING });
  try {
    await project.host.conversations.send("router", "start work");
    const done = await project.until(async () => {
      const ticket = (await project.host.board()).tickets.find((t) => t.ticket.role === "dreamer");
      return ticket?.ticket.status === "done" && ticket;
    });
    assert.equal(done.ticket.title, "Tidy up the memory store");
    assert.ok(done.ticket.inputs.some((input) => input.startsWith("transcript://")));
    const proposals = await project.until(async () => {
      const pending = (await project.host.proposals.list()).filter((p) => p.status === "pending");
      return pending.length === 2 && pending;
    });
    assert.equal(
      (await project.host.memory.files("project")).some((f) => f.path === "dream.md"),
      false,
    );
    await sleep(700);
    const dreamers = (await project.host.board()).tickets.filter(
      (t) => t.ticket.role === "dreamer",
    );
    assert.equal(dreamers.length, 1);
    const local = proposals.find((p) => p.scope === "project");
    const global = proposals.find((p) => p.scope === "global");
    assert.ok(local && global);
    const change = await project.host.proposals.approve(local.id);
    assert.deepEqual(change.source, { kind: "dreaming", ticketId: done.ticket.id });
    assert.equal((await project.host.memory.file("project", "dream.md")).content, "- tidied\n");
    await project.host.proposals.reject(global.id, "Keep global advice unchanged");
    await project.until(async () =>
      project.calls.some(
        (turn) =>
          turn.role === "router" &&
          /Memory proposal .*rejected/.test(textOf(turn.last)) &&
          textOf(turn.last).includes("Keep global advice unchanged"),
      ),
    );
  } finally {
    await project.close();
  }
});
