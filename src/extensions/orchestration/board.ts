import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { Board, QuestionDoc, ReportLog, TicketBinding, TicketDoc } from "../../contracts/docs.ts";
import {
  isFinalReport,
  latestFinalReport,
  type Question,
  questionId,
  type Report,
  type Ticket,
  type TicketId,
  ticketId,
} from "../../contracts/index.ts";

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

export async function appendReport(tx: Tx, report: Report): Promise<void> {
  (await tx.doc(ReportLog, report.ticketId, null)).reports.push(report);
}

export async function markHandled(tx: Tx, id: TicketId): Promise<void> {
  const log = await tx.doc(ReportLog, id, null);
  const latest = latestFinalReport(log.reports);
  if (latest !== undefined) latest.handled = true;
}

export async function closeTicket(
  tx: Tx,
  ticket: Ticket,
  status: "done" | "cancelled",
  note: string,
): Promise<void> {
  await saveTicket(tx, { ...ticket, status, closeNote: note });
  await markHandled(tx, ticket.id);
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
