import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssistantEntry,
  type EntryId,
  type EntryRecord,
  type InboxState,
  type LiveState,
  ResetEntry,
  ToolResultEntry,
  type TranscriptItem,
  UserEntry,
} from "@earendil-works/pi-durable";
import type {
  JobId,
  Notice,
  Question,
  QuestionId,
  Report,
  ReportStatus,
  TicketId,
} from "../../src/contracts/index.ts";
import { toSubmission } from "../../src/extensions/orchestration/deliver.ts";
import { type Delivery, route } from "../../src/extensions/orchestration/delivery.ts";
import { mapTranscript } from "./transcript-map.ts";

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

/** A notice entry as the Engine writes it: its text for the model, its facts in `data`. */
const noticeEntry = (id: number, text: string, notice: Notice): TranscriptItem =>
  entry(id, "eevee.notice", [{ role: "user", content: text, timestamp: id * 100 }], {
    requestId: `r${id}`,
    notice,
  });

const reportOf = (
  ticketId: string,
  seq: number,
  status: ReportStatus,
  summary: string,
): Report => ({
  ticketId: ticketId as TicketId,
  seq,
  status,
  summary,
  artifacts: [],
  handled: false,
  reminded: false,
  at: 0,
});

test("折叠连续工具调用，合并连续的 ticket / ask_user 为调度行", () => {
  const items: TranscriptItem[] = [
    entry(1, ResetEntry.kind, [
      {
        role: "user",
        content: "<project>\n光学论文\n工作目录：/tmp\n</project>",
        timestamp: 100,
      },
    ]),
    entry(2, UserEntry.kind, [{ role: "user", content: "安排一下", timestamp: 200 }]),
    entry(3, AssistantEntry.kind, [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.tex" } },
          { type: "toolCall", id: "c2", name: "read", arguments: { path: "b.tex", query: "fig" } },
        ],
        api: "faux",
        provider: "faux",
        model: "m1",
        usage: {} as never,
        stopReason: "toolUse",
        timestamp: 300,
      },
    ]),
    entry(4, ToolResultEntry.kind, [
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "content a" }],
        isError: false,
        durationMs: 40,
        timestamp: 310,
      },
    ]),
    entry(5, ToolResultEntry.kind, [
      {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "read",
        content: [{ type: "text", text: "content b" }],
        isError: false,
        durationMs: 65,
        timestamp: 320,
      },
    ]),
    entry(6, AssistantEntry.kind, [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c3",
            name: "ticket",
            arguments: { action: "create", title: "跑仿真", deliverTo: ["t1"] },
          },
          {
            type: "toolCall",
            id: "c4",
            name: "ask_user",
            arguments: { items: [{ text: "选哪个样式？", options: ["A", "B"] }] },
          },
        ],
        api: "faux",
        provider: "faux",
        model: "m1",
        usage: {} as never,
        stopReason: "toolUse",
        timestamp: 400,
      },
    ]),
    entry(7, ToolResultEntry.kind, [
      {
        role: "toolResult",
        toolCallId: "c3",
        toolName: "ticket",
        content: [{ type: "text", text: "已建单 t2，执行对话会在有空闲槽位时开始工作。" }],
        details: { ticketId: "t2", conversationId: 3 },
        isError: false,
        timestamp: 410,
      },
    ]),
    entry(8, ToolResultEntry.kind, [
      {
        role: "toolResult",
        toolCallId: "c4",
        toolName: "ask_user",
        content: [{ type: "text", text: "已提问 q1，用户回答后会作为新消息送达。" }],
        details: { questionId: "q1" },
        isError: false,
        timestamp: 420,
      },
    ]),
    entry(9, AssistantEntry.kind, [
      {
        role: "assistant",
        content: [{ type: "text", text: "已经建单 **t2** 并向你提问。" }],
        api: "faux",
        provider: "faux",
        model: "m1",
        usage: {} as never,
        stopReason: "stop",
        timestamp: 500,
      },
    ]),
  ];

  const mapped = mapTranscript(items, { mode: "router" });
  assert.deepEqual(
    mapped.map((m) => m.kind),
    ["user", "tools", "dispatch", "assistant"],
  );
  if (mapped[1]?.kind === "tools") {
    assert.equal(mapped[1].steps.length, 2);
    assert.equal(mapped[1].steps[1]?.label, "b.tex?query=fig");
    assert.equal(mapped[1].steps[0]?.ms, 40);
  }
  if (mapped[2]?.kind === "dispatch") {
    assert.equal(mapped[2].actions.length, 2);
    assert.equal(mapped[2].actions[0]?.kind, "create");
    assert.equal(mapped[2].actions[0]?.ticketId, "t2");
    assert.equal(mapped[2].actions[1]?.kind, "ask");
    assert.equal(mapped[2].actions[1]?.questionId, "q1");
  }
});

