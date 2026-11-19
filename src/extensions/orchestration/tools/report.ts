import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { TicketDoc } from "../../../contracts/docs.ts";
import {
  formatAddress,
  isFinalReport,
  ProblemError,
  problemOf,
  REPORT_SUMMARY_LIMIT,
  type Report,
} from "../../../contracts/index.ts";
import { readBinding, readTicket } from "../board.ts";
import { submitReport } from "../deliver.ts";
import type { OrchestrationDeps } from "../ports.ts";
import { fail, ok } from "../result.ts";
import { prepareSettlement, settle } from "../settle.ts";

export const REPORT_TOOL = "report";

const Parameters = obj({
  status: oneOf(["progress", "waiting", "ready", "blocked", "failed", "dropped"], {
    description:
      "progress: a step forward, keep working; waiting: something is missing; " +
      "ready: done and waiting for review; blocked: cannot go on; " +
      "failed: the work did not succeed; dropped: the work turned out to be unnecessary",
  }),
  summary: str({ maxLength: REPORT_SUMMARY_LIMIT, description: "A summary for the Router" }),
  detail: opt(str({ description: "The full content, read when the Router needs it" })),
  artifacts: arr(obj({ path: str(), note: str() }), {
    description: "Artifact files with a one-line note each",
  }),
  need: opt(str({ description: "What is missing; use it with the waiting status" })),
  questions: opt(
    arr(obj({ text: str(), options: arr(str()), recommended: opt(str()) }), {
      description: "Questions the user has to decide",
    }),
  ),
  lessons: opt(arr(str(), { description: "Lessons worth remembering for the long term" })),
});

export function createReportTool(deps: OrchestrationDeps) {
  return defineTool({
    name: REPORT_TOOL,
    description:
      "Submit a report to the Router. Every status but progress ends this turn, so call it on its own and put it " +
      "last when you wrap up.",
    parameters: Parameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api, context) {
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
      const settlement = autoAccept ? await prepareSettlement(api, ticket, context) : undefined;
      try {
        report = await api.commit(async (tx) => {
          const current = await tx.doc(TicketDoc, ticket.id, ticket);
          if (current.status !== "open") {
            throw new ProblemError({ code: "ticket_closed", ticketId: ticket.id });
          }
          const stored = await submitReport(tx, router, current, draft);
          if (settlement !== undefined) {
            await settle(tx, settlement, {
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
    },
  });
}
