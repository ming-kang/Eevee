import type { Context } from "@earendil-works/chord/context";
import type { Tx } from "@earendil-works/pi-durable";
import { Board, QuestionDoc, ReportLog, TicketDoc } from "../../contracts/docs.ts";
import {
  latestFinalReport,
  ProblemError,
  type Question,
  type Ticket,
} from "../../contracts/index.ts";
import { type DocReader, readQuestions } from "./board.ts";
import { purgeDeliveries } from "./deliver.ts";

export type TicketClose = {
  status: "done" | "cancelled";
  note: string;
  at: number;
};

/** What a settlement has to know before its commit: the ticket and the questions still waiting on it. */
export type Settlement = { ticket: Ticket; questions: readonly Question[] };

/**
 * Reads the questions a ticket still owes an answer to. Durable's document families need a seed inside the
 * transaction, and `QuestionDoc` takes its whole value as one, so the questions are read before the commit;
 * the caller cannot forget to pass them.
 */
export async function prepareSettlement(
  reader: DocReader,
  ticket: Ticket,
  context: Context,
): Promise<Settlement> {
  const questions = (await readQuestions(reader, context)).filter(
    (question) => question.ticketId === ticket.id,
  );
  return { ticket, questions };
}

/**
 * The only way a ticket leaves `open`: it re-reads the ticket and, for an acceptance, the report the Router saw,
 * writes the close, withdraws the questions that were waiting on it and drops the deliveries waiting for it.
 */
export async function settle(
  tx: Tx,
  prepared: Settlement,
  close: TicketClose,
  options: { reportSeq?: number } = {},
): Promise<void> {
  const { ticket, questions } = prepared;
  const stored = await tx.doc(TicketDoc, ticket.id, ticket);
  if (stored.status !== "open")
    throw new ProblemError({ code: "ticket_closed", ticketId: ticket.id });
  const log = await tx.doc(ReportLog, ticket.id, null);
  const latest = latestFinalReport(log.reports);
  if (options.reportSeq !== undefined) {
    const ready = latest?.seq === options.reportSeq && latest.status === "ready" && !latest.handled;
    if (!ready) throw new ProblemError({ code: "report_changed", ticketId: ticket.id });
  }
  Object.assign(stored, {
    status: close.status,
    closeNote: close.note,
    closedAt: close.at,
  });
  if (latest !== undefined) latest.handled = true;
  const board = await tx.doc(Board);
  for (const seed of questions) {
    const question = await tx.doc(QuestionDoc, seed.id, seed);
    if (
      question.ticketId !== ticket.id ||
      question.answer !== undefined ||
      question.withdrawnAt !== undefined
    ) {
      continue;
    }
    question.withdrawnAt = close.at;
    board.openQuestions = board.openQuestions.filter((id) => id !== seed.id);
  }
  await purgeDeliveries(tx, ticket.id);
}