test("报告事件过滤 progress、保留终态报告，并识别 handoff reset 与失败状态", () => {
  const items: TranscriptItem[] = [
    { kind: "earlier" },
    noticeEntry(10, "（给模型的文字）", {
      type: "report",
      ticketId: "t2",
      title: "仿真",
      report: reportOf("t2", 1, "progress", "正在跑 3/13"),
    }),
    noticeEntry(11, "（给模型的文字）", {
      type: "report",
      ticketId: "t3",
      title: "文献",
      report: reportOf("t3", 1, "blocked", "缺少 data.csv"),
    }),
    noticeEntry(12, "（给模型的文字）", {
      type: "answer",
      questionId: "q2",
      answer: "对数坐标",
      forwardedTo: "t4",
    }),
    entry(13, ResetEntry.kind, [
      {
        role: "user",
        content:
          "<project>\n项目\n</project>\n\n<handoff-summary>\n进行中：t2 跑仿真。\n</handoff-summary>",
        timestamp: 400,
      },
    ]),
  ];

  const live: LiveState = {
    runFailure: {
      taskId: 99 as never,
      inputs: [],
      reason: "model_error",
      detail: "429 Too Many Requests",
    },
  };

  const mapped = mapTranscript(items, { mode: "router", live });
  assert.deepEqual(
    mapped.map((m) => m.kind),
    ["more", "event", "event", "reset", "failure"],
  );
  if (mapped[1]?.kind === "event") {
    assert.equal(mapped[1].eventKind, "report");
    assert.equal(mapped[1].status, "blocked");
    assert.equal(mapped[1].ticketId, "t3");
    assert.equal(mapped[1].text, "缺少 data.csv");
  }
  if (mapped[2]?.kind === "event") {
    assert.equal(mapped[2].eventKind, "answer");
    assert.equal(mapped[2].questionId, "q2");
    assert.equal(mapped[2].ticketId, "t4");
  }
  if (mapped[3]?.kind === "reset") {
    assert.equal(mapped[3].summary, "进行中：t2 跑仿真。");
  }
  if (mapped[4]?.kind === "failure") {
    assert.match(mapped[4].text, /429 Too Many Requests/);
  }
});

test("实时运行中显示工具运行槽位与流式回复", () => {
  const items: TranscriptItem[] = [
    entry(1, AssistantEntry.kind, [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "refs.bib" } }],
        api: "faux",
        provider: "faux",
        model: "m1",
        usage: {} as never,
        stopReason: "toolUse",
        timestamp: 100,
      },
    ]),
  ];

  const liveTools: LiveState = {
    run: { taskId: 5 as never, inputs: [], turns: 1 },
    tools: [{ callId: "c1", name: "read", status: "running" }],
  };
  const duringTool = mapTranscript(items, { mode: "router", live: liveTools });
  assert.equal(duringTool.length, 1);
  assert.equal(duringTool[0]?.kind, "tools");
  if (duringTool[0]?.kind === "tools") {
    assert.equal(duringTool[0].live, true);
    assert.equal(duringTool[0].steps[0]?.status, "run");
  }

  const liveGen: LiveState = {
    run: { taskId: 5 as never, inputs: [], turns: 1 },
    generation: {
      attempt: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "正在核对" }],
        api: "faux",
        provider: "faux",
        model: "m1",
        usage: {} as never,
        stopReason: "stop",
        timestamp: 120,
      },
    },
  };
  const duringGen = mapTranscript(items, { mode: "router", live: liveGen });
  const last = duringGen.at(-1);
  assert.equal(last?.kind, "assistant");
  if (last?.kind === "assistant") {
    assert.equal(last.streaming, true);
    assert.equal(last.text, "正在核对");
  }
});

