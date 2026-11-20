import type { TicketView } from "../../../src/protocol/contract.ts";
import { effectiveStage } from "./board.ts";
import { displayId } from "./ids.ts";
import { STAGE_LABEL } from "./labels.ts";

export function resolveTicketRef(
  ticketId: string,
  tickets?: readonly TicketView[],
  label?: string,
) {
  const id = /^T\d+$/.test(ticketId) ? ticketId.toLowerCase() : ticketId;
  const view = tickets?.find((ticket) => ticket.ticket.id === id);
  const stage = view ? effectiveStage(view) : undefined;
  return {
    ticketId: id,
    label: !label || label.toLowerCase() === id ? displayId(id) : label,
    stage,
    tooltip: view && stage ? `${view.ticket.title} · ${STAGE_LABEL[stage]}` : displayId(id),
  };
}
