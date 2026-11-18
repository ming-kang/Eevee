import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { TicketDoc } from "../../../contracts/docs.ts";
import {
  formatAddress,
  isFinalReport,
  ProblemError,
  problemOf,
  REPORT_SUMMARY_LIMIT,
  type Report,
} from "../../../contracts/index.ts";
import { readBinding, readTicket, settleTicket } from "../board.ts";
import { purgeDeliveries, submitReport } from "../deliver.ts";
import type { OrchestrationDeps } from "../ports.ts";
import { fail, ok } from "../result.ts";

export const REPORT_TOOL = "report";

const Parameters = obj({
  status: oneOf(["progress", "waiting", "ready", "blocked", "failed", "dropped"], {
    description:
      "progress：阶段性进展，继续干；waiting：缺东西；ready：做完了等验收；" +
      "blocked / failed：做不下去 / 失败了；dropped：发现不需要做",
  }),
  summary: str({ maxLength: REPORT_SUMMARY_LIMIT, description: "给 Router 的摘要" }),
  detail: opt(str({ description: "完整内容，Router 需要时再读" })),
  artifacts: arr(obj({ path: str(), note: str() }), { description: "产物文件及一句说明" }),
  need: opt(str({ description: "waiting 时写明缺什么" })),
  questions: opt(
    arr(obj({ text: str(), options: arr(str()), recommended: opt(str()) }), {
      description: "需要用户决定的问题",
    }),
  ),
  lessons: opt(arr(str(), { description: "值得长期记住的经验" })),
});

export function createReportTool(deps: OrchestrationDeps) {
  return defineTool({
    name: REPORT_TOOL,
    description:
      "向 Router 提交报告。progress 之外的状态会结束本轮，所以收尾报告请单独调用、放在最后。",
    parameters: Parameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api, context) {
      const ticketId = await readBinding(api, api.conversationId, context);
      const ticket = ticketId && (await readTicket(api, ticketId, context));
      if (!ticket) return fail("只有工单的执行对话才能提交报告。");

      const draft: Omit<Report, "seq"> = {
        ticketId: ticket.id,
        status: args.status,
        summary: args.summary,
        artifacts: args.artifacts,
        handled: false,
        reminded: false,
        at: api.now(),
        ...(args.detail === undefined ? {} : { detail: args.detail }),
        ...(args.need === undefined ? {} : { need: args.need }),
        ...(args.questions === undefined ? {} : { questions: args.questions }),
        ...(args.lessons === undefined ? {} : { lessons: args.lessons }),
      };
      const final = isFinalReport(draft.status);
      const autoAccept = ticket.role === "dreamer" && draft.status === "ready";
      const router = await api.conversation(ROOT_CONVERSATION_ID, context);
      if (router === undefined) return fail("找不到主对话，无法提交报告。");

      let report: Report;
      try {
        report = await api.commit(async (tx) => {
          const current = await tx.doc(TicketDoc, ticket.id, ticket);
          if (current.status !== "open") {
            throw new ProblemError({ code: "ticket_closed", ticketId: ticket.id });
          }
          const stored = await submitReport(tx, router, current, draft);
          if (autoAccept) {
            await settleTicket(tx, current, {
              status: "done",
              note: "整理工单自动验收",
              at: api.now(),
            });
            await purgeDeliveries(tx, current.id);
          }
          return stored;
        }, context);
      } catch (error) {
        if (problemOf(error).code === "ticket_closed") {
          return fail(`${ticket.id} 已经结单，不能再提交报告。`);
        }
        throw error;
      }

      if (autoAccept) deps.jobs.stop(ticket.id);
      const address = formatAddress({ kind: "report", ticketId: ticket.id, seq: report.seq });
      if (!final) return ok(`已记录 ${address}，继续工作。`);

      const handoff = (await deps.handoff.shouldHandoff(api.conversationId, context))
        ? await deps.conversations.opening(ticket, context, {
            conversationId: api.conversationId,
            latest: report,
          })
        : undefined;
      return ok(`已提交 ${address}，本轮结束。`, undefined, {
        terminate: true,
        ...(handoff === undefined ? {} : { handoff }),
      });
    },
  });
}
