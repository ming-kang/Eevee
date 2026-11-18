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
      text: str({ description: "问题本身" }),
      options: arr(str(), { description: "可选答案；开放问题留空" }),
      recommended: opt(str({ description: "推荐答案" })),
    }),
    { minItems: 1, description: "一轮编号问题，每题附推荐答案" },
  ),
  ticketId: opt(
    str({ pattern: "^t[1-9][0-9]*$", description: "问题来自哪张工单的疑问；回答会直接投给它" }),
  ),
});

export const askUserTool = defineTool({
  name: ASK_USER_TOOL,
  description:
    "向用户提一轮结构化问题。立即返回，不要等待；用户回答后会作为一条新消息送达。" +
    "只在需要用户拍板时使用，能从文件和记忆里查到的先自己查。",
  parameters: Parameters,
  replay: "unsafe",
  async execute(args, api, context) {
    const ticketId = args.ticketId as TicketId | undefined;
    const seed = ticketId === undefined ? undefined : await readTicket(api, ticketId, context);
    if (ticketId !== undefined && seed === undefined) return fail(`没有工单 ${ticketId}。`);
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
    return ok(`已提问 ${question.id}，用户回答后会作为新消息送达。现在可以继续处理其他事情。`, {
      questionId: question.id,
    } satisfies AskDetails);
  },
});
