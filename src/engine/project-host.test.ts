import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { BoardView } from "../api/contract.ts";
import { eeveePaths } from "../shared/paths.ts";
import { type Brain, call, openTestProject, say, textOf, toolName } from "./testing.ts";

test("the Router creates a ticket, the Worker submits ready, the Router accepts and closes it", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("write a hello.txt")) {
        return call("ticket", {
          action: "create",
          title: "write a greeting",
          goal: "write hello.txt in the working directory",
          acceptance: ["hello.txt contains hi"],
        });
      }
      if (last?.role === "user" && textOf(last).includes("report · ready")) {
        return call("ticket", {
          action: "review",
          ticketId: "t1",
          verdict: "accept",
          note: "hello.txt has been written",
        });
      }
      return say("OK.");
    }
    if (toolName(last) === "write") {
      return call("report", {
        status: "ready",
        summary: "done",
        artifacts: [{ path: "hello.txt", note: "greeting" }],
      });
    }
    if (last?.role === "user") return call("write", { path: "hello.txt", content: "hi" });
    return say("Got it.");
  };

  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("write a hello.txt for me");
    const done = await project.until(async () => {
      const board = await project.host.board();
      const ticket = board.tickets[0]?.ticket;
      return ticket?.status === "done" && board.tickets[0];
    });
    assert.equal(done.ticket.closeNote, "hello.txt has been written");
    assert.deepEqual(
      done.reports.map((r) => [r.status, r.handled]),
      [["ready", true]],
    );
    assert.equal(await readFile(join(project.workspace, "hello.txt"), "utf8"), "hi");
  } finally {
    await project.close();
  }
});

test("when a Worker ends without submitting a report, the Engine files a waiting one", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router" && last?.role === "user" && textOf(last).includes("start work")) {
      return call("ticket", {
        action: "create",
        title: "silent",
        goal: "whatever",
        acceptance: ["none"],
      });
    }
    return say(role === "worker" ? "I finished but forgot to submit a report" : "OK.");
  };

  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("start work");
    const report = await project.until(async () => {
      const board = await project.host.board();
      return board.tickets[0]?.reports[0];
    });
    assert.equal(report.status, "waiting");
    assert.match(report.summary, /forgot to submit a report/);
    assert.deepEqual(report.origin, { type: "no-report", answered: true });
    await project.until(async () =>
      project.calls.some((c) => c.role === "router" && textOf(c.last).includes("report · waiting")),
    );
  } finally {
    await project.close();
  }
});

test("an accepted result goes straight to the ticket in deliverTo", async () => {
  const brain: Brain = ({ role, last, messages }) => {
    const opening = textOf(
      messages.find((m) => m.role === "user" && textOf(m).includes("<ticket>")),
    );
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("open two")) {
        return call("ticket", {
          action: "create",
          title: "paper",
          goal: "waiting for data",
          acceptance: ["none"],
        });
      }
      if (toolName(last) === "ticket" && textOf(last).includes("t1")) {
        return call("ticket", {
          action: "create",
          title: "simulation",
          goal: "produce data",
          acceptance: ["has data"],
          deliverTo: ["t1"],
        });
      }
      if (last?.role === "user" && textOf(last).includes("“simulation” report · ready")) {
        return call("ticket", { action: "review", ticketId: "t2", verdict: "accept", note: "ok" });
      }
      return say("OK.");
    }
    if (opening.includes("“simulation”") && last?.role === "user") {
      return call("report", { status: "ready", summary: "data is ready", artifacts: [] });
    }
    if (
      opening.includes("“paper”") &&
      last?.role === "user" &&
      !textOf(last).includes("was accepted")
    ) {
      return call("report", {
        status: "waiting",
        summary: "waiting for data",
        need: "simulation data",
        artifacts: [],
      });
    }
    return say("Got the data.");
  };

  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("open two tickets");
    await project.until(async () =>
      project.calls.some(
        (c) => c.role === "worker" && textOf(c.last).includes("which this waits on"),
      ),
    );
    const board = await project.host.board();
    assert.equal(board.tickets[1]?.ticket.status, "done");
  } finally {
    await project.close();
  }
});

