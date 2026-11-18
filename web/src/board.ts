import type { BoardView, TicketView } from "../../src/api/contract.ts";
import type {
  Job,
  Question,
  ReportStatus,
  Ticket,
  TicketId,
  TicketStage,
} from "../../src/contracts/index.ts";

export type RailTab = "tickets" | "jobs" | "detail";
export type VisualStage = TicketStage | "done" | "cancelled" | "progress";

export const STAGE_ORDER: readonly (TicketStage | "done" | "cancelled")[] = [
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

export type TicketGroups = {
  answer: TicketView[];
  active: TicketView[];
  closed: TicketView[];
  openCount: number;
};

/** Partition board tickets into `待回答`, `进行中`, and `已结单`, sorting within each group by stage order. */
export function groupTickets(tickets: readonly TicketView[]): TicketGroups {
  const answer: TicketView[] = [];
  const active: TicketView[] = [];
  const closed: TicketView[] = [];

  for (const view of tickets) {
    if (view.ticket.status !== "open") {
      closed.push(view);
    } else if (view.stage === "answer") {
      answer.push(view);
    } else {
      active.push(view);
    }
  }

  active.sort((a, b) => rankOf(effectiveStage(a)) - rankOf(effectiveStage(b)));
  closed.sort((a, b) => rankOf(effectiveStage(a)) - rankOf(effectiveStage(b)));

  return {
    answer,
    active,
    closed,
    openCount: answer.length + active.length,
  };
}

/** Single-line summary of the first unanswered question belonging to a ticket. */
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

/** Extract active background jobs from open tickets in board order. */
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

/** Count unanswered questions visible on the project board. */
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
