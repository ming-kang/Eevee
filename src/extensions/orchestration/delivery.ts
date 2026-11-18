import {
  formatAddress,
  type JobId,
  type JobOutcome,
  type Notice,
  type Question,
  type Report,
  type Ticket,
  type TicketId,
} from "../../contracts/index.ts";

export type Target = { kind: "router" } | { kind: "ticket"; id: TicketId };

export type Delivery = {
  target: Target;
  mode: "wake" | "record" | "start";
  whenBusy: "steer" | "followUp";
  text: string;
  requestId: string;
  /** Set on a wake that must not wait for a free slot, such as a user's answer to a question. */
  direct?: true;
  /** What the Engine says, as data. Absent when the text is the user's own words. */
  notice?: Notice;
};

type TicketRef = Pick<Ticket, "id" | "role" | "title" | "deliverTo">;

export type EngineEvent =
  | { type: "user-message"; id: string; text: string }
  | { type: "report"; ticket: TicketRef; report: Report }
  | { type: "ticket-accepted"; ticket: TicketRef; report: Report | undefined }
  | { type: "ticket-cancelled"; ticket: TicketRef; reason: string }
  | { type: "question-answered"; question: Question }
  | { type: "job-finished"; ticketId: TicketId; jobId: JobId; outcome: JobOutcome; tail: string }
  | { type: "jobs-interrupted"; ticketId: TicketId; jobIds: JobId[] }
  | {
      type: "panel-message";
      id: string;
      ticketId: TicketId;
      text: string;
      whenBusy: Delivery["whenBusy"];
    }
  | { type: "panel-interrupt"; id: string; ticketId: TicketId }
  | { type: "ticket-start"; ticketId: TicketId }
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
      return [wake(ROUTER, "steer", event.text, `user:${event.id}`)];

    case "report": {
      const { ticket, report } = event;
      const id = `report:${ticket.id}#${report.seq}`;
      const notice: Notice = { type: "report", ticketId: ticket.id, title: ticket.title, report };
      if (report.status === "progress" || ticket.role === "dreamer") {
        return [record(ROUTER, notice, id)];
      }
      return [tell(ROUTER, "followUp", notice, id)];
    }

    case "ticket-accepted": {
      const { ticket, report } = event;
      if (ticket.deliverTo.length === 0) return [];
      const accepted: Notice = {
        type: "accepted",
        ticketId: ticket.id,
        title: ticket.title,
        ...(report === undefined ? {} : { report }),
      };
      return [
        ...ticket.deliverTo.map((to) =>
          tell(ticketTarget(to), "followUp", accepted, `deliver:${ticket.id}->${to}`),
        ),
        record(
          ROUTER,
          { type: "delivered", ticketId: ticket.id, to: ticket.deliverTo },
          `deliver:${ticket.id}`,
        ),
      ];
    }

    case "ticket-cancelled": {
      const { ticket, reason } = event;
      if (ticket.deliverTo.length === 0) return [];
      const notice: Notice = {
        type: "cancelled",
        ticketId: ticket.id,
        title: ticket.title,
        reason,
        waiting: ticket.deliverTo,
      };
      return [tell(ROUTER, "followUp", notice, `cancelled:${ticket.id}`)];
    }

    case "question-answered": {
      const { question } = event;
      const answer: Notice = {
        type: "answer",
        questionId: question.id,
        answer: question.answer ?? "",
      };
      const id = `answer:${question.id}`;
      if (question.ticketId === undefined) return [tell(ROUTER, "steer", answer, id)];
      return [
        {
          ...tell(ticketTarget(question.ticketId), "steer", answer, id),
          direct: true,
        },
        record(ROUTER, { ...answer, forwardedTo: question.ticketId }, `${id}:router`),
      ];
    }

    case "job-finished": {
      const { jobId, outcome, tail } = event;
      const notice: Notice = { type: "job-finished", jobId, outcome, tail };
      return [tell(ticketTarget(event.ticketId), "followUp", notice, `job:${jobId}`)];
    }

    case "jobs-interrupted":
      return [
        tell(
          ticketTarget(event.ticketId),
          "followUp",
          { type: "jobs-interrupted", jobIds: event.jobIds },
          `interrupted:${event.ticketId}:${event.jobIds.join(",")}`,
        ),
      ];

    case "panel-interrupt":
      return [
        record(
          ROUTER,
          { type: "panel-interrupt", ticketId: event.ticketId },
          `panel-interrupt:${event.id}`,
        ),
      ];

    case "handoff-nudge":
      return [tell(ROUTER, "followUp", { type: "handoff-nudge" }, `handoff:${event.epoch}`)];

    case "ticket-start":
      return [
        {
          target: ticketTarget(event.ticketId),
          mode: "start",
          whenBusy: "followUp",
          text: "",
          requestId: `opening:${event.ticketId}`,
        },
      ];

    case "router-message":
      return [
        {
          ...wake(ticketTarget(event.ticketId), event.whenBusy, event.text, `router:${event.id}`),
          notice: { type: "router-message", ticketId: event.ticketId },
        },
      ];

    case "panel-message":
      return [
        wake(ticketTarget(event.ticketId), event.whenBusy, event.text, `panel:${event.id}`),
        record(
          ROUTER,
          { type: "panel-message", ticketId: event.ticketId, text: event.text },
          `panel:${event.id}:router`,
        ),
      ];

    case "reminder": {
      if (event.reports.length === 0) return [];
      const reports = event.reports.map(({ ticketId, seq, status }) => ({ ticketId, seq, status }));
      const key = reports.map((r) => `${r.ticketId}#${r.seq}`).join(",");
      return [tell(ROUTER, "followUp", { type: "reminder", reports }, `reminder:${key}`)];
    }
  }
}

