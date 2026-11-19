import { defineExtension } from "@earendil-works/pi-durable";
import { WorkerAnchor } from "./anchor.ts";
import { FallbackReport, fallbackHook } from "./fallback.ts";
import type { OrchestrationDeps } from "./ports.ts";
import { askUserTool } from "./tools/ask-user.ts";
import { createReportTool } from "./tools/report.ts";
import { createTicketTool } from "./tools/ticket.ts";

export {
  answerQuestion,
  conversationOf,
  type DocReader,
  readBinding,
  readTicket,
} from "./board.ts";
export {
  type DeliveryContext,
  deliver,
  flush,
  NOTICE_KIND,
  pump,
  purgeDeliveries,
  queuedTickets,
  submitReport,
  toSubmission,
  WorkerQueue,
} from "./deliver.ts";
export type { EngineEvent } from "./delivery.ts";
export { describeJobOutcome, route } from "./delivery.ts";
export { reportRunFailures } from "./failures.ts";
export { registerJob, runningJobs, settleJob } from "./jobs.ts";
export { openTicket, type TicketDraft } from "./open.ts";
export type { HandoffPolicy, OrchestrationDeps, TicketConversations, TicketJobs } from "./ports.ts";
export { contextUsage, remindRouter, routerIdle } from "./upkeep.ts";

/** The Router's side: creating and steering tickets, and asking the user. */
export const DISPATCH_EXTENSION = "eevee.dispatch";
/** A ticket conversation's side: reporting to the Router, with a fallback report when a run forgets to. */
export const REPORT_EXTENSION = "eevee.report";

export function createOrchestration(deps: OrchestrationDeps) {
  return {
    dispatch: defineExtension({
      name: DISPATCH_EXTENSION,
      tools: [createTicketTool(deps), askUserTool],
      tasks: [WorkerAnchor],
    }),
    reporting: defineExtension({
      name: REPORT_EXTENSION,
      tools: [createReportTool(deps)],
      tasks: [FallbackReport],
      hooks: [fallbackHook],
    }),
  };
}
