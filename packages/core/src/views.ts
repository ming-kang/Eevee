import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { JsonRepresentation } from "@earendil-works/chord/json";
import type { Usage } from "@earendil-works/pi-ai";
import {
  type CommitObservation,
  type ConversationId,
  type DocumentReader,
  type Harness,
  LiveDoc,
  type UsageState,
} from "@earendil-works/pi-durable";
import {
  type BackgroundTaskRecord,
  isTaskActiveStatus,
  listConversationTasks,
  TaskRecordDoc,
  TasksBoardDoc,
} from "@eevee/agent";
import { accumulateUsage, addUsage, MemoryMetaDoc } from "@eevee/memory";
import {
  CompactionUsageDoc,
  ProjectBoardDoc,
  QuestionDoc,
  type QuestionRecord,
  readBoard,
  readQuestions,
  readTickets,
  readWorkers,
  TicketDoc,
  type TicketRecord,
  WorkerDoc,
  type WorkerRecord,
} from "./docs.ts";
import { SerialPass } from "./serial-pass.ts";
import { deriveWorkerStatus } from "./status.ts";

export type WorkerBoardItem = WorkerRecord & {
  readonly activeTaskCount: number;
  readonly tasks: readonly BackgroundTaskRecord[];
};

export type BoardView = {
  readonly workers: readonly WorkerBoardItem[];
  readonly tickets: readonly TicketRecord[];
  readonly questions: readonly QuestionRecord[];
};

const BOARD_WATCHED_KINDS = new Set([
  ProjectBoardDoc.definition.kind,
  WorkerDoc.definition.kind,
  TicketDoc.definition.kind,
  QuestionDoc.definition.kind,
  LiveDoc.definition.kind,
  TasksBoardDoc.definition.kind,
  TaskRecordDoc.definition.kind,
]);

export async function readBoardView(reader: DocumentReader, context: Context): Promise<BoardView> {
  const board = await readBoard(reader, context);
  const [rawWorkers, tickets, questions] = await Promise.all([
    readWorkers(reader, context, board),
    readTickets(reader, context, board),
    readQuestions(reader, context, board),
  ]);
  const pendingIds = new Set(board?.pendingStarts.map((start) => start.workerId) ?? []);
  const workers = await Promise.all(
    rawWorkers.map(async (worker): Promise<WorkerBoardItem> => {
      const [live, tasks] = await Promise.all([
        reader.snapshot(LiveDoc, worker.conversationId, context),
        listConversationTasks(reader, worker.conversationId, context),
      ]);
      const activeTaskCount = tasks.filter((task) => isTaskActiveStatus(task.status)).length;
      const status = deriveWorkerStatus({
        worker,
        pendingWorkerIds: pendingIds,
        hasActiveRun: live?.run !== undefined,
        hasRunningTasks: activeTaskCount > 0,
      });
      return { ...worker, status, activeTaskCount, tasks };
    }),
  );
  return { workers, tickets, questions };
}

export function formatBoardOverview(view: BoardView): string {
  const lines: string[] = [];
  const activeWorkers = view.workers.filter((worker) => worker.status !== "closed");
  const closedCount = view.workers.length - activeWorkers.length;

  if (activeWorkers.length === 0) {
    lines.push(
      closedCount === 0
        ? "Workers: none yet."
        : `Workers: no active workers (${closedCount} closed).`,
    );
  } else {
    const ticketById = new Map(view.tickets.map((ticket) => [ticket.id, ticket]));
    lines.push("Active workers:");
    for (const worker of activeWorkers) {
      const ticket =
        worker.activeTicketId === undefined ? undefined : ticketById.get(worker.activeTicketId);
      const ticketText =
        ticket === undefined ? "no open ticket" : `ticket ${ticket.id} (${ticket.title})`;
      const tasksText =
        worker.activeTaskCount === 0
          ? ""
          : `, ${worker.activeTaskCount} running background task(s)`;
      lines.push(`- ${worker.id} "${worker.name}" [${worker.status}] — ${ticketText}${tasksText}`);
    }
    if (closedCount > 0) lines.push(`(${closedCount} closed worker(s))`);
  }

  const pendingQuestions = view.questions.filter(
    (question) => question.answeredAt === undefined && question.withdrawnAt === undefined,
  );
  if (pendingQuestions.length > 0) {
    lines.push("", "Unanswered user questions:");
    for (const question of pendingQuestions) {
      const summary = question.items.map((item) => item.question).join("; ");
      lines.push(`- ${question.id}: ${summary}`);
    }
  }
  return lines.join("\n");
}

export { addUsage };

function mergeModelUsage(
  models: Record<string, JsonRepresentation<Usage>>,
  extra: Readonly<Record<string, JsonRepresentation<Usage>>>,
): void {
  for (const [modelKey, usage] of Object.entries(extra)) {
    accumulateUsage(models, modelKey, usage);
  }
}

