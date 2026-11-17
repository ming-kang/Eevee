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

export const TicketDoc = defineDocFamily<Ticket, Ticket>({
  kind: "eevee.ticket",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
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

export const QuestionDoc = defineDocFamily<Question, Question>({
  kind: "eevee.question",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
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
