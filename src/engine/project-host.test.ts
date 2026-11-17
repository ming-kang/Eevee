import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { type Brain, call, openTestProject, say, textOf, toolName } from "./testing.ts";

test("Router 建单，Worker 交 ready，Router 验收结单", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("写一个 hello.txt")) {
        return call("ticket", {
          action: "create",
          title: "写问候文件",
          goal: "在工作目录写 hello.txt",
          acceptance: ["hello.txt 内容为 hi"],
        });
      }
      if (last?.role === "user" && textOf(last).includes("报告 · ready")) {
        return call("ticket", {
          action: "review",
          ticketId: "t1",
          verdict: "accept",
          note: "hello.txt 已写好",
        });
      }
      return say("好的。");
    }
    if (toolName(last) === "write") {
      return call("report", {
        status: "ready",
        summary: "写好了",
        artifacts: [{ path: "hello.txt", note: "问候" }],
      });
    }
    if (last?.role === "user") return call("write", { path: "hello.txt", content: "hi" });
    return say("收到。");
  };

  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("帮我写一个 hello.txt");
    const done = await project.until(async () => {
      const board = await project.host.board();
      const ticket = board.tickets[0]?.ticket;
      return ticket?.status === "done" && board.tickets[0];
    });
    assert.equal(done.ticket.closeNote, "hello.txt 已写好");
    assert.deepEqual(
      done.reports.map((r) => [r.status, r.handled]),
      [["ready", true]],
    );
    assert.equal(await readFile(join(project.workspace, "hello.txt"), "utf8"), "hi");
  } finally {
    await project.close();
  }
});

test("Worker 不交报告就结束时，引擎补一份 waiting", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router" && last?.role === "user" && textOf(last).includes("开工")) {
      return call("ticket", { action: "create", title: "沉默", goal: "随便", acceptance: ["无"] });
    }
    return say(role === "worker" ? "我做完了但忘了交报告" : "好的。");
  };

  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("开工");
    const report = await project.until(async () => {
      const board = await project.host.board();
      return board.tickets[0]?.reports[0];
    });
    assert.equal(report.status, "waiting");
    assert.match(report.summary, /忘了交报告/);
    await project.until(async () =>
      project.calls.some((c) => c.role === "router" && textOf(c.last).includes("报告 · waiting")),
    );
  } finally {
    await project.close();
  }
});

test("验收后结果直接投给 deliverTo 的工单", async () => {
  const brain: Brain = ({ role, last, messages }) => {
    const opening = textOf(
      messages.find((m) => m.role === "user" && textOf(m).includes("<ticket>")),
    );
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("开两张")) {
        return call("ticket", {
          action: "create",
          title: "论文",
          goal: "等数据",
          acceptance: ["无"],
        });
      }
      if (toolName(last) === "ticket" && textOf(last).includes("t1")) {
        return call("ticket", {
          action: "create",
          title: "仿真",
          goal: "出数据",
          acceptance: ["有数据"],
          deliverTo: ["t1"],
        });
      }
      if (last?.role === "user" && textOf(last).includes("「仿真」报告 · ready")) {
        return call("ticket", { action: "review", ticketId: "t2", verdict: "accept", note: "ok" });
      }
      return say("好的。");
    }
    if (opening.includes("「仿真」") && last?.role === "user") {
      return call("report", { status: "ready", summary: "数据好了", artifacts: [] });
    }
    if (opening.includes("「论文」") && last?.role === "user" && !textOf(last).includes("已验收")) {
      return call("report", {
        status: "waiting",
        summary: "等数据",
        need: "仿真数据",
        artifacts: [],
      });
    }
    return say("收到数据。");
  };

  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("开两张单");
    await project.until(async () =>
      project.calls.some((c) => c.role === "worker" && textOf(c.last).includes("你等待的 t2")),
    );
    const board = await project.host.board();
    assert.equal(board.tickets[1]?.ticket.status, "done");
  } finally {
    await project.close();
  }
});

