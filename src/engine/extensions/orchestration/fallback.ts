import {
  AssistantEntry,
  defineTask,
  type EntryId,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  runEndTask,
} from "@earendil-works/pi-durable";
import { REPORT_SUMMARY_LIMIT } from "../../../domain/index.ts";
import { TicketDoc } from "../../docs.ts";
import { readBinding, readTicket } from "./board.ts";
import { submitReport } from "./deliver.ts";
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
      const router = await runtime.conversation(ROOT_CONVERSATION_ID, context);
      if (router === undefined) return runtime.commit(done, context);

      await runtime.commit(async (tx) => {
        const current = await tx.doc(TicketDoc, ticket.id, null);
        if (current.status !== "open") return done();
        await submitReport(tx, router, current, {
          ticketId: ticket.id,
          status: "waiting",
          summary: truncate(text || "(the turn ended without a report or a last answer)"),
          need: "The worker conversation submitted no final report; read its last answer and decide what's next.",
          origin: { type: "no-report", answered: text !== "" },
          artifacts: [],
          handled: false,
          reminded: false,
          at: runtime.now(),
        });
        return done();
      }, context);
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
