import type { BoardView, TicketView } from "../../../src/api/contract.ts";
import type {
  Job,
  Question,
  ReportStatus,
  Ticket,
  TicketId,
  TicketStage,
} from "../../../src/contracts/index.ts";

export type RailTab = "tickets" | "jobs" | "detail";
export type VisualStage = TicketStage | "done" | "cancelled" | "progress";

const STAGE_ORDER: readonly (TicketStage | "done" | "cancelled")[] = [
  "answer",
  "review",
  "blocked",
  "working",
  "jobs",
  "queued",
  "waiting",
  "idle",
  "done",
  "cancelled",
];

const STAGE_RANK = new Map<TicketStage | "done" | "cancelled", number>(
  STAGE_ORDER.map((stage, index) => [stage, index]),
);

const rankOf = (stage: TicketStage | "done" | "cancelled"): number =>
  STAGE_RANK.get(stage) ?? STAGE_ORDER.length;

export function effectiveStage(
  view: Pick<TicketView, "ticket" | "stage">,
): TicketStage | "done" | "cancelled" {
  return view.ticket.status !== "open" ? view.ticket.status : view.stage;
}

/** Latest activity timestamp available in a board snapshot (not the live conversation). */
export function ticketActivityAt(view: TicketView): number {
  let at = Math.max(view.ticket.createdAt, view.ticket.closedAt ?? 0, view.ticket.stoppedAt ?? 0);
  for (const report of view.reports) at = Math.max(at, report.at);
  for (const job of view.jobs) at = Math.max(at, job.startedAt, job.endedAt ?? 0);
  return at;
}

export type TicketGroups = {
  /** Open tickets waiting on the user's answer. */
  answer: TicketView[];
  /** Open tickets whose report awaits review. */
  review: TicketView[];
  /** Open tickets stopped on a problem. */
  blocked: TicketView[];
  /** Every other open ticket: queued, working, jobs, waiting or idle. */
  active: TicketView[];
  closed: TicketView[];
  openCount: number;
};

export function groupTickets(tickets: readonly TicketView[]): TicketGroups {
  const answer: TicketView[] = [];
  const review: TicketView[] = [];
  const blocked: TicketView[] = [];
  const active: TicketView[] = [];
  const closed: TicketView[] = [];

  for (const view of tickets) {
    if (view.ticket.status !== "open") {
      closed.push(view);
    } else if (view.stage === "answer") {
      answer.push(view);
    } else if (view.stage === "review") {
      review.push(view);
    } else if (view.stage === "blocked") {
      blocked.push(view);
    } else {
      active.push(view);
    }
  }

  const byStage = (a: TicketView, b: TicketView): number =>
    rankOf(effectiveStage(a)) - rankOf(effectiveStage(b));
  answer.sort(byStage);
  review.sort(byStage);
  blocked.sort(byStage);
  active.sort(byStage);
  closed.sort(byStage);

  return {
    answer,
    review,
    blocked,
    active,
    closed,
    openCount: answer.length + review.length + blocked.length + active.length,
  };
}

export function ticketQuestionSummary(
  ticketId: TicketId,
  questions: readonly Question[],
): string | undefined {
  const question = questions.find((q) => q.ticketId === ticketId && q.answer === undefined);
  const text = question?.items[0]?.text;
  if (!text) return undefined;
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed || undefined;
}

export type RunningJobItem = {
  job: Job;
  ticket: Ticket;
  stage: TicketStage;
};

export function collectRunningJobs(tickets: readonly TicketView[]): RunningJobItem[] {
  const result: RunningJobItem[] = [];
  for (const view of tickets) {
    if (view.ticket.status !== "open") continue;
    for (const job of view.jobs) {
      if (job.status !== "running") continue;
      result.push({ job, ticket: view.ticket, stage: view.stage });
    }
  }
  return result;
}

export function countPendingQuestions(board: Pick<BoardView, "openQuestions"> | undefined): number {
  if (!board) return 0;
  return board.openQuestions.filter((q) => q.answer === undefined).length;
}

/** Fall back from `detail` to `tickets` when leaving the Worker view. */
export function resolveRailTab(requested: RailTab, hasDetail: boolean): RailTab {
  if (requested === "detail" && !hasDetail) return "tickets";
  return requested;
}

const REPORT_GLYPH: Record<ReportStatus, VisualStage> = {
  progress: "progress",
  waiting: "waiting",
  ready: "review",
  blocked: "blocked",
  failed: "blocked",
  dropped: "cancelled",
};

export function reportStage(status: ReportStatus): VisualStage {
  return REPORT_GLYPH[status];
}