test("长命令转入后台，作业结束后唤醒 Worker", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("跑仿真")) {
        return call("ticket", {
          action: "create",
          title: "仿真",
          goal: "跑",
          acceptance: ["跑完"],
        });
      }
      return say("好的。");
    }
    if (last?.role === "user" && textOf(last).includes("后台作业 job://j1 已结束")) {
      return call("report", { status: "ready", summary: textOf(last), artifacts: [] });
    }
    if (toolName(last) === "bash") return say("作业在后台跑，先结束本轮。");
    if (last?.role === "user") return call("bash", { command: "sleep 1; echo finished" });
    return say("…");
  };

  const project = await openTestProject(brain, { backgroundAfterMs: 200 });
  try {
    await project.host.sendUserMessage("跑仿真");
    const jobs = await project.until(async () => {
      const ticket = (await project.host.board()).tickets[0];
      return ticket?.stage === "jobs" && ticket;
    });
    assert.deepEqual(jobs.reports, []);
    const report = await project.until(
      async () => (await project.host.board()).tickets[0]?.reports[0],
    );
    assert.equal(report.status, "ready");
    assert.match(report.summary, /退出码 0[\s\S]*finished/);
    const log = await readFile(
      join(project.home, "projects", project.host.meta.id, "jobs", "j1.log"),
      "utf8",
    );
    assert.match(log, /finished/);
  } finally {
    await project.close();
  }
});