/** Whether a delivery carries the user's own words rather than something the Engine says. */
export const fromUser = (delivery: Delivery): boolean => delivery.notice === undefined;

const wake = (
  target: Target,
  whenBusy: Delivery["whenBusy"],
  text: string,
  requestId: string,
): Delivery => ({ target, mode: "wake", whenBusy, text, requestId });

/** Wakes the target with a notice the Engine words itself. */
const tell = (
  target: Target,
  whenBusy: Delivery["whenBusy"],
  notice: WordedNotice,
  requestId: string,
): Delivery => ({ ...wake(target, whenBusy, speak(notice), requestId), notice });

const record = (target: Target, notice: WordedNotice, requestId: string): Delivery => ({
  target,
  mode: "record",
  whenBusy: "followUp",
  text: speak(notice),
  requestId,
  notice,
});

/** Notices whose text the Engine writes; an opening or a Router message brings its own. */
type WordedNotice = Exclude<Notice, { type: "opening" | "router-message" }>;

/** How the model reads a notice. */
function speak(notice: WordedNotice): string {
  switch (notice.type) {
    case "report":
      return renderReport({ id: notice.ticketId, title: notice.title }, notice.report);
    case "accepted": {
      const head = `你等待的 ${notice.ticketId}「${notice.title}」已验收`;
      if (notice.report === undefined) return `${head}。`;
      return `${head}：\n${renderReport({ id: notice.ticketId, title: notice.title }, notice.report)}`;
    }
    case "delivered":
      return `已把 ${notice.ticketId} 的结果投递给 ${notice.to.join("、")}。`;
    case "cancelled":
      return `${notice.ticketId}「${notice.title}」已取消（${notice.reason}），但 ${notice.waiting.join("、")} 还在等它的结果，需要重新安排。`;
    case "answer": {
      const answer = `用户回答了问题 ${notice.questionId}：\n${notice.answer}`;
      if (notice.forwardedTo === undefined) return answer;
      return `用户已回答 ${notice.questionId}，答案已直接投给 ${notice.forwardedTo}。\n${answer}`;
    }
    case "job-finished":
      return `后台作业 ${formatAddress({ kind: "job", id: notice.jobId })} 已结束（${describeJobOutcome(notice.outcome)}）。\n输出末尾：\n${notice.tail}`;
    case "jobs-interrupted":
      return `引擎重启打断了后台作业：${notice.jobIds.join("、")}。请先检查工作目录和 git 状态，再决定是否重跑。`;
    case "panel-message":
      return `用户直接给 ${notice.ticketId} 发了消息：\n${notice.text}`;
    case "panel-interrupt":
      return `用户在面板打断了 ${notice.ticketId} 当前这一轮。`;
    case "handoff-nudge":
      return "你的上下文已经很长了。请先用 memory 记下有长期价值的决策，再用 handoff 写一段交接小结，从新的上下文继续。";
    case "reminder": {
      const list = notice.reports
        .map(
          (r) =>
            `- ${formatAddress({ kind: "report", ticketId: r.ticketId, seq: r.seq })}（${r.status}）`,
        )
        .join("\n");
      return `还有未处理的报告：\n${list}`;
    }
  }
}

/** How a job ended, in the words the model and the job log read. */
export function describeJobOutcome(outcome: JobOutcome): string {
  if (outcome.status === "killed") return "已终止";
  if (outcome.error === "timeout") return "超时终止";
  if (outcome.error !== undefined) return `出错：${outcome.error}`;
  return `退出码 ${outcome.exitCode}`;
}

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
