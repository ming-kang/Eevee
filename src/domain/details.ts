import type { Job, JobId, QuestionId, Report, TicketId } from "./domain.ts";
import type { MemoryProposal } from "./memory.ts";

export type JobOutcome = Pick<Job, "status" | "exitCode" | "error">;

/**
 * What an Engine notice says, as data. The Engine words it for the model; an interface words it for
 * its reader from the same facts, so neither has to read the other's prose.
 */
export type Notice =
  | {
      type: "proposal-decided";
      proposalId: string;
      scope: MemoryProposal["scope"];
      status: MemoryProposal["status"];
      summary: string;
      reason?: string;
      file?: string;
    }
  | { type: "report"; ticketId: TicketId; title: string; report: Report }
  /** A ticket this one waits on was accepted; `report` is the one that closed it. */
  | { type: "accepted"; ticketId: TicketId; title: string; report?: Report }
  | { type: "delivered"; ticketId: TicketId; to: TicketId[] }
  | { type: "cancelled"; ticketId: TicketId; title: string; reason: string; waiting: TicketId[] }
  /** The user's answer; `forwardedTo` on the Router's copy of an answer that went to a ticket. */
  | {
      type: "answer";
      questionId: QuestionId;
      /** The item texts, so a reader can show what was asked without a lookup. */
      question?: string[];
      answer: string;
      forwardedTo?: TicketId;
    }
  | { type: "job-finished"; jobId: JobId; outcome: JobOutcome; tail: string }
  | { type: "jobs-interrupted"; jobIds: JobId[] }
  /** The Router's copy of what the user sent a ticket directly. */
  | { type: "panel-message"; ticketId: TicketId; text: string }
  | { type: "panel-interrupt"; ticketId: TicketId }
  /** The user pulled a queued message to a ticket back before the Worker read it. */
  | { type: "panel-withdrawn"; ticketId: TicketId; text: string }
  | { type: "handoff-nudge" }
  /** The ticket's opening, or a Router message to it: the notice's text is the content itself. */
  | { type: "opening"; ticketId: TicketId }
  | { type: "router-message"; ticketId: TicketId }
  | { type: "reminder"; reports: Pick<Report, "ticketId" | "seq" | "status">[] };

/** `data` of an `eevee.notice` entry. */
export type NoticeData = { requestId: string; notice?: Notice };

/** `details` of a `ticket` result that created a ticket. */
export type TicketDetails = { ticketId: TicketId };

/** `details` of an `ask_user` result. */
export type AskDetails = { questionId: QuestionId };

export type BashDetails = { exitCode?: number; jobId?: JobId; stopped?: true };
