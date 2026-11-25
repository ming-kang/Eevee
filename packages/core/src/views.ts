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
  listConversationTasks,
  TaskRecordDoc,
  TasksBoardDoc,
} from "@eevee/agent";
import { MemoryMetaDoc } from "@eevee/memory";
import {
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
      const activeTaskCount = tasks.filter((task) => task.status === "running").length;
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

function addUsage(total: JsonRepresentation<Usage>, usage: JsonRepresentation<Usage>): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  if (usage.cacheWrite1h !== undefined) {
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  }
  if (usage.reasoning !== undefined) {
    total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  }
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;
}

export async function projectUsage(
  harness: Harness,
  routerConversationId: ConversationId,
  context: Context,
): Promise<UsageState> {
  const [total, memoryMeta] = await Promise.all([
    harness.usage(context),
    harness.snapshot(MemoryMetaDoc, routerConversationId, context),
  ]);
  const combined: UsageState = {
    models: structuredClone(total.models),
    tools: structuredClone(total.tools),
  };
  for (const [modelKey, usage] of Object.entries(memoryMeta?.usage ?? {})) {
    const existing = Object.hasOwn(combined.models, modelKey)
      ? combined.models[modelKey]
      : undefined;
    if (existing !== undefined) {
      addUsage(existing, usage);
    } else {
      Object.defineProperty(combined.models, modelKey, {
        value: structuredClone(usage),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
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
      } catch {
        // Isolate subscriber exceptions.
      }
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
      } catch {
        // Isolate subscriber exceptions.
      }
    }
  }
}