test("a long command moves to the background, and the Worker is woken when the job ends", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("run simulation")) {
        return call("ticket", {
          action: "create",
          title: "simulation",
          goal: "run",
          acceptance: ["done running"],
        });
      }
      return say("OK.");
    }
    if (last?.role === "user" && textOf(last).includes("Background job job://j1 finished")) {
      return call("report", { status: "ready", summary: textOf(last), artifacts: [] });
    }
    if (toolName(last) === "bash") return say("The job runs in the background; ending this turn.");
    if (last?.role === "user") return call("bash", { command: "sleep 1; echo finished" });
    return say("…");
  };

  const project = await openTestProject(brain, { backgroundAfterMs: 200 });
  try {
    await project.host.sendUserMessage("run simulation");
    const jobs = await project.until(async () => {
      const ticket = (await project.host.board()).tickets[0];
      return ticket?.stage === "jobs" && ticket;
    });
    assert.deepEqual(jobs.reports, []);
    const report = await project.until(
      async () => (await project.host.board()).tickets[0]?.reports[0],
    );
    assert.equal(report.status, "ready");
    assert.match(report.summary, /exit code 0[\s\S]*finished/);
    const log = await readFile(
      join(project.home, "projects", project.host.meta.id, "jobs", "j1.log"),
      "utf8",
    );
    assert.match(log, /finished/);
  } finally {
    await project.close();
  }
});

test("accepting a ticket stops its background job, leaves its Worker alone, and records the stop", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("run simulation")) {
        return call("ticket", {
          action: "create",
          title: "simulation",
          goal: "run",
          acceptance: ["done running"],
        });
      }
      if (last?.role === "user" && textOf(last).includes("report · ready")) {
        return call("ticket", {
          action: "review",
          ticketId: "t1",
          verdict: "accept",
          note: "the scan keeps running in the background",
        });
      }
      return say("OK.");
    }
    if (toolName(last) === "bash") {
      return call("report", {
        status: "ready",
        summary: "the scan runs in the background",
        artifacts: [],
      });
    }
    if (last?.role === "user") return call("bash", { command: "sleep 30; echo finished" });
    return say("…");
  };

  const project = await openTestProject(brain, { backgroundAfterMs: 100 });
  try {
    await project.host.sendUserMessage("run simulation");
    const running = await project.until(async () => {
      const ticket = (await project.host.board()).tickets[0];
      const job = ticket?.jobs[0];
      return ticket?.stage === "jobs" && job?.status === "running" ? ticket : false;
    });
    const jobId = running.jobs[0]?.id;
    assert.ok(jobId !== undefined);

    const closed = await project.until(async () => {
      const ticket = (await project.host.board()).tickets[0];
      const settled =
        ticket?.ticket.status === "done" &&
        ticket.ticket.stoppedAt !== undefined &&
        ticket.jobs.length === 0;
      return settled ? ticket : false;
    });
    assert.equal(closed.ticket.closeNote, "the scan keeps running in the background");

    const log = await project.until(async () => {
      const found = await project.host.jobLog(jobId);
      return found.job.status === "killed" ? found : false;
    });
    assert.match(log.content, /\[killed\]/);
    // The job's ticket closed under it, so the Engine stops it without telling the Worker.
    await sleep(400);
    assert.equal(
      project.calls.some((c) =>
        c.role === "worker" ? textOf(c.last).includes("Background job job://j1") : false,
      ),
      false,
    );
  } finally {
    await project.close();
  }
});

test("when an Engine restart interrupts a background job, the Worker is told to check the scene first", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("run a long job")) {
        return call("ticket", {
          action: "create",
          title: "long run",
          goal: "run",
          acceptance: ["done running"],
        });
      }
      return say("OK.");
    }
    if (
      last?.role === "user" &&
      textOf(last).includes("An Engine restart interrupted background jobs")
    ) {
      return call("report", {
        status: "blocked",
        summary: "the job was interrupted",
        artifacts: [],
      });
    }
    if (toolName(last) === "bash") return say("Waiting for the job.");
    if (last?.role === "user") return call("bash", { command: "sleep 30" });
    return say("…");
  };

  const project = await openTestProject(brain, { backgroundAfterMs: 100 });
  try {
    await project.host.sendUserMessage("run a long job");
    await project.until(async () => (await project.host.board()).tickets[0]?.stage === "jobs");
    await project.reopen();
    const report = await project.until(
      async () => (await project.host.board()).tickets[0]?.reports[0],
    );
    assert.equal(report.status, "blocked");
  } finally {
    await project.close();
  }
});

