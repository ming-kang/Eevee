import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { Job, JobId, Question, QuestionId, Report, Ticket, TicketId } from "./domain.ts";

export type BoardState = {
  nextTicket: number;
  nextQuestion: number;
  tickets: TicketId[];
  openQuestions: QuestionId[];
};

export const Board = defineDoc<BoardState>({
  kind: "eevee.board",
  version: 1,
  scope: "session",
  initial: () => ({ nextTicket: 1, nextQuestion: 1, tickets: [], openQuestions: [] }),
  checkpointWhen: () => false,
});

/**
 * `initial` of a family whose members one writer creates whole and every other commit only looks up: creating
 * passes the member as its seed, looking up passes `null`. A lookup that finds no member fails its commit instead
 * of inventing one, so a transaction reads a member by its key alone, never through a snapshot taken before it.
 */
function createdWhole<T>(kind: string): (seed: T | null) => T {
  return (seed) => {
    if (seed === null) throw new Error(`There is no ${kind} document to look up.`);
    return seed;
  };
}

/** Created by `saveTicket`; every other commit looks a ticket up with `tx.doc(TicketDoc, id, null)`. */
export const TicketDoc = defineDocFamily<Ticket, Ticket | null>({
  kind: "eevee.ticket",
  version: 1,
  scope: "session",
  family: true,
  initial: createdWhole("eevee.ticket"),
  checkpointWhen: () => false,
});

export type ReportLogState = { reports: Report[] };

export const ReportLog = defineDocFamily<ReportLogState, null>({
  kind: "eevee.reports",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ reports: [] }),
  checkpointWhen: (value) => value.reports.length % 20 === 0,
});

export type TicketBindingState = { ticketId: TicketId | null };

export const TicketBinding = defineDoc<TicketBindingState>({
  kind: "eevee.ticket-binding",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ ticketId: null }),
  checkpointWhen: () => false,
});

/** Created by `addQuestion`; every other commit looks a question up with `tx.doc(QuestionDoc, id, null)`. */
export const QuestionDoc = defineDocFamily<Question, Question | null>({
  kind: "eevee.question",
  version: 1,
  scope: "session",
  family: true,
  initial: createdWhole("eevee.question"),
  checkpointWhen: () => false,
});

export type JobBoardState = {
  nextJob: number;
  running: JobId[];
};

export const JobBoard = defineDoc<JobBoardState>({
  kind: "eevee.job-board",
  version: 1,
  scope: "session",
  initial: () => ({ nextJob: 1, running: [] }),
  checkpointWhen: () => true,
});

export const JobDoc = defineDocFamily<Job, Job>({
  kind: "eevee.job",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  checkpointWhen: () => false,
});
