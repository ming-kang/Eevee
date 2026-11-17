import type { Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  LiveDoc,
  type RunFailure,
  type RunFailureReason,
  type TaskId,
} from "@earendil-works/pi-durable";
import { Board } from "../../contracts/docs.ts";
import { REPORT_SUMMARY_LIMIT, type Report } from "../../contracts/index.ts";
import { appendReport, conversationOf, nextSeq, readReports, readTicket } from "./board.ts";
import { type DeliveryContext, deliver } from "./deliver.ts";
import { route } from "./delivery.ts";

/** The run failure of a ticket conversation that already has its `failed` report. */
const ReportedFailure = defineDoc<{ taskId: TaskId | null }>({
  kind: "eevee.reported-failure",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ taskId: null }),
  checkpointWhen: () => false,
});

/** Ends that are someone's decision, not a failure: an interrupt, a reset, a continue with nothing to do. */
const DELIBERATE: ReadonlySet<RunFailureReason> = new Set([
  "aborted",
  "reset",
  "nothing_to_answer",
]);

const FAILURE_LABEL: Record<RunFailureReason, string> = {
  model_error: "模型调用失败",
  no_model: "没有配置模型",
  aborted: "已中止",
  reset: "上下文被重置",
  faulted: "运行出错",
  orphaned: "运行无法继续",
  interrupted: "运行被中断",
  restart_limit: "多次重启后放弃",
  nothing_to_answer: "没有需要回答的内容",
  turn_limit: "超出轮次上限",
};

export function describeRunFailure(failure: Pick<RunFailure, "reason" | "detail">): string {
  const label = FAILURE_LABEL[failure.reason] ?? failure.reason;
  return failure.detail === undefined ? label : `${label}：${failure.detail}`;
}

/**
 * Records a `failed` report for every open ticket whose last run ended in a failure (retries used up, its
 * turn limit, a crash loop), once per failed run, and wakes the Router with it.
 */
export async function reportRunFailures(
  host: DeliveryContext,
  now: number,
  context: Context,
): Promise<Report[]> {
  const reported: Report[] = [];
  for (const id of (await host.snapshot(Board, context))?.tickets ?? []) {
    const ticket = await readTicket(host, id, context);
    if (ticket?.status !== "open") continue;
    const conversationId = conversationOf(ticket);
    const live = await host.snapshot(LiveDoc, conversationId, context);
    const failure = live?.run === undefined ? live?.runFailure : undefined;
    if (failure === undefined || DELIBERATE.has(failure.reason)) continue;
    const marked = await host.snapshot(ReportedFailure, conversationId, context);
    if (marked?.taskId === failure.taskId) continue;

    const summary = `执行对话运行失败：${describeRunFailure(failure)}`;
    const report: Report = {
      ticketId: ticket.id,
      seq: nextSeq(await readReports(host, ticket.id, context)),
      status: "failed",
      summary:
        summary.length <= REPORT_SUMMARY_LIMIT
          ? summary
          : `${summary.slice(0, REPORT_SUMMARY_LIMIT - 1)}…`,
      need: "排除原因后用 ticket message 让它继续，或者取消工单。",
      artifacts: [],
      handled: false,
      reminded: false,
      at: now,
    };
    await deliver(host, route({ type: "report", ticket, report }), context, async (tx) => {
      await appendReport(tx, report);
      (await tx.doc(ReportedFailure, conversationId)).taskId = failure.taskId;
    });
    reported.push(report);
  }
  return reported;
}