test("tickets beyond the concurrency limit queue, and the next one starts only after a slot frees up", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const brain: Brain = async ({ role, last, messages }) => {
    const opening = textOf(
      messages.find((m) => m.role === "user" && textOf(m).includes("<ticket>")),
    );
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("two things")) {
        return call("ticket", {
          action: "create",
          title: "alpha",
          goal: "alpha",
          acceptance: ["alpha"],
        });
      }
      if (toolName(last) === "ticket" && textOf(last).includes("t1")) {
        return call("ticket", {
          action: "create",
          title: "beta",
          goal: "beta",
          acceptance: ["beta"],
        });
      }
      return say("OK.");
    }
    if (opening.includes("“alpha”")) await gate;
    return call("report", { status: "ready", summary: "done", artifacts: [] });
  };

  const project = await openTestProject(brain, { maxActiveWorkers: 1 });
  try {
    await project.host.sendUserMessage("do two things for me");
    const stages = await project.until(async () => {
      const board = await project.host.board();
      const ready = board.tickets.length === 2 && board.tickets[0]?.stage === "working";
      return ready && board.tickets.map((t) => t.stage);
    });
    assert.deepEqual(stages, ["working", "queued"]);
    assert.equal(
      project.calls.filter((c) => c.role === "worker").length,
      1,
      "beta should not start while alpha holds the slot",
    );
    release();
    await project.until(async () =>
      (await project.host.board()).tickets.every((t) => t.stage === "review"),
    );
  } finally {
    release();
    await project.close();
  }
});

const createOn =
  (keyword: string, title: string): Brain =>
  ({ role, last }) => {
    if (role === "router" && last?.role === "user" && textOf(last).includes(keyword)) {
      return call("ticket", { action: "create", title, goal: title, acceptance: ["none"] });
    }
    return say("OK.");
  };

test("when a closing report goes unhandled, the Engine reminds the Router once", async () => {
  const base = createOn("start work", "stuck");
  const brain: Brain = (turn) => {
    if (turn.role === "worker" && turn.last?.role === "user") {
      return call("report", { status: "blocked", summary: "missing permissions", artifacts: [] });
    }
    return base(turn);
  };
  const project = await openTestProject(brain, { reminderAfterMs: 0 });
  try {
    await project.host.sendUserMessage("start work");
    await project.until(async () =>
      project.calls.some(
        (c) => c.role === "router" && textOf(c.last).includes("Reports still unhandled"),
      ),
    );
    const report = (await project.host.board()).tickets[0]?.reports[0];
    assert.equal(report?.reminded, true);
    const reminders = () =>
      project.calls.filter(
        (c) => c.role === "router" && textOf(c.last).includes("Reports still unhandled"),
      );
    const count = reminders().length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(reminders().length, count);
  } finally {
    await project.close();
  }
});

