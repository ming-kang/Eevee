import {
  formatAddress,
  type JobId,
  type Question,
  type Report,
  type Ticket,
  type TicketId,
} from "../../contracts/index.ts";

export type Target = { kind: "router" } | { kind: "ticket"; id: TicketId };

export type Delivery = {
  target: Target;
  mode: "wake" | "record";
  whenBusy: "steer" | "followUp";
  text: string;
  requestId: string;
  fromUser?: boolean;
};

type TicketRef = Pick<Ticket, "id" | "role" | "title" | "deliverTo">;

export type EngineEvent =
  | { type: "user-message"; id: string; text: string }
  | { type: "report"; ticket: TicketRef; report: Report }
  | { type: "ticket-accepted"; ticket: TicketRef; report: Report | undefined }
  | { type: "ticket-cancelled"; ticket: TicketRef; reason: string }
  | { type: "question-answered"; question: Question }
  | { type: "job-finished"; ticketId: TicketId; jobId: JobId; outcome: string; tail: string }
  | { type: "jobs-interrupted"; ticketId: TicketId; jobIds: JobId[] }
  | {
      type: "panel-message";
      id: string;
      ticketId: TicketId;
      text: string;
      whenBusy: Delivery["whenBusy"];
    }
  | { type: "panel-interrupt"; id: string; ticketId: TicketId }
  | { type: "ticket-opened"; ticketId: TicketId; opening: string }
  | { type: "handoff-nudge"; epoch: number }
  | {
      type: "router-message";
      id: string;
      ticketId: TicketId;
      text: string;
      whenBusy: Delivery["whenBusy"];
    }
  | { type: "reminder"; reports: Report[] };

const ROUTER: Target = { kind: "router" };
const ticketTarget = (id: TicketId): Target => ({ kind: "ticket", id });

