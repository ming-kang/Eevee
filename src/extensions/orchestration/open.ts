import type { Context } from "@earendil-works/chord/context";
import type { RegistrySnapshot, Tx } from "@earendil-works/pi-durable";
import type { Ticket } from "../../contracts/index.ts";
import { WorkerAnchor } from "./anchor.ts";
import { allocateTicketId, bindConversation, markHandled, saveTicket } from "./board.ts";
import { enqueueStart, NOTICE_KIND } from "./deliver.ts";
import type { TicketConversations } from "./ports.ts";

export type TicketDraft = Pick<
  Ticket,
  "role" | "title" | "goal" | "inputs" | "acceptance" | "deliverTo"
> &
  Partial<Pick<Ticket, "output" | "model" | "modelReason">>;

/**
 * Creates a ticket in `tx`: a background anchor task that owns its conversation, so nothing that happens to
 * the creator reaches it, the conversation configured for the ticket's role, and its opening written into that
 * conversation. Only the start of the run waits for a free slot.
 */
export async function openTicket(
  tx: Tx,
  conversations: TicketConversations,
  registry: RegistrySnapshot,
  draft: TicketDraft,
  now: number,
  context: Context,
): Promise<Ticket> {
  const id = await allocateTicketId(tx);
  const anchor = await tx.createTask(WorkerAnchor, null, {
    ownership: { kind: "conversation" },
    background: true,
  });
  const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
  const ticket: Ticket = {
    id,
    ...draft,
    conversationId: conversation.id,
    status: "open",
    createdAt: now,
  };
  await conversations.configure(tx, conversation.id, ticket, registry);
  await saveTicket(tx, ticket);
  await bindConversation(tx, conversation.id, id);
  for (const to of ticket.deliverTo) await markHandled(tx, to);
  const opening = await conversations.opening(ticket, context);
  await enqueueStart(tx, id);
  await tx.appendEntry(conversation.id, {
    kind: NOTICE_KIND,
    data: { requestId: `opening:${id}`, notice: { type: "opening", ticketId: id } },
    model: [{ role: "user", content: opening, timestamp: now }],
  });
  return ticket;
}