test("when a Worker's context passes the threshold, its closing report also resets the context", async () => {
  const base = createOn("start work", "long job");
  const brain: Brain = (turn) => {
    if (turn.role === "worker" && turn.last?.role === "user") {
      return call("report", {
        status: "waiting",
        summary: "waiting for materials",
        need: "data",
        artifacts: [],
      });
    }
    return base(turn);
  };
  const project = await openTestProject(brain, { contextWindow: 200, handoffThreshold: 0.1 });
  try {
    await project.host.sendUserMessage("start work");
    const lines = await project.until(async () => {
      const board = await project.host.board();
      if (board.tickets[0]?.reports.length !== 1) return undefined;
      const { lines: transcript } = await project.host.ticketConversation("t1");
      return transcript.some((l) => l.role === "reset") && transcript;
    });
    const reset = lines.find((l) => l.role === "reset");
    assert.match(reset?.text ?? "", /report:\/\/t1#1 · waiting/);
  } finally {
    await project.close();
  }
});

test("a user steers a Worker from the panel, and the Router only records the intervention", async () => {
  const base = createOn("start work", "steerable");
  const brain: Brain = (turn) => {
    if (turn.role === "worker" && textOf(turn.last).includes("try another approach")) {
      return call("report", {
        status: "ready",
        summary: "finished with the new approach",
        artifacts: [],
      });
    }
    if (turn.role === "worker") return say("Leave it here for now.");
    return base(turn);
  };
  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("start work");
    await project.until(async () => (await project.host.board()).tickets[0]?.reports[0]);
    const routerCalls = project.calls.filter((c) => c.role === "router").length;
    await project.host.messageWorker("t1", "try another approach", "steer");
    const ready = await project.until(async () => {
      const reports = (await project.host.board()).tickets[0]?.reports ?? [];
      return reports.find((r) => r.status === "ready");
    });
    assert.equal(ready.summary, "finished with the new approach");
    const { lines: transcript } = await project.host.ticketConversation("t1");
    assert.ok(transcript.some((l) => l.role === "user" && l.text === "try another approach"));
    await project.until(async () =>
      (await project.host.conversation()).lines.some((l) =>
        l.text.includes("The user sent a message straight to t1"),
      ),
    );
    assert.ok(project.calls.filter((c) => c.role === "router").length > routerCalls);
  } finally {
    await project.close();
  }
});

test("a failed model call exposes the reason, and it can be retried once fixed", async () => {
  let broken = true;
  const brain: Brain = () => {
    if (broken) throw new Error("403 forbidden");
    return say("Recovered.");
  };
  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("hello");
    const view = await project.until(async () => {
      const current = await project.host.conversation();
      return current.failure !== undefined && current;
    });
    assert.equal(view.running, false);
    broken = false;
    await project.host.retry();
    await project.until(async () =>
      (await project.host.conversation()).lines.some((l) => l.text === "Recovered."),
    );
    assert.equal((await project.host.conversation()).failure, undefined);
  } finally {
    await project.close();
  }
});

test("read transcript:// pages by entry and gives the positions to page back and forth", async () => {
  const pages: string[] = [];
  const brain: Brain = ({ role, last }) => {
    if (role !== "router") return say("OK.");
    if (last?.role === "user" && textOf(last).includes("page the transcript")) {
      return call("read", { path: "transcript://1", offset: 0, limit: 2 });
    }
    if (toolName(last) === "read" && pages.length === 0) {
      pages.push(textOf(last));
      return call("read", { path: "transcript://1", limit: 2 });
    }
    if (toolName(last) === "read") {
      pages.push(textOf(last));
      return say("Done paging.");
    }
    return say("OK.");
  };
  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("say something first");
    await project.until(async () => project.calls.length >= 1);
    await project.host.sendUserMessage("page the transcript");
    await project.until(async () => pages.length === 2);
    const [fromStart, newest] = pages;
    assert.match(fromStart ?? "", /Newer entries: read\("transcript:\/\/1", offset: \d+\)/);
    assert.match(newest ?? "", /Earlier entries: read\("transcript:\/\/1", offset: \d+\)/);
    assert.match(newest ?? "", /#\d+ tool: /);
  } finally {
    await project.close();
  }
});

test("read the tail of a background job's log and kill the job while it runs", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("run a long job")) {
        return call("ticket", {
          action: "create",
          title: "long job",
          goal: "run",
          acceptance: ["done running"],
        });
      }
      return say("OK.");
    }
    if (toolName(last) === "bash") return say("Waiting for the job.");
    if (last?.role === "user" && textOf(last).includes("killed")) return say("The job was killed.");
    if (last?.role === "user") {
      return call("bash", {
        command: "echo row-1; echo row-2; echo row-3; echo row-4; sleep 30",
      });
    }
    return say("…");
  };

  const project = await openTestProject(brain, { backgroundAfterMs: 100 });
  try {
    await project.host.sendUserMessage("run a long job");
    const jobsTicket = await project.until(async () => {
      const ticket = (await project.host.board()).tickets[0];
      return ticket?.stage === "jobs" && ticket;
    });
    const jobId = jobsTicket.jobs[0]?.id;
    assert.ok(jobId);

    const runningLog = await project.until(async () => {
      const log = await project.host.jobLog(jobId);
      return log.content.includes("row-4") && log;
    });
    assert.equal(runningLog.job.status, "running");
    assert.equal(runningLog.truncated, false);

    const tailed = await project.host.jobLog(jobId, 2);
    assert.equal(tailed.truncated, true);
    assert.deepEqual(tailed.content.trim().split(/\r?\n/), ["row-3", "row-4"]);

    await project.host.killJob(jobId);

    const afterKill = await project.host.jobLog(jobId);
    assert.equal(afterKill.job.status, "killed");
    assert.match(afterKill.content, /\[killed\]/);
    assert.equal((await project.host.board()).tickets[0]?.jobs.length, 0);
    // The ticket is still open: its Worker hears about the kill instead of waiting forever.
    await project.until(async () => {
      const worker = await project.host.ticketConversation(jobsTicket.ticket.id);
      return worker.lines.some((line) => line.text.includes("The job was killed."));
    });

    await assert.rejects(project.host.killJob(jobId), { problem: { code: "job_ended", jobId } });
    const noJob = { problem: { code: "no_job", jobId: "j99" } };
    await assert.rejects(project.host.killJob("j99"), noJob);
    await assert.rejects(project.host.jobLog("j99"), noJob);
  } finally {
    await project.close();
  }
});

