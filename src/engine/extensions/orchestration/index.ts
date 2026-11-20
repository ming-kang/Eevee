import { defineExtension } from "@earendil-works/pi-durable";
import { WorkerAnchor } from "../../orchestration/anchor.ts";
import { FallbackReport, fallbackHook } from "../../orchestration/fallback.ts";
import type { OrchestrationDeps } from "../../orchestration/ports.ts";
import { askUserTool } from "./tools/ask-user.ts";
import { createReportTool } from "./tools/report.ts";
import { createTicketTool } from "./tools/ticket.ts";

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