export type DailyUsageBucket = {
  readonly date: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: number;
  readonly turns: number;
};

const DAILY_ENTRY_PAGE_LIMIT = 500;
const DAILY_MAX_PAGES_PER_CONV = 20;

function toUtcDateKey(timestampMs: number): string {
  const d = new Date(timestampMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function asNonNegNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function projectDailyUsage(
  harness: Harness,
  routerConversationId: ConversationId,
  context: Context,
): Promise<DailyUsageBucket[]> {
  const board = await readBoard(harness, context);
  const workers = await readWorkers(harness, context, board);
  const convIds = new Set<ConversationId>([routerConversationId]);
  for (const worker of workers) convIds.add(worker.conversationId);

  const buckets = new Map<
    string,
    {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: number;
      turns: number;
    }
  >();

  for (const convId of convIds) {
    const conv = await harness.conversation(convId, context);
    if (!conv) continue;
    let cursor: Parameters<typeof conv.entries>[2];
    for (let pageIdx = 0; pageIdx < DAILY_MAX_PAGES_PER_CONV; pageIdx += 1) {
      const page = await conv.entries(
        { order: "ascending" },
        DAILY_ENTRY_PAGE_LIMIT,
        cursor,
        context,
      );
      for (const entry of page.items) {
        if (entry.kind !== "pi.assistant") continue;
        const messages = entry.model ?? [];
        for (const msg of messages) {
          if (msg.role !== "assistant") continue;
          const ts = asNonNegNumber(msg.timestamp);
          if (ts <= 0) continue;
          const usage = msg.usage;
          if (!usage || typeof usage !== "object") continue;
          const date = toUtcDateKey(ts);
          const input = asNonNegNumber(usage.input);
          const output = asNonNegNumber(usage.output);
          const cacheRead = asNonNegNumber(usage.cacheRead);
          const cacheWrite = asNonNegNumber(usage.cacheWrite);
          const totalTokens =
            asNonNegNumber(usage.totalTokens) || input + output + cacheRead + cacheWrite;
          const cost =
            usage.cost && typeof usage.cost === "object" ? asNonNegNumber(usage.cost.total) : 0;
          const cur = buckets.get(date) ?? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: 0,
            turns: 0,
          };
          cur.input += input;
          cur.output += output;
          cur.cacheRead += cacheRead;
          cur.cacheWrite += cacheWrite;
          cur.totalTokens += totalTokens;
          cur.cost += cost;
          cur.turns += 1;
          buckets.set(date, cur);
        }
      }
      if (!page.next) break;
      cursor = page.next;
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, stats]) => ({ date, ...stats }));
}

export async function projectUsage(
  harness: Harness,
  routerConversationId: ConversationId,
  context: Context,
): Promise<UsageState> {
  const [total, memoryMeta, compactionUsage] = await Promise.all([
    harness.usage(context),
    harness.snapshot(MemoryMetaDoc, routerConversationId, context),
    harness.snapshot(CompactionUsageDoc, context),
  ]);
  const combined: UsageState = {
    models: structuredClone(total.models),
    tools: structuredClone(total.tools),
  };
  mergeModelUsage(combined.models, memoryMeta?.usage ?? {});
  mergeModelUsage(combined.models, compactionUsage?.models ?? {});
  return combined;
}

export class BoardFeed {
  readonly #harness: Harness;
  readonly #context: Context;
  readonly #listeners = new Set<(view: BoardView) => void>();
  readonly #pass: SerialPass;
  readonly #observation: CommitObservation;
  #current: BoardView | undefined;
  #signature: string | undefined;

  constructor(
    harness: Harness,
    options: { readonly context?: Context; readonly onError?: (error: unknown) => void } = {},
  ) {
    this.#harness = harness;
    this.#context = options.context ?? BACKGROUND_CONTEXT;
    this.#pass = new SerialPass(() => this.#refresh(), {
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
    this.#observation = harness.observeCommits({
      advance: (publication) => {
        if (this.#listeners.size === 0) return;
        const relevant = publication.changes.some(
          (change) => change.type === "document" && BOARD_WATCHED_KINDS.has(change.record.kind),
        );
        if (relevant) this.#pass.request();
      },
      end: () => undefined,
    });
  }

  subscribe(listener: (view: BoardView) => void): () => void {
    this.#listeners.add(listener);
    if (this.#current !== undefined) {
      try {
        listener(this.#current);
      } catch {}
    }
    this.#pass.request();
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.#observation.detach();
    this.#listeners.clear();
    this.#pass.close();
    await this.#pass.idle();
  }

  async #refresh(): Promise<void> {
    if (this.#listeners.size === 0) return;
    const view = await readBoardView(this.#harness, this.#context);
    const signature = JSON.stringify(view);
    if (signature === this.#signature) return;
    this.#signature = signature;
    this.#current = view;
    for (const listener of [...this.#listeners]) {
      try {
        listener(view);
      } catch {}
    }
  }
}