test("memoryFiles and memoryFile list and safely read project and global memory files", async () => {
  const project = await openTestProject(() => say("OK."));
  try {
    const projectMemoryDir = join(project.home, "projects", project.host.meta.id, "memory");
    await mkdir(join(projectMemoryDir, "topics"), { recursive: true });
    await writeFile(join(projectMemoryDir, "topics", "sim.md"), "# simulation\n- dt = 0.01\n");

    const files = await project.host.memoryFiles("project");
    assert.equal(files[0]?.path, "MEMORY.md");
    assert.equal(
      files.some((f) => f.path === "topics/sim.md"),
      true,
    );
    assert.equal(
      files.some((f) => f.path.startsWith(".git")),
      false,
    );

    const file = await project.host.memoryFile("project", "topics/sim.md");
    assert.equal(file.path, "topics/sim.md");
    assert.match(file.content, /dt = 0\.01/);

    const globalFiles = await project.host.memoryFiles("global");
    assert.equal(globalFiles[0]?.path, "MEMORY.md");

    for (const file of ["missing.md", "../project.json", ".git/HEAD"]) {
      await assert.rejects(project.host.memoryFile("project", file), {
        problem: { code: "no_memory_file", file },
      });
    }
  } finally {
    await project.close();
  }
});

test("BoardView reflects the Router's run state and failure reason, and ProjectSummary.activeAt persists across restarts", async () => {
  let enteredGate = false;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let shouldFail = false;
  const brain: Brain = async ({ last }) => {
    if (shouldFail) throw new Error("403 forbidden");
    if (last?.role === "user" && textOf(last).includes("reply slowly")) {
      enteredGate = true;
      await gate;
    }
    return say("Done.");
  };

  const project = await openTestProject(brain);
  try {
    const initial = project.host.summary();
    assert.equal(initial.activeAt, project.host.meta.createdAt);
    assert.deepEqual((await project.host.board()).router, { running: false });

    await sleep(20);
    await project.host.sendUserMessage("reply slowly");
    const whileRunning = await project.until(async () => {
      if (!enteredGate) return false;
      const b = await project.host.board();
      return b.router.running && b;
    });
    assert.equal(whileRunning.router.running, true);
    assert.equal(whileRunning.router.failure, undefined);

    releaseGate();
    await project.until(async () => !(await project.host.board()).router.running);

    const afterTurn = project.host.summary().activeAt ?? 0;
    assert.ok(initial.activeAt !== undefined && afterTurn > initial.activeAt);

    shouldFail = true;
    await project.host.sendUserMessage("trigger a failure");
    const failedBoard = await project.until(async () => {
      const b = await project.host.board();
      return b.router.failure !== undefined && b;
    });
    assert.equal(failedBoard.router.running, false);
    assert.match(failedBoard.router.failure?.detail ?? "", /403 forbidden/);

    await project.reopen();
    assert.ok((project.host.summary().activeAt ?? 0) >= afterTurn);
    assert.match((await project.host.board()).router.failure?.detail ?? "", /403 forbidden/);
  } finally {
    releaseGate();
    await project.close();
  }
});

