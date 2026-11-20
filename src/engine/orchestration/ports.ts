import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, RegistrySnapshot, Tx } from "@earendil-works/pi-durable";
import type { Report, Ticket } from "../../domain/index.ts";

/** How a ticket's conversation is set up; the roles module implements it. */
export type TicketConversations = {
  /** Applies the ticket's role, model and working directory to its conversation, in the creating commit. */
  configure(
    tx: Tx,
    conversationId: ConversationId,
    ticket: Ticket,
    registry: RegistrySnapshot,
  ): Promise<void>;
  /**
   * The ticket conversation's opening. With `handoff`, the opening it continues from after a reset that
   * came with the report `latest`.
   */
  opening(
    ticket: Ticket,
    context: Context,
    handoff?: { conversationId: ConversationId; latest: Report },
  ): Promise<string>;
};

export type HandoffPolicy = {
  shouldHandoff(conversationId: ConversationId, context: Context): Promise<boolean>;
};

export type OrchestrationDeps = {
  conversations: TicketConversations;
  handoff: HandoffPolicy;
};