test("引擎重启打断后台作业时，提醒 Worker 先检查现场", async () => {
  const brain: Brain = ({ role, last }) => {
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("跑很久")) {
        return call("ticket", {
          action: "create",
          title: "长跑",
          goal: "跑",
          acceptance: ["跑完"],
        });
      }
      return say("好的。");
    }
    if (last?.role === "user" && textOf(last).includes("引擎重启打断了后台作业")) {
      return call("report", { status: "blocked", summary: "作业被打断", artifacts: [] });
    }
    if (toolName(last) === "bash") return say("等作业。");
    if (last?.role === "user") return call("bash", { command: "sleep 30" });
    return say("…");
  };

  const project = await openTestProject(brain, { backgroundAfterMs: 100 });
  try {
    await project.host.sendUserMessage("跑很久的东西");
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

test("超过并发上限的工单排队，前一张空出槽位后才开始", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const brain: Brain = async ({ role, last, messages }) => {
    const opening = textOf(
      messages.find((m) => m.role === "user" && textOf(m).includes("<ticket>")),
    );
    if (role === "router") {
      if (last?.role === "user" && textOf(last).includes("两件事")) {
        return call("ticket", { action: "create", title: "甲", goal: "甲", acceptance: ["甲"] });
      }
      if (toolName(last) === "ticket" && textOf(last).includes("t1")) {
        return call("ticket", { action: "create", title: "乙", goal: "乙", acceptance: ["乙"] });
      }
      return say("好的。");
    }
    if (opening.includes("「甲」")) await gate;
    return call("report", { status: "ready", summary: "完成", artifacts: [] });
  };

  const project = await openTestProject(brain, { maxActiveWorkers: 1 });
  try {
    await project.host.sendUserMessage("帮我做两件事");
    const stages = await project.until(async () => {
      const board = await project.host.board();
      const ready = board.tickets.length === 2 && board.tickets[0]?.stage === "working";
      return ready && board.tickets.map((t) => t.stage);
    });
    assert.deepEqual(stages, ["working", "queued"]);
    assert.equal(
      project.calls.filter((c) => c.role === "worker").length,
      1,
      "乙不应在甲占着槽位时开始",
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
      return call("ticket", { action: "create", title, goal: title, acceptance: ["无"] });
    }
    return say("好的。");
  };

test("收尾报告一直没处理时，引擎提醒 Router 一次", async () => {
  const base = createOn("开工", "卡住");
  const brain: Brain = (turn) => {
    if (turn.role === "worker" && turn.last?.role === "user") {
      return call("report", { status: "blocked", summary: "缺权限", artifacts: [] });
    }
    return base(turn);
  };
  const project = await openTestProject(brain, { reminderAfterMs: 0 });
  try {
    await project.host.sendUserMessage("开工");
    await project.until(async () =>
      project.calls.some((c) => c.role === "router" && textOf(c.last).includes("还有未处理的报告")),
    );
    const report = (await project.host.board()).tickets[0]?.reports[0];
    assert.equal(report?.reminded, true);
    const reminders = () =>
      project.calls.filter(
        (c) => c.role === "router" && textOf(c.last).includes("还有未处理的报告"),
      );
    const count = reminders().length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(reminders().length, count);
  } finally {
    await project.close();
  }
});

test("Worker 上下文超过阈值时，交收尾报告顺带重置上下文", async () => {
  const base = createOn("开工", "长活");
  const brain: Brain = (turn) => {
    if (turn.role === "worker" && turn.last?.role === "user") {
      return call("report", { status: "waiting", summary: "等材料", need: "数据", artifacts: [] });
    }
    return base(turn);
  };
  const project = await openTestProject(brain, { contextWindow: 200, handoffThreshold: 0.1 });
  try {
    await project.host.sendUserMessage("开工");
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

test("用户在面板直接引导 Worker，Router 只记录这次介入", async () => {
  const base = createOn("开工", "可引导");
  const brain: Brain = (turn) => {
    if (turn.role === "worker" && textOf(turn.last).includes("换个思路")) {
      return call("report", { status: "ready", summary: "按新思路做完了", artifacts: [] });
    }
    if (turn.role === "worker") return say("先这样。");
    return base(turn);
  };
  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("开工");
    await project.until(async () => (await project.host.board()).tickets[0]?.reports[0]);
    const routerCalls = project.calls.filter((c) => c.role === "router").length;
    await project.host.messageWorker("t1", "换个思路", "steer");
    const ready = await project.until(async () => {
      const reports = (await project.host.board()).tickets[0]?.reports ?? [];
      return reports.find((r) => r.status === "ready");
    });
    assert.equal(ready.summary, "按新思路做完了");
    const { lines: transcript } = await project.host.ticketConversation("t1");
    assert.ok(transcript.some((l) => l.role === "user" && l.text === "换个思路"));
    await project.until(async () =>
      (await project.host.conversation()).lines.some((l) =>
        l.text.includes("用户直接给 t1 发了消息"),
      ),
    );
    assert.ok(project.calls.filter((c) => c.role === "router").length > routerCalls);
  } finally {
    await project.close();
  }
});

test("模型调用失败时暴露原因，修好后可以重试", async () => {
  let broken = true;
  const brain: Brain = () => {
    if (broken) throw new Error("403 forbidden");
    return say("恢复了。");
  };
  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("你好");
    const view = await project.until(async () => {
      const current = await project.host.conversation();
      return current.failure !== undefined && current;
    });
    assert.equal(view.running, false);
    broken = false;
    await project.host.retry();
    await project.until(async () =>
      (await project.host.conversation()).lines.some((l) => l.text === "恢复了。"),
    );
    assert.equal((await project.host.conversation()).failure, undefined);
  } finally {
    await project.close();
  }
});

test("read transcript:// 按条目分页，给出前后翻页的位置", async () => {
  const pages: string[] = [];
  const brain: Brain = ({ role, last }) => {
    if (role !== "router") return say("好的。");
    if (last?.role === "user" && textOf(last).includes("翻记录")) {
      return call("read", { path: "transcript://1", offset: 0, limit: 2 });
    }
    if (toolName(last) === "read" && pages.length === 0) {
      pages.push(textOf(last));
      return call("read", { path: "transcript://1", limit: 2 });
    }
    if (toolName(last) === "read") {
      pages.push(textOf(last));
      return say("翻完了。");
    }
    return say("好的。");
  };
  const project = await openTestProject(brain);
  try {
    await project.host.sendUserMessage("先说一句");
    await project.until(async () => project.calls.length >= 1);
    await project.host.sendUserMessage("翻记录");
    await project.until(async () => pages.length === 2);
    const [fromStart, newest] = pages;
    assert.match(fromStart ?? "", /还有更新的条目：read\("transcript:\/\/1", offset: \d+\)/);
    assert.match(newest ?? "", /更早的条目：read\("transcript:\/\/1", offset: \d+\)/);
    assert.match(newest ?? "", /#\d+ tool: /);
  } finally {
    await project.close();
  }
});