test("the model and thinking level chosen for the Router are written to project.json and take effect next turn; creating a ticket can also set a level", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router" && last?.role === "user" && textOf(last).includes("create a ticket")) {
      return call("ticket", {
        action: "create",
        title: "research",
        goal: "look it up",
        acceptance: ["has a conclusion"],
        provider: "faux",
        modelId: "deep",
        thinkingLevel: "low",
      });
    }
    return say("OK.");
  };
  const project = await openTestProject(brain, { extraModels: ["deep"] });
  const lastTurn = (role: string) => project.calls.findLast((turn) => turn.role === role);
  try {
    const router = { provider: "faux", modelId: "deep", thinkingLevel: "high" } as const;
    await project.host.setProjectModel("router", router);
    assert.deepEqual(project.host.summary().models, { router });
    const meta = eeveePaths(project.home).project(project.host.meta.id).meta;
    assert.deepEqual(JSON.parse(await readFile(meta, "utf8")).models, { router });

    await project.host.sendUserMessage("hello");
    const first = await project.until(async () => lastTurn("router"));
    assert.deepEqual([first.model, first.thinking], ["deep", "high"]);

    await project.host.sendUserMessage("create a ticket");
    const worker = await project.until(async () => lastTurn("worker"));
    assert.deepEqual([worker.model, worker.thinking], ["deep", "low"]);
    await project.until(async () => !(await project.host.board()).router.running);

    await project.host.setProjectModel("router", null);
    assert.equal(project.host.summary().models, undefined);
    const before = project.calls.length;
    await project.host.sendUserMessage("switch back to default");
    const after = await project.until(async () =>
      project.calls.slice(before).findLast((turn) => turn.role === "router"),
    );
    assert.deepEqual([after.model, after.thinking], ["brain", "off"]);
  } finally {
    await project.close();
  }
});

test("when the same question is answered concurrently, only one takes effect", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router" && last?.role === "user" && textOf(last).includes("ask me")) {
      return call("ask_user", {
        items: [{ text: "which one", options: ["alpha", "beta"], recommended: "alpha" }],
      });
    }
    return say("OK.");
  };

  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("ask me a question");
    const question = await project.until(async () => (await project.host.board()).openQuestions[0]);
    const results = await Promise.allSettled([
      project.host.answerQuestion(question.id, "alpha"),
      project.host.answerQuestion(question.id, "beta"),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "rejected"],
    );
    const refused = results[1] as PromiseRejectedResult;
    assert.equal((refused.reason as { problem?: { code?: string } }).problem?.code, "answered");
    assert.deepEqual((await project.host.board()).openQuestions, []);
  } finally {
    await project.close();
  }
});

test("cancelling a ticket removes its pending question and stops its worker conversation", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("open a ticket")) {
        return call("ticket", {
          action: "create",
          title: "ask about it",
          goal: "needs a user decision",
          acceptance: ["has a decision"],
        });
      }
      if (textOf(last).includes("report · waiting")) {
        return call("ask_user", {
          items: [{ text: "should we continue", options: ["yes", "no"], recommended: "no" }],
          ticketId: "t1",
        });
      }
      if (toolName(last) === "ask_user") {
        return call("ticket", { action: "close", ticketId: "t1", note: "no longer needed" });
      }
      return say("OK.");
    }
    if (last?.role === "user") {
      return call("report", {
        status: "waiting",
        summary: "needs a user decision",
        need: "should we continue",
        questions: [{ text: "should we continue", options: ["yes", "no"], recommended: "no" }],
      });
    }
    return say("Waiting for your answer.");
  };

  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("open a ticket");
    const closed = await project.until(async () => {
      const ticket = (await project.host.board()).tickets[0]?.ticket;
      return ticket?.status === "cancelled" ? ticket : undefined;
    });
    assert.equal(closed.closeNote, "no longer needed");
    const stopped = await project.until(async () => {
      const ticket = (await project.host.board()).tickets[0]?.ticket;
      return ticket?.stoppedAt === undefined ? undefined : ticket;
    });
    assert.ok(stopped.stoppedAt !== undefined);
    assert.deepEqual((await project.host.board()).openQuestions, []);
    await assert.rejects(
      project.host.answerQuestion("q1" as never, "yes"),
      (error: unknown) =>
        (error as { problem?: { code?: string } }).problem?.code === "no_question",
    );
  } finally {
    await project.close();
  }
});

