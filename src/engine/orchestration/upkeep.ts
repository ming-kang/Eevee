import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type Conversation,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Report } from "../../domain/index.ts";
import { Board, ReportLog } from "../docs.ts";
import { pendingReports, readReports, readTicket } from "./board.ts";
import { type DeliveryContext, deliver } from "./deliver.ts";
import { route } from "./delivery.ts";

export async function routerIdle(host: DeliveryContext, context: Context): Promise<boolean> {
  return (await host.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.run === undefined;
}

export async function remindRouter(
  host: DeliveryContext,
  options: { olderThan: number; now: number },
  context: Context,
): Promise<Report[]> {
  if (!(await routerIdle(host, context))) return [];
  const due: Report[] = [];
  for (const id of (await host.snapshot(Board, context))?.tickets ?? []) {
    const ticket = await readTicket(host, id, context);
    if (ticket?.status !== "open") continue;
    const pending = pendingReports(await readReports(host, id, context));
    due.push(...pending.filter((r) => options.now - r.at >= options.olderThan));
  }
  if (due.length === 0) return [];
  await deliver(host, route({ type: "reminder", reports: due }), context, async (tx) => {
    for (const report of due) await markReminded(tx, report);
  });
  return due;
}

async function markReminded(tx: Tx, report: Report): Promise<void> {
  const log = await tx.doc(ReportLog, report.ticketId, null);
  const stored = log.reports.find((r) => r.seq === report.seq);
  if (stored !== undefined) stored.reminded = true;
}

export type ContextUsage = { tokens: number; epoch: number };

export async function contextUsage(
  conversation: Conversation,
  context: Context,
): Promise<ContextUsage> {
  const view = await conversation.context(context);
  const epoch = view.head?.id ?? 0;
  for (const entry of [...view.entries].reverse()) {
    if (!AssistantEntry.is(entry)) continue;
    const usage = (entry.model?.[0] as { usage?: Usage } | undefined)?.usage;
    if (usage === undefined) continue;
    return { tokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output, epoch };
  }
  return { tokens: 0, epoch };
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
