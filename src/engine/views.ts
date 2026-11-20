import type { Context } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ConversationId,
  type Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";
import {
  deriveStage,
  failureView,
  type Job,
  type Question,
  summarizeRun,
  type TicketId,
} from "../domain/index.ts";
import type {
  BoardView,
  ConversationView,
  TicketView,
  UsageSummary,
  UsageView,
} from "../protocol/contract.ts";
import { Board, QuestionDoc, ReportLog, TicketDoc } from "./docs.ts";
import { conversationOf, type DocReader, queuedTickets } from "./orchestration/index.ts";
import { recentLines } from "./transcript.ts";

type Reader = DocReader;

export async function boardView(
  reader: Reader,
  runningJobs: (ticketId: TicketId) => Job[],
  context: Context,
): Promise<BoardView> {
  const state = await reader.snapshot(Board, context);
  const openQuestions: Question[] = [];
  for (const id of state?.openQuestions ?? []) {
    const question = await reader.snapshot(QuestionDoc, id, context);
    if (question) openQuestions.push(question);
  }
  const queued = await queuedTickets(reader, context);
  const tickets: TicketView[] = [];
  for (const id of (state?.tickets ?? []) as TicketId[]) {
    const ticket = await reader.snapshot(TicketDoc, id, context);
    if (ticket === undefined) continue;
    const reports = [...((await reader.snapshot(ReportLog, id, context))?.reports ?? [])];
    const live = await reader.snapshot(LiveDoc, conversationOf(ticket), context);
    const jobs = runningJobs(id);
    const stage = deriveStage({
      openQuestion: openQuestions.some((q) => q.ticketId === id),
      reports,
      queued: queued.has(id),
      running: live?.run !== undefined,
      jobsRunning: jobs.length > 0,
    });
    tickets.push({ ticket, stage, reports, jobs });
  }
  const router = summarizeRun(await reader.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context));
  return { tickets, openQuestions, router };
}

export async function conversationView(
  reader: Reader,
  conversation: Conversation,
  limit: number,
  context: Context,
): Promise<ConversationView> {
  const live = await reader.snapshot(LiveDoc, conversation.id, context);
  const failure = live?.run === undefined ? live?.runFailure : undefined;
  return {
    lines: await recentLines(conversation, limit, context),
    running: live?.run !== undefined,
    ...(failure === undefined ? {} : { failure: failureView(failure) }),
  };
}

export async function usageView(harness: Harness, context: Context): Promise<UsageView> {
  const total = await harness.usage(context);
  const own = async (id: ConversationId) =>
    summarize((await harness.snapshot(UsageDoc, id, context)) ?? { models: {}, tools: {} });
  const tickets: UsageView["tickets"] = [];
  for (const id of ((await harness.snapshot(Board, context))?.tickets ?? []) as TicketId[]) {
    const ticket = await harness.snapshot(TicketDoc, id, context);
    if (ticket === undefined) continue;
    tickets.push({ ticketId: id, title: ticket.title, usage: await own(conversationOf(ticket)) });
  }
  return {
    total: summarize(total),
    models: Object.fromEntries(
      Object.entries(total.models).map(([model, usage]) => [model, add(empty(), usage)]),
    ),
    router: await own(ROOT_CONVERSATION_ID),
    tickets,
  };
}

function summarize(state: Readonly<UsageState>): UsageSummary {
  const sum = empty();
  for (const usage of [...Object.values(state.models), ...Object.values(state.tools)])
    add(sum, usage);
  return sum;
}

const empty = (): UsageSummary => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

function add(
  sum: UsageSummary,
  usage: Readonly<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">> & {
    readonly cost: { readonly total: number };
  },
): UsageSummary {
  sum.input += usage.input;
  sum.output += usage.output;
  sum.cacheRead += usage.cacheRead;
  sum.cacheWrite += usage.cacheWrite;
  sum.cost += usage.cost.total;
  return sum;
}
