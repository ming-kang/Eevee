import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  defineTask,
  type EntryId,
  GenerationTask,
  hook,
  runEndTask,
  type Tx,
} from "@earendil-works/pi-durable";
import { REPORT_SUMMARY_LIMIT, type Report } from "../../contracts/index.ts";
import { appendReport, nextSeq, readBinding, readReports, readTicket } from "./board.ts";
import { flush, prepare, submit } from "./deliver.ts";
import { route } from "./delivery.ts";
import { runningJobs } from "./jobs.ts";

type FallbackInput = { answer: number };

export const FallbackReport = defineTask<FallbackInput, { phase: "report" }, null>({
  name: "eevee.fallback-report",
  version: 1,
  initial: () => ({ phase: "report" }),
  phases: {
    report: async (task, runtime, context) => {
      const done = () =>
        ({ status: "terminal", outcome: { status: "completed", result: null } }) as const;
      const ticketId = await readBinding(runtime, runtime.conversationId, context);
      const ticket = ticketId && (await readTicket(runtime, ticketId, context));
      if (ticket?.status !== "open") return runtime.commit(done, context);
      if ((await runningJobs(runtime, context, ticket.id)).length > 0) {
        return runtime.commit(done, context);
      }

      const entry = await runtime.entry(AssistantEntry, task.input.answer as EntryId, context);
      const text = textOf(entry?.model?.[0]);
      const report: Report = {
        ticketId: ticket.id,
        seq: nextSeq(await readReports(runtime, ticket.id, context)),
        status: "waiting",
        summary: truncate(text || "（本轮结束，但没有提交报告，也没有留下回答）"),
        need: "执行对话没有提交收尾报告，请查看它的最后回答后决定下一步。",
        artifacts: [],
        handled: false,
        reminded: false,
        at: runtime.now(),
      };
      const host = {
        snapshot: runtime.snapshot.bind(runtime),
        conversation: runtime.conversation.bind(runtime),
        commit: (change: (tx: Tx) => Promise<void>, ctx: Context) =>
          runtime.commit(async (tx) => {
            await change(tx);
            return undefined;
          }, ctx),
      };
      const prepared = await prepare(host, route({ type: "report", ticket, report }), context);
      await runtime.commit(async (tx) => {
        await submit(tx, prepared);
        await appendReport(tx, report);
        return done();
      }, context);
      await flush(host, context);
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export const fallbackHook = hook(GenerationTask, {
  async afterRun(run, api, context) {
    if (run.reason !== "answer") return undefined;
    if ((await readBinding(api, api.conversationId, context)) === undefined) return undefined;
    return { tasks: [runEndTask(FallbackReport, { answer: run.answer })] };
  },
});

function textOf(message: unknown): string {
  const content = (message as { content?: { type: string; text?: string }[] } | undefined)?.content;
  return (content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("");
}

function truncate(text: string): string {
  return text.length <= REPORT_SUMMARY_LIMIT ? text : `${text.slice(0, REPORT_SUMMARY_LIMIT - 1)}…`;
}
