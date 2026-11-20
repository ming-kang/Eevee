import type { TicketId } from "./domain.ts";
import { ProblemError } from "./problem.ts";

export type ConversationRef = "router" | TicketId;

export function parseConversationRef(value: string): ConversationRef {
  if (value === "router" || /^t[1-9]\d*$/.test(value)) return value as ConversationRef;
  throw new ProblemError({ code: "invalid", field: "conversation" });
}
