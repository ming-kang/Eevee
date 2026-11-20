import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import {
  formatAddress,
  isFinalReport,
  ProblemError,
  problemOf,
  type Report,
} from "../../domain/index.ts";
import { TicketDoc } from "../docs.ts";
import { readBinding, readTicket } from "./board.ts";
import { submitReport } from "./deliver.ts";
import type { OrchestrationDeps } from "./ports.ts";
import { fail, ok } from "./result.ts";
import { settle } from "./settle.ts";

export async function executeReport(
  deps: OrchestrationDeps,
  args: Pick<
    Report,
    "status" | "summary" | "artifacts" | "detail" | "need" | "questions" | "lessons"
  >,
  api: ToolExecutionApi,
  context: Context,
) {
  const ticketId = await readBinding(api, api.conversationId, context);
  const ticket = ticketId && (await readTicket(api, ticketId, context));
  if (!ticket) return fail("Only a ticket's worker conversation can submit a report.");

  const draft: Omit<Report, "seq"> = {
    ticketId: ticket.id,
    status: args.status,
    summary: args.summary,
    artifacts: args.artifacts,
    handled: false,
    reminded: false,
    at: api.now(),
    ...(args.detail === undefined ? {} : { detail: args.detail }),
    ...(args.need === undefined ? {} : { need: args.need }),
    ...(args.questions === undefined ? {} : { questions: args.questions }),
    ...(args.lessons === undefined ? {} : { lessons: args.lessons }),
  };
  const final = isFinalReport(draft.status);
  const autoAccept = ticket.role === "dreamer" && draft.status === "ready";
  const router = await api.conversation(ROOT_CONVERSATION_ID, context);
  if (router === undefined)
    return fail("The root conversation is missing, the report cannot be submitted.");

  let report: Report;
  try {
    report = await api.commit(async (tx) => {
      const current = await tx.doc(TicketDoc, ticket.id, null);
      if (current.status !== "open") {
        throw new ProblemError({ code: "ticket_closed", ticketId: ticket.id });
      }
      const stored = await submitReport(tx, router, current, draft);
      if (autoAccept) {
        await settle(tx, ticket.id, {
          status: "done",
          note: "Auto-accepted when the dreamer ticket finished tidying up",
          at: api.now(),
        });
      }
      return stored;
    }, context);
  } catch (error) {
    if (problemOf(error).code === "ticket_closed") {
      return fail(`${ticket.id} is already closed and can no longer submit reports.`);
    }
    throw error;
  }

  const address = formatAddress({ kind: "report", ticketId: ticket.id, seq: report.seq });
  if (!final) return ok(`Recorded ${address}; keep working.`);

  // The Engine stops this ticket's execution as soon as the commit lands, so a handoff for it is pointless.
  const handoff = autoAccept
    ? undefined
    : (await deps.handoff.shouldHandoff(api.conversationId, context))
      ? await deps.conversations.opening(ticket, context, {
          conversationId: api.conversationId,
          latest: report,
        })
      : undefined;
  return ok(`Submitted ${address}; this turn is over.`, undefined, {
    terminate: true,
    ...(handoff === undefined ? {} : { handoff }),
  });
}
