import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, RegistrySnapshot, Tx } from "@earendil-works/pi-durable";
import type { Report, Ticket, TicketId } from "../../contracts/index.ts";

export type TicketConversations = {
  configure(
    tx: Tx,
    conversationId: ConversationId,
    ticket: Ticket,
    registry: RegistrySnapshot,
  ): Promise<void>;
  opening(ticket: Ticket, latest: Report | undefined, context: Context): Promise<string>;
};

export type HandoffPolicy = {
  shouldHandoff(conversationId: ConversationId, context: Context): Promise<boolean>;
};

export type TicketJobs = {
  stop(ticketId: TicketId): void;
};

export type OrchestrationDeps = {
  conversations: TicketConversations;
  handoff: HandoffPolicy;
  jobs: TicketJobs;
};
