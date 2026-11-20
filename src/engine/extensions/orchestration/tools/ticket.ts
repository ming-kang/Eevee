import { defineTool } from "@earendil-works/pi-durable";
import type { OrchestrationDeps } from "../../../orchestration/ports.ts";
import { executeTicket } from "../../../orchestration/ticket.ts";
import { toolResult } from "../result.ts";
import { Parameters } from "./ticket-command.ts";
export const TICKET_TOOL = "ticket";

export function createTicketTool(deps: OrchestrationDeps) {
  return defineTool({
    name: TICKET_TOOL,
    description:
      "Manage tickets:\n" +
      "- create: make a ticket and start its worker conversation\n" +
      "- message: append an instruction to that conversation\n" +
      "- interrupt: abort the turn it is on\n" +
      "- review: handle a ready report (accept closes the ticket; rework sends it back)\n" +
      "- close: cancel a ticket\n" +
      "- model: switch the model of its worker conversation",
    parameters: Parameters,
    replay: "unsafe",
    executionMode: "sequential",
    execute: (args, api, context) => executeTicket(deps, args, api, context).then(toolResult),
  });
}