export function route(event: EngineEvent): Delivery[] {
  switch (event.type) {
    case "user-message":
      return [{ ...wake(ROUTER, "steer", event.text, `user:${event.id}`), fromUser: true }];

    case "report": {
      const { ticket, report } = event;
      const id = `report:${ticket.id}#${report.seq}`;
      const text = renderReport(ticket, report);
      if (report.status === "progress") return [record(ROUTER, text, id)];
      if (ticket.role === "dreamer") return [record(ROUTER, text, id)];
      return [wake(ROUTER, "followUp", text, id)];
    }

    case "ticket-accepted": {
      const { ticket, report } = event;
      if (ticket.deliverTo.length === 0) return [];
      const text = renderHandover(ticket, report);
      return [
        ...ticket.deliverTo.map((to) =>
          wake(ticketTarget(to), "followUp", text, `deliver:${ticket.id}->${to}`),
        ),
        record(
          ROUTER,
          `已把 ${ticket.id} 的结果投递给 ${ticket.deliverTo.join("、")}。`,
          `deliver:${ticket.id}`,
        ),
      ];
    }

    case "ticket-cancelled": {
      const { ticket, reason } = event;
      if (ticket.deliverTo.length === 0) return [];
      return [
        wake(
          ROUTER,
          "followUp",
          `${ticket.id}「${ticket.title}」已取消（${reason}），但 ${ticket.deliverTo.join("、")} 还在等它的结果，需要重新安排。`,
          `cancelled:${ticket.id}`,
        ),
      ];
    }

    case "question-answered": {
      const { question } = event;
      const text = renderAnswer(question);
      const id = `answer:${question.id}`;
      if (question.ticketId === undefined) return [wake(ROUTER, "steer", text, id)];
      return [
        wake(ticketTarget(question.ticketId), "steer", text, id),
        record(
          ROUTER,
          `用户已回答 ${question.id}，答案已直接投给 ${question.ticketId}。\n${text}`,
          `${id}:router`,
        ),
      ];
    }

    case "job-finished":
      return [
        wake(
          ticketTarget(event.ticketId),
          "followUp",
          `后台作业 ${formatAddress({ kind: "job", id: event.jobId })} 已结束（${event.outcome}）。\n输出末尾：\n${event.tail}`,
          `job:${event.jobId}`,
        ),
      ];

    case "jobs-interrupted":
      return [
        wake(
          ticketTarget(event.ticketId),
          "followUp",
          `引擎重启打断了后台作业：${event.jobIds.join("、")}。请先检查工作目录和 git 状态，再决定是否重跑。`,
          `interrupted:${event.ticketId}:${event.jobIds.join(",")}`,
        ),
      ];

    case "panel-interrupt":
      return [
        record(
          ROUTER,
          `用户在面板打断了 ${event.ticketId} 当前这一轮。`,
          `panel-interrupt:${event.id}`,
        ),
      ];

    case "handoff-nudge":
      return [
        wake(
          ROUTER,
          "followUp",
          "你的上下文已经很长了。请先用 memory 记下有长期价值的决策，再用 handoff 写一段交接小结，从新的上下文继续。",
          `handoff:${event.epoch}`,
        ),
      ];

    case "ticket-opened":
      return [
        wake(ticketTarget(event.ticketId), "followUp", event.opening, `opening:${event.ticketId}`),
      ];

    case "router-message":
      return [wake(ticketTarget(event.ticketId), event.whenBusy, event.text, `router:${event.id}`)];

    case "panel-message":
      return [
        {
          ...wake(ticketTarget(event.ticketId), event.whenBusy, event.text, `panel:${event.id}`),
          fromUser: true,
        },
        record(
          ROUTER,
          `用户直接给 ${event.ticketId} 发了消息：\n${event.text}`,
          `panel:${event.id}:router`,
        ),
      ];

    case "reminder": {
      if (event.reports.length === 0) return [];
      const list = event.reports
        .map(
          (r) =>
            `- ${formatAddress({ kind: "report", ticketId: r.ticketId, seq: r.seq })}（${r.status}）`,
        )
        .join("\n");
      const key = event.reports.map((r) => `${r.ticketId}#${r.seq}`).join(",");
      return [wake(ROUTER, "followUp", `还有未处理的报告：\n${list}`, `reminder:${key}`)];
    }
  }
}

const wake = (
  target: Target,
  whenBusy: Delivery["whenBusy"],
  text: string,
  requestId: string,
): Delivery => ({
  target,
  mode: "wake",
  whenBusy,
  text,
  requestId,
});

const record = (target: Target, text: string, requestId: string): Delivery => ({
  target,
  mode: "record",
  whenBusy: "followUp",
  text,
  requestId,
});

export function renderReport(ticket: Pick<Ticket, "id" | "title">, report: Report): string {
  const lines = [`[${ticket.id}「${ticket.title}」报告 · ${report.status}] ${report.summary}`];
  if (report.need) lines.push(`缺：${report.need}`);
  if (report.questions?.length) {
    lines.push("需要决定的问题：", ...report.questions.map((q, i) => `${i + 1}. ${q.text}`));
  }
  if (report.artifacts.length) {
    lines.push("产物：", ...report.artifacts.map((a) => `- ${a.path}（${a.note}）`));
  }
  if (report.lessons?.length) lines.push("经验：", ...report.lessons.map((l) => `- ${l}`));
  lines.push(
    `完整报告：${formatAddress({ kind: "report", ticketId: ticket.id, seq: report.seq })}`,
  );
  return lines.join("\n");
}

function renderHandover(ticket: Pick<Ticket, "id" | "title">, report: Report | undefined): string {
  if (report === undefined) return `你等待的 ${ticket.id}「${ticket.title}」已验收。`;
  return `你等待的 ${ticket.id}「${ticket.title}」已验收：\n${renderReport(ticket, report)}`;
}

function renderAnswer(question: Question): string {
  return `用户回答了问题 ${question.id}：\n${question.answer ?? ""}`;
}
