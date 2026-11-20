import {
  formatAddress,
  type JobId,
  type JobOutcome,
  type Notice,
  type Question,
  type Report,
  type Ticket,
  type TicketId,
} from "../../domain/index.ts";

export type Target = { kind: "router" } | { kind: "ticket"; id: TicketId };

export type Delivery = {
  target: Target;
  mode: "wake" | "record";
  whenBusy: "steer" | "followUp";
  text: string;
  requestId: string;
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
  | { type: "panel-withdrawn"; id: string; ticketId: TicketId; text: string }
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
        ...(question.items.length === 0
          ? {}
          : { question: question.items.map((item) => item.text) }),
        answer: question.answer ?? "",
      };
      const id = `answer:${question.id}`;
      if (question.ticketId === undefined) return [tell(ROUTER, "steer", answer, id)];
      return [
        tell(ticketTarget(question.ticketId), "steer", answer, id),
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

    case "panel-withdrawn":
      return [
        record(
          ROUTER,
          { type: "panel-withdrawn", ticketId: event.ticketId, text: event.text },
          `panel-withdrawn:${event.id}`,
        ),
      ];

    case "handoff-nudge":
      return [tell(ROUTER, "followUp", { type: "handoff-nudge" }, `handoff:${event.epoch}`)];

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

function speak(notice: WordedNotice): string {
  switch (notice.type) {
    case "report":
      return renderReport({ id: notice.ticketId, title: notice.title }, notice.report);
    case "accepted": {
      const head = `${notice.ticketId} “${notice.title}”, which this waits on, was accepted`;
      if (notice.report === undefined) return `${head}.`;
      return `${head}:\n${renderReport({ id: notice.ticketId, title: notice.title }, notice.report)}`;
    }
    case "delivered":
      return `Delivered the result of ${notice.ticketId} to ${notice.to.join(", ")}.`;
    case "cancelled":
      return `${notice.ticketId} “${notice.title}” was cancelled (${notice.reason}); the tickets waiting on it (${notice.waiting.join(", ")}) will need to be arranged again.`;
    case "answer": {
      const text = notice.question?.[0];
      const answer =
        text !== undefined && notice.question?.length === 1
          ? `The user answered question ${notice.questionId} (“${text}”):\n${notice.answer}`
          : `The user answered question ${notice.questionId}:\n${notice.answer}`;
      if (notice.forwardedTo === undefined) return answer;
      return `The user answered ${notice.questionId}; the answer went straight to ${notice.forwardedTo}.\n${answer}`;
    }
    case "job-finished":
      return `Background job ${formatAddress({ kind: "job", id: notice.jobId })} finished (${describeJobOutcome(notice.outcome)}).\nTail of its output:\n${notice.tail}`;
    case "jobs-interrupted":
      return `An Engine restart interrupted background jobs ${notice.jobIds.join(", ")}. Check the workspace and the git state first, then decide whether to run them again.`;
    case "panel-message":
      return `The user sent a message straight to ${notice.ticketId}:\n${notice.text}`;
    case "panel-interrupt":
      return `The user interrupted the current turn of ${notice.ticketId} from the panel.`;
    case "panel-withdrawn":
      return `The user withdrew the message sent to ${notice.ticketId} before it was read:\n${notice.text}`;
    case "handoff-nudge":
      return "Your context has grown very long. First record the decisions with long-term value in memory, then write a handoff summary with handoff and continue from a fresh context.";
    case "reminder": {
      const list = notice.reports
        .map(
          (r) =>
            `- ${formatAddress({ kind: "report", ticketId: r.ticketId, seq: r.seq })} (${r.status})`,
        )
        .join("\n");
      return `Reports still unhandled:\n${list}`;
    }
  }
}

/** How a job ended, in the words the model and the job log read. */
export function describeJobOutcome(outcome: JobOutcome): string {
  if (outcome.status === "killed") return "killed";
  if (outcome.error === "timeout") return "timed out";
  if (outcome.error !== undefined) return `error: ${outcome.error}`;
  return `exit code ${outcome.exitCode}`;
}

export function renderReport(ticket: Pick<Ticket, "id" | "title">, report: Report): string {
  const lines = [`[${ticket.id} “${ticket.title}” report · ${report.status}] ${report.summary}`];
  if (report.need) lines.push(`Missing: ${report.need}`);
  if (report.questions?.length) {
    lines.push("Questions to decide:", ...report.questions.map((q, i) => `${i + 1}. ${q.text}`));
  }
  if (report.artifacts.length) {
    lines.push("Artifacts:", ...report.artifacts.map((a) => `- ${a.path} (${a.note})`));
  }
  if (report.lessons?.length) lines.push("Lessons:", ...report.lessons.map((l) => `- ${l}`));
  lines.push(
    `Full report: ${formatAddress({ kind: "report", ticketId: ticket.id, seq: report.seq })}`,
  );
  return lines.join("\n");
}
