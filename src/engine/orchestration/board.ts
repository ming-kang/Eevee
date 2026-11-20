import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import {
  isFinalReport,
  latestFinalReport,
  ProblemError,
  type Question,
  type QuestionId,
  questionId,
  type Report,
  type Ticket,
  type TicketId,
  ticketId,
} from "../../domain/index.ts";
import { Board, QuestionDoc, ReportLog, TicketBinding, TicketDoc } from "../docs.ts";

export type DocReader = Pick<ToolExecutionApi, "snapshot">;

export const conversationOf = (ticket: Pick<Ticket, "conversationId">): ConversationId =>
  ticket.conversationId as ConversationId;

export const maybeConversationOf = (
  ticket: Pick<Ticket, "conversationId"> | undefined,
): ConversationId | undefined => (ticket === undefined ? undefined : conversationOf(ticket));

export async function readTicket(
  reader: DocReader,
  id: TicketId,
  context: Context,
): Promise<Ticket | undefined> {
  return reader.snapshot(TicketDoc, id, context);
}

export async function readReports(
  reader: DocReader,
  id: TicketId,
  context: Context,
): Promise<readonly Report[]> {
  return (await reader.snapshot(ReportLog, id, context))?.reports ?? [];
}

export async function readBinding(
  reader: DocReader,
  conversationId: ConversationId,
  context: Context,
): Promise<TicketId | undefined> {
  return (await reader.snapshot(TicketBinding, conversationId, context))?.ticketId ?? undefined;
}

export async function allocateTicketId(tx: Tx): Promise<TicketId> {
  const board = await tx.doc(Board);
  const id = ticketId(board.nextTicket);
  board.nextTicket += 1;
  board.tickets.push(id);
  return id;
}

export async function saveTicket(tx: Tx, ticket: Ticket): Promise<void> {
  Object.assign(await tx.doc(TicketDoc, ticket.id, ticket), ticket);
}

export async function bindConversation(
  tx: Tx,
  conversationId: ConversationId,
  id: TicketId,
): Promise<void> {
  (await tx.doc(TicketBinding, conversationId)).ticketId = id;
}

/** Appends `draft` with the next sequence of its ticket, which only this commit decides. */
export async function appendReport(tx: Tx, draft: Omit<Report, "seq">): Promise<Report> {
  const log = await tx.doc(ReportLog, draft.ticketId, null);
  const report: Report = { ...draft, seq: nextSeq(log.reports) };
  log.reports.push(report);
  return report;
}

export async function markHandled(tx: Tx, id: TicketId): Promise<void> {
  const log = await tx.doc(ReportLog, id, null);
  const latest = latestFinalReport(log.reports);
  if (latest !== undefined) latest.handled = true;
}

/** Records `answer` for a question nobody answered yet; a second answer fails instead of overwriting. */
export async function answerQuestion(
  tx: Tx,
  id: QuestionId,
  answer: string,
  at: number,
  answers?: string[],
): Promise<Question> {
  const stored = await tx.doc(QuestionDoc, id, null);
  if (stored.answer !== undefined) {
    throw new ProblemError({ code: "answered", questionId: id });
  }
  if (stored.withdrawnAt !== undefined) {
    throw new ProblemError({ code: "no_question", questionId: id });
  }
  const answered: Question = {
    ...stored,
    answer,
    answeredAt: at,
    ...(answers === undefined ? {} : { answers }),
  };
  Object.assign(stored, answered);
  const board = await tx.doc(Board);
  board.openQuestions = board.openQuestions.filter((open) => open !== id);
  return answered;
}

export async function addQuestion(tx: Tx, question: Omit<Question, "id">): Promise<Question> {
  const board = await tx.doc(Board);
  const created: Question = { ...question, id: questionId(board.nextQuestion) };
  board.nextQuestion += 1;
  board.openQuestions.push(created.id);
  Object.assign(await tx.doc(QuestionDoc, created.id, created), created);
  return created;
}

export function nextSeq(reports: readonly Report[]): number {
  return reports.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
}

export function pendingReports(reports: readonly Report[]): Report[] {
  const latest = latestFinalReport(reports);
  return latest !== undefined && isFinalReport(latest.status) && !latest.handled && !latest.reminded
    ? [latest]
    : [];
}