test("the opening is written into the worker conversation when the ticket is created, without waiting for a slot", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router" && last?.role === "user" && textOf(last).includes("open a ticket")) {
      return call("ticket", {
        action: "create",
        title: "write a file",
        goal: "write hello.txt in the working directory",
        acceptance: ["contents are hi"],
      });
    }
    return say("OK.");
  };

  const project = await openTestProject(brain, { maxActiveWorkers: 1 });
  try {
    await project.host.sendUserMessage("open a ticket");
    await project.until(async () => (await project.host.board()).tickets[0]?.ticket.id);
    const entries = await project.host.entries("t1", {}, 50);
    const opening = entries.find(
      (entry) => (entry.data as { requestId?: string } | undefined)?.requestId === "opening:t1",
    );
    assert.ok(opening !== undefined);
    assert.match(textOf(opening.model?.[0]), /write hello\.txt in the working directory/);
  } finally {
    await project.close();
  }
});

test("a board watcher hears the current board, then its changes, without calling board()", async () => {
  const project = await openTestProject(() => say("OK."));
  const views: BoardView[] = [];
  const unsubscribe = project.host.watchBoard({
    view: (board) => views.push(board),
    failed: (error) => assert.fail(String(error)),
  });
  try {
    await project.until(async () => views.length > 0, 1500);
    await project.host.sendUserMessage("hello");
    await project.until(async () => views.some((board) => board.router.running), 1500);
    await project.until(async () => views.at(-1)?.router.running === false, 1500);
  } finally {
    unsubscribe();
    await project.close();
  }
});

test("a board subscriber is notified when a background job starts and finishes, with accurate job state", async () => {
  let releaseAfterAdopt: () => void = () => {};
  const adoptGate = new Promise<void>((resolve) => {
    releaseAfterAdopt = resolve;
  });
  const brain: Brain = async ({ role, last }) => {
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("run simulation")) {
        return call("ticket", {
          action: "create",
          title: "simulation",
          goal: "run",
          acceptance: ["done running"],
        });
      }
      return say("OK.");
    }
    if (last?.role === "user" && textOf(last).includes("Background job job://j1 finished")) {
      return call("report", { status: "ready", summary: textOf(last), artifacts: [] });
    }
    if (toolName(last) === "bash") {
      await adoptGate;
      return say("The job runs in the background; ending this turn.");
    }
    if (last?.role === "user") return call("bash", { command: "sleep 1; echo finished" });
    return say("…");
  };

  const project = await openTestProject(brain, { backgroundAfterMs: 200 });
  const snapshots: BoardView[] = [];
  const unsubscribe = project.host.watchBoard({
    view: (board) => snapshots.push(board),
    failed: (error) => assert.fail(String(error)),
  });
  try {
    await project.host.sendUserMessage("run simulation");

    const adopted = await project.until(async () => {
      const index = snapshots.findIndex((b) => b.tickets[0]?.jobs[0]?.status === "running");
      return index >= 0 ? { index, board: snapshots[index] } : false;
    });
    assert.equal(adopted.board?.tickets[0]?.jobs.length, 1);
    releaseAfterAdopt();

    const jobsStage = await project.until(async () => {
      const index = snapshots.findIndex(
        (b, i) => i >= adopted.index && b.tickets[0]?.stage === "jobs",
      );
      return index >= 0 ? { index, board: snapshots[index] } : false;
    });
    assert.equal(jobsStage.board?.tickets[0]?.jobs[0]?.status, "running");

    const ended = await project.until(async () => {
      const index = snapshots.findIndex(
        (b, i) => i > jobsStage.index && b.tickets[0]?.jobs.length === 0,
      );
      return index >= 0 ? { index, board: snapshots[index] } : false;
    });
    assert.notEqual(ended.board?.tickets[0]?.stage, "jobs");

    await project.until(async () => snapshots.at(-1)?.tickets[0]?.reports[0]?.status === "ready");
  } finally {
    releaseAfterAdopt();
    unsubscribe();
    await project.close();
  }
});
