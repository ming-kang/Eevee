import type { Tx } from "@earendil-works/pi-durable";
import {
  latestFinalReport,
  ProblemError,
  type QuestionId,
  type TicketId,
} from "../../domain/index.ts";
import { Board, QuestionDoc, ReportLog, TicketDoc } from "../docs.ts";
import { purgeDeliveries } from "./deliver.ts";

export type TicketClose = {
  status: "done" | "cancelled";
  note: string;
  at: number;
};

/**
 * The only way a ticket leaves `open`, and everything it implies, read and written in the caller's transaction:
 * it re-reads the ticket and, for an acceptance, checks the report the Router saw is still the one waiting; writes
 * the close; withdraws every question still waiting on the ticket; and drops the deliveries waiting for it.
 */
export async function settle(
  tx: Tx,
  id: TicketId,
  close: TicketClose,
  options: { reportSeq?: number } = {},
): Promise<void> {
  const ticket = await tx.doc(TicketDoc, id, null);
  if (ticket.status !== "open") throw new ProblemError({ code: "ticket_closed", ticketId: id });
  const log = await tx.doc(ReportLog, id, null);
  const latest = latestFinalReport(log.reports);
  if (options.reportSeq !== undefined) {
    const ready = latest?.seq === options.reportSeq && latest.status === "ready" && !latest.handled;
    if (!ready) throw new ProblemError({ code: "report_changed", ticketId: id });
  }
  Object.assign(ticket, { status: close.status, closeNote: close.note, closedAt: close.at });
  if (latest !== undefined) latest.handled = true;

  const board = await tx.doc(Board);
  const open: QuestionId[] = [];
  for (const questionId of board.openQuestions) {
    const question = await tx.doc(QuestionDoc, questionId, null);
    if (question.ticketId === id) question.withdrawnAt = close.at;
    else open.push(questionId);
  }
  board.openQuestions = open;
  await purgeDeliveries(tx, id);
}
