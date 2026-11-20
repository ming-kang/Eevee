import type { Context } from "@earendil-works/chord/context";
import { defineDoc, LiveDoc, ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import {
  describeRunFailure,
  failureView,
  isDeliberateEnd,
  REPORT_SUMMARY_LIMIT,
  type Report,
} from "../../../domain/index.ts";
import { Board } from "../../docs.ts";
import { conversationOf, readTicket } from "./board.ts";
import { type DeliveryContext, submitReport } from "./deliver.ts";

/** The run failure of a ticket conversation that already has its `failed` report. */
const ReportedFailure = defineDoc<{ taskId: TaskId | null }>({
  kind: "eevee.reported-failure",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ taskId: null }),
  checkpointWhen: () => false,
});

/**
 * Records a `failed` report for every open ticket whose last run ended in a failure (retries used up, its
 * turn limit, a crash loop), once per failed run, and wakes the Router with it.
 */
export async function reportRunFailures(
  host: DeliveryContext,
  now: number,
  context: Context,
): Promise<Report[]> {
  const reported: Report[] = [];
  for (const id of (await host.snapshot(Board, context))?.tickets ?? []) {
    const ticket = await readTicket(host, id, context);
    if (ticket?.status !== "open") continue;
    const conversationId = conversationOf(ticket);
    const live = await host.snapshot(LiveDoc, conversationId, context);
    const failure = live?.run === undefined ? live?.runFailure : undefined;
    if (failure === undefined || isDeliberateEnd(failure.reason)) continue;
    const marked = await host.snapshot(ReportedFailure, conversationId, context);
    if (marked?.taskId === failure.taskId) continue;

    const router = await host.conversation(ROOT_CONVERSATION_ID, context);
    if (router === undefined) continue;
    const summary = `The Worker's run failed: ${describeRunFailure(failure)}`;
    const report = await host.commit(async (tx) => {
      const stored = await submitReport(tx, router, ticket, {
        ticketId: ticket.id,
        status: "failed",
        summary:
          summary.length <= REPORT_SUMMARY_LIMIT
            ? summary
            : `${summary.slice(0, REPORT_SUMMARY_LIMIT - 1)}…`,
        need: "Once the cause is fixed, use ticket message to let it continue, or cancel the ticket.",
        origin: { type: "run-failed", failure: failureView(failure) },
        artifacts: [],
        handled: false,
        reminded: false,
        at: now,
      });
      (await tx.doc(ReportedFailure, conversationId)).taskId = failure.taskId;
      return stored;
    }, context);
    reported.push(report);
  }
  return reported;
}
