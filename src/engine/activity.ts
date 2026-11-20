import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type CommitPublication,
  type Conversation,
  type Harness,
  LiveDoc,
  ToolResultEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import { jobId, questionId, type TicketId } from "../domain/index.ts";
import { Board, JobBoard, JobDoc, QuestionDoc, ReportLog, TicketDoc } from "./docs.ts";
import { conversationOf, NOTICE_KIND } from "./orchestration/index.ts";

const ACTIVITY_ENTRY_KINDS = new Set([
  UserEntry.kind,
  AssistantEntry.kind,
  ToolResultEntry.kind,
  NOTICE_KIND,
]);

const ACTIVITY_DOC_KINDS = new Set([
  Board.definition.kind,
  TicketDoc.definition.kind,
  ReportLog.definition.kind,
  QuestionDoc.definition.kind,
  JobDoc.definition.kind,
  JobBoard.definition.kind,
  LiveDoc.definition.kind,
]);

/** Whether a stored commit is project activity: a conversation turn or a change to a board or job document. */
export function isActivityCommit(pub: CommitPublication): boolean {
  return pub.changes.some(
    (c) =>
      (c.type === "entry" && ACTIVITY_ENTRY_KINDS.has(c.value.kind)) ||
      (c.type === "document" && ACTIVITY_DOC_KINDS.has(c.record.kind)),
  );
}

/**
 * When the project was last active, for a Session that keeps no commits from before it was opened: the newest
 * timestamp the board's tickets, reports, jobs, questions and conversations carry, `createdAt` at the earliest.
 */
export async function initialActiveAt(
  harness: Harness,
  root: Conversation,
  createdAt: number,
  context: Context,
): Promise<number> {
  let latest = createdAt;
  const max = (t: number | undefined) => {
    if (typeof t === "number" && t > latest) latest = t;
  };
  const scanConversation = async (conv: Conversation, limit: number) => {
    const entries = await conv.entries({ order: "descending" }, limit, undefined, context);
    for (const entry of entries.items) {
      for (const msg of entry.model ?? []) {
        max((msg as { timestamp?: number }).timestamp);
      }
    }
  };
  const board = await harness.snapshot(Board, context);
  const ticketIds = (board?.tickets ?? []) as TicketId[];
  for (const id of ticketIds) {
    const ticket = await harness.snapshot(TicketDoc, id, context);
    max(ticket?.createdAt);
    max(ticket?.closedAt);
    const reports = await harness.snapshot(ReportLog, id, context);
    for (const report of reports?.reports ?? []) max(report.at);
    // A closed ticket's conversation ended by `closedAt`; only open ones can be newer than their docs.
    if (ticket?.status === "open") {
      const conv = await harness.conversation(conversationOf(ticket), context);
      if (conv !== undefined) await scanConversation(conv, 4);
    }
  }
  const jobBoard = await harness.snapshot(JobBoard, context);
  const nextJob = jobBoard?.nextJob ?? 1;
  for (let i = Math.max(1, nextJob - 10); i < nextJob; i++) {
    const job = await harness.snapshot(JobDoc, jobId(i), context);
    max(job?.startedAt);
    max(job?.endedAt);
  }
  const nextQuestion = board?.nextQuestion ?? 1;
  for (let i = Math.max(1, nextQuestion - 10); i < nextQuestion; i++) {
    const q = await harness.snapshot(QuestionDoc, questionId(i), context);
    max(q?.askedAt);
    max(q?.answeredAt);
  }
  await scanConversation(root, 10);
  return latest;
}
