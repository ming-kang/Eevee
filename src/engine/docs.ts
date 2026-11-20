import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type {
  AgentMemorySource,
  Job,
  JobId,
  MemoryOp,
  MemoryProposal,
  MemoryScope,
  ProposalId,
  Question,
  QuestionId,
  Report,
  Ticket,
  TicketId,
} from "../domain/index.ts";

export type BoardState = {
  nextTicket: number;
  nextQuestion: number;
  tickets: TicketId[];
  openQuestions: QuestionId[];
  nextProposal: number;
  openProposals: ProposalId[];
};

export const Board = defineDoc<BoardState>({
  kind: "eevee.board",
  version: 2,
  scope: "session",
  initial: () => ({
    nextTicket: 1,
    nextQuestion: 1,
    tickets: [],
    openQuestions: [],
    nextProposal: 1,
    openProposals: [],
  }),
  migrate: (value) => ({ ...(value as BoardState), nextProposal: 1, openProposals: [] }),
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

export const ProposalDoc = defineDocFamily<MemoryProposal, MemoryProposal | null>({
  kind: "eevee.memory-proposal",
  version: 1,
  scope: "session",
  family: true,
  initial: createdWhole("eevee.memory-proposal"),
  checkpointWhen: () => false,
});

export type MemoryDraftState = {
  scopes: Partial<
    Record<MemoryScope, { source: AgentMemorySource; actions: MemoryOp[]; createdAt: number }>
  >;
};
export const MemoryDraft = defineDoc<MemoryDraftState>({
  kind: "eevee.memory-draft",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ scopes: {} }),
  checkpointWhen: () => true,
});

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
