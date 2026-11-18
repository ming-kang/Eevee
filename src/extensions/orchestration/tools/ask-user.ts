import { defineTool } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { TicketDoc } from "../../../contracts/docs.ts";
import { type AskDetails, ProblemError, type TicketId } from "../../../contracts/index.ts";
import { addQuestion, markHandled, readTicket } from "../board.ts";
import { fail, ok } from "../result.ts";

export const ASK_USER_TOOL = "ask_user";

const Parameters = obj({
  items: arr(
    obj({
      text: str({ description: "The question itself" }),
      options: arr(str(), {
        description: "The possible answers; leave empty for an open question",
      }),
      recommended: opt(str({ description: "The recommended answer" })),
    }),
    { minItems: 1, description: "A numbered round of questions, each with a recommended answer" },
  ),
  ticketId: opt(
    str({
      pattern: "^t[1-9][0-9]*$",
      description: "The ticket the question comes from; the answer is delivered straight to it",
    }),
  ),
});

export const askUserTool = defineTool({
  name: ASK_USER_TOOL,
  description:
    "Ask the user a round of structured questions. Return immediately, do not wait; the answer arrives " +
    "as a new message once the user replies. Use it only when the user has to decide; look up what the " +
    "files and the memory can tell you first.",
  parameters: Parameters,
  replay: "unsafe",
  async execute(args, api, context) {
    const ticketId = args.ticketId as TicketId | undefined;
    const seed = ticketId === undefined ? undefined : await readTicket(api, ticketId, context);
    if (ticketId !== undefined && seed === undefined) return fail(`No ticket ${ticketId}.`);
    const question = await api.commit(async (tx) => {
      if (seed !== undefined) {
        const current = await tx.doc(TicketDoc, seed.id, seed);
        if (current.status !== "open") {
          throw new ProblemError({ code: "ticket_closed", ticketId: seed.id });
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
  },
});