test("Worker 模式映射开篇、文件 diff、bash（运行与转入后台）及报告卡片", () => {
  const items: TranscriptItem[] = [
    noticeEntry(1, "<ticket>t2: 运行仿真</ticket>", { type: "opening", ticketId: "t2" }),
    entry(2, UserEntry.kind, [{ role: "user", content: "网格用 λ/20", timestamp: 150 }]),
    entry(3, AssistantEntry.kind, [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "e1",
            name: "edit",
            arguments: { path: "sim/config.yaml", edits: [] },
          },
          {
            type: "toolCall",
            id: "b1",
            name: "bash",
            arguments: { command: "python sim/run.py --mesh 20" },
          },
          {
            type: "toolCall",
            id: "r1",
            name: "report",
            arguments: {
              status: "ready",
              summary: "配置已更新，等待验收",
              artifacts: [{ path: "sim/config.yaml", note: "网格配置" }],
              lessons: ["45 度以上加厚 PML"],
            },
          },
        ],
        api: "faux",
        provider: "faux",
        model: "m1",
        usage: {} as never,
        stopReason: "toolUse",
        timestamp: 200,
      },
    ]),
    entry(4, ToolResultEntry.kind, [
      {
        role: "toolResult",
        toolCallId: "e1",
        toolName: "edit",
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in sim/config.yaml." }],
        details: {
          diff: " 12 solver: fdtd\n-13 mesh: lambda/15\n+13 mesh: lambda/20\n    ...",
          patch: "",
        },
        isError: false,
        timestamp: 210,
      },
    ]),
    entry(5, ToolResultEntry.kind, [
      {
        role: "toolResult",
        toolCallId: "b1",
        toolName: "bash",
        content: [
          {
            type: "text",
            text: "命令仍在运行，已转入后台作业 job://j3。完整输出写入日志，可用 read job://j3 查看。",
          },
        ],
        details: { jobId: "j3" },
        isError: false,
        timestamp: 220,
      },
    ]),
    entry(6, ToolResultEntry.kind, [
      {
        role: "toolResult",
        toolCallId: "r1",
        toolName: "report",
        content: [{ type: "text", text: "已提交 report://t2#4，本轮结束。" }],
        isError: false,
        timestamp: 230,
      },
    ]),
  ];

  const mapped = mapTranscript(items, {
    mode: "worker",
    ticketId: "t2",
    ticketStatus: "open",
    ticketStage: "review",
    reports: [
      {
        ticketId: "t2",
        seq: 4,
        status: "ready",
        summary: "配置已更新，等待验收",
        artifacts: [{ path: "sim/config.yaml", note: "网格配置" }],
        lessons: ["45 度以上加厚 PML"],
        handled: false,
        reminded: false,
        at: 230,
      },
    ],
  });

  assert.deepEqual(
    mapped.map((m) => m.kind),
    ["opening", "user", "edit", "bash", "report", "idle"],
  );
  if (mapped[2]?.kind === "edit") {
    assert.equal(mapped[2].path, "sim/config.yaml");
    assert.equal(mapped[2].added, 1);
    assert.equal(mapped[2].removed, 1);
    assert.equal(mapped[2].diff[0]?.k, "ctx");
    assert.equal(mapped[2].diff[3]?.k, "hunk");
  }
  if (mapped[3]?.kind === "bash") {
    assert.equal(mapped[3].status, "job");
    assert.equal(mapped[3].jobId, "j3");
  }
  if (mapped[4]?.kind === "report") {
    assert.equal(mapped[4].report.seq, 4);
    assert.equal(mapped[4].report.status, "ready");
    assert.equal(mapped[4].report.handled, false);
  }
  if (mapped[5]?.kind === "idle") {
    assert.match(mapped[5].text, /验收/);
  }
});

