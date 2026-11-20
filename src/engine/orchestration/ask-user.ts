import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Question } from "../../domain/index.ts";
import { type AskDetails, ProblemError, type TicketId } from "../../domain/index.ts";
import { TicketDoc } from "../docs.ts";
import { addQuestion, markHandled, readTicket } from "./board.ts";
import { fail, ok } from "./result.ts";

export async function executeAskUser(
  args: { ticketId?: string; items: Question["items"] },
  api: ToolExecutionApi,
  context: Context,
) {
  const ticketId = args.ticketId as TicketId | undefined;
  if (ticketId !== undefined && (await readTicket(api, ticketId, context)) === undefined)
    return fail(`No ticket ${ticketId}.`);
  const question = await api.commit(async (tx) => {
    if (ticketId !== undefined) {
      const current = await tx.doc(TicketDoc, ticketId, null);
      if (current.status !== "open") {
        throw new ProblemError({ code: "ticket_closed", ticketId });
      }
    }
    const created = await addQuestion(tx, {
      ...(ticketId === undefined ? {} : { ticketId }),
      items: args.items,
      askedAt: api.now(),
    });
    if (ticketId !== undefined) await markHandled(tx, ticketId);
    return created;
  }, context);
  return ok(
    `Asked ${question.id}; the answer arrives as a new message once the user replies. You can move on to other work now.`,
    {
      questionId: question.id,
    } satisfies AskDetails,
  );
}
