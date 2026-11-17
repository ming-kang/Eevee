import { defineExtension } from "@earendil-works/pi-durable";
import { WorkerAnchor } from "./anchor.ts";
import { FallbackReport, fallbackHook } from "./fallback.ts";
import type { OrchestrationDeps } from "./ports.ts";
import { ASK_USER_TOOL, askUserTool } from "./tools/ask-user.ts";
import { createReportTool, REPORT_TOOL } from "./tools/report.ts";
import { createTicketTool, TICKET_TOOL } from "./tools/ticket.ts";

export {
  type DeliveryContext,
  deliver,
  flush,
  NOTICE_KIND,
  pump,
  queuedTickets,
} from "./deliver.ts";
export type { EngineEvent } from "./delivery.ts";
export { route } from "./delivery.ts";
export type { HandoffPolicy, OrchestrationDeps, TicketConversations, TicketJobs } from "./ports.ts";
export { contextUsage, remindRouter, routerIdle } from "./upkeep.ts";

export const ORCHESTRATION_TOOLS = {
  ticket: TICKET_TOOL,
  askUser: ASK_USER_TOOL,
  report: REPORT_TOOL,
} as const;

export function createOrchestration(deps: OrchestrationDeps) {
  return defineExtension({
    name: "eevee.orchestration",
    tools: [createTicketTool(deps), askUserTool, createReportTool(deps)],
    tasks: [WorkerAnchor, FallbackReport],
    hooks: [fallbackHook],
  });
}