test("Worker 模式实时运行 bash 与失败退出码映射", () => {
  const runningItems: TranscriptItem[] = [
    entry(1, AssistantEntry.kind, [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "npm test" } }],
        api: "faux",
        provider: "faux",
        model: "m1",
        usage: {} as never,
        stopReason: "toolUse",
        timestamp: 500,
      },
    ]),
  ];

  const liveRun = mapTranscript(runningItems, {
    mode: "worker",
    live: {
      run: { taskId: 1 as never, inputs: [], turns: 1 },
      tools: [{ callId: "b1", name: "bash", status: "running", output: "running suite..." }],
    },
  });
  assert.equal(liveRun[0]?.kind, "bash");
  if (liveRun[0]?.kind === "bash") {
    assert.equal(liveRun[0].status, "run");
    assert.equal(liveRun[0].output, "running suite...");
    assert.equal(liveRun[0].at, 500);
  }

  const exitItems: TranscriptItem[] = [
    ...runningItems,
    entry(2, ToolResultEntry.kind, [
      {
        role: "toolResult",
        toolCallId: "b1",
        toolName: "bash",
        content: [{ type: "text", text: "error line\n退出码 2" }],
        details: { exitCode: 2 },
        isError: true,
        durationMs: 1200,
        timestamp: 1700,
      },
    ]),
  ];
  const exited = mapTranscript(exitItems, { mode: "worker" });
  assert.equal(exited[0]?.kind, "bash");
  if (exited[0]?.kind === "bash") {
    assert.equal(exited[0].status, "exit");
    assert.equal(exited[0].exitCode, 2);
    assert.equal(exited[0].ms, 1200);
  }
});

test("后端 route() 生成的通知都映射成一行，长内容折叠进 detail", () => {
  // What the Engine actually persists for a delivery: the panel must read it without its prose.
  const notice = (id: number, delivery: Delivery | undefined): TranscriptItem => {
    const submission = delivery === undefined ? undefined : toSubmission(delivery);
    const data = (submission as { entry?: { data?: unknown } } | undefined)?.entry?.data;
    const text = delivery?.text ?? "";
    return entry(id, "eevee.notice", [{ role: "user", content: text, timestamp: id }], data);
  };
  const t2 = { id: "t2" as TicketId, role: "worker" as const, title: "跑仿真", deliverTo: [] };
  const report: Report = {
    ticketId: t2.id,
    seq: 1,
    status: "ready",
    summary: "13 个角度完成",
    artifacts: [{ path: "sim/out/", note: "输出" }],
    handled: false,
    reminded: false,
    at: 1,
  };
  const question: Question = {
    id: "q3" as QuestionId,
    ticketId: t2.id,
    items: [{ text: "网格多密？", options: ["λ/20", "λ/40"] }],
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
      ["job", "后台作业 j1 已结束（退出码 0）"],
      ["deliver", "你等待的 t2「跑仿真」已验收"],
    ],
  );
  const [jobItem, handoverItem] = worker;
  assert.ok(jobItem?.kind === "event" && jobItem.detail?.endsWith("[fdtd] step 90/90"));
  assert.ok(handoverItem?.kind === "event" && handoverItem.detail?.includes("13 个角度完成"));

  const [, answered] = route({ type: "question-answered", question });
  const [reportWake] = route({ type: "report", ticket: t2, report });
  const [, panelRecord] = route({
    type: "panel-message",
    id: "m1",
    ticketId: t2.id,
    text: "先跑 45°",
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

test("还没送达的消息排在对话末尾，标为待送达；系统写入的条目不显示", () => {
  const live: LiveState = { run: { taskId: 5 as never, inputs: [], turns: 1 } };
  const inbox: InboxState = {
    items: [
      { id: 7 as never, mode: "steer", content: "把收敛分析补进第 3 章" },
      { id: 8 as never, mode: "followUp", content: [{ type: "text", text: "再检查公式编号" }] },
      { id: 9 as never, mode: "write", entry: { kind: "eevee.notice" } },
    ],
  };
  const out = mapTranscript([], { mode: "worker", live, inbox });
  const pending = out.filter((item) => item.kind === "user");
  assert.deepEqual(
    pending.map((item) => (item.kind === "user" ? [item.key, item.text, item.pending] : [])),
    [
      ["q:7", "把收敛分析补进第 3 章", true],
      ["q:8", "再检查公式编号", true],
    ],
  );
  assert.equal(out.at(-1)?.kind, "user");
});

test("Engine 代写的报告按 origin 措辞，不显示 Engine 写给模型的摘要", () => {
  const failed: Report = {
    ...reportOf("t7", 2, "failed", "执行对话运行失败：模型调用失败：403（给模型的文字）"),
    origin: { type: "run-failed", failure: { reason: "model_error", detail: "403 forbidden" } },
  };
  const [item] = mapTranscript(
    [
      noticeEntry(1, "（给模型的文字）", {
        type: "report",
        ticketId: "t7",
        title: "插图",
        report: failed,
      }),
    ],
    { mode: "router" },
  );
  assert.ok(item?.kind === "event");
  assert.equal(item.text, "执行对话运行失败：模型调用失败：403 forbidden");
});
