import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  type CommitObservation,
  ConversationBusy,
  type Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type RunFailure,
} from "@earendil-works/pi-durable";
import {
  NOTICE_ENTRY_KIND,
  ProjectBoardDoc,
  type ProjectBoardState,
  readBoard,
  readWorker,
  readWorkers,
  WorkerDoc,
  type WorkerDocState,
  type WorkerId,
} from "./docs.ts";
import { SerialPass } from "./serial-pass.ts";

export type ProjectPumpOptions = {
  readonly maxActiveWorkers?: number | (() => number);
  readonly context?: Context;
  readonly onError?: (error: unknown) => void;
};

const WATCHED_DOCUMENT_KINDS = new Set([
  LiveDoc.definition.kind,
  ProjectBoardDoc.definition.kind,
  WorkerDoc.definition.kind,
]);

const DELIBERATE_FAILURE_REASONS = new Set(["aborted", "reset"]);

function describeFailure(failure: RunFailure): string {
  return failure.detail === undefined ? failure.reason : `${failure.reason}: ${failure.detail}`;
}

export class ProjectPump {
  readonly #harness: Harness;
  readonly #context: Context;
  readonly #maxActiveWorkers: () => number;
  readonly #observation: CommitObservation;
  readonly #pass: SerialPass;

  constructor(harness: Harness, options: ProjectPumpOptions = {}) {
    this.#harness = harness;
    this.#context = options.context ?? BACKGROUND_CONTEXT;
    const max = options.maxActiveWorkers;
    this.#maxActiveWorkers = typeof max === "function" ? max : () => max ?? 3;
    this.#pass = new SerialPass(
      async () => {
        await this.pumpPendingStarts();
        await this.reportRunFailures();
      },
      {
        ...(options.onError === undefined ? {} : { onError: options.onError }),
      },
    );
    this.#observation = harness.observeCommits({
      advance: (publication) => {
        const relevant = publication.changes.some(
          (change) => change.type === "document" && WATCHED_DOCUMENT_KINDS.has(change.record.kind),
        );
        if (relevant) this.request();
      },
      end: () => undefined,
    });
  }

  request(): void {
    this.#pass.request();
  }

  close(): void {
    this.#observation.detach();
    this.#pass.close();
  }

  async idle(): Promise<void> {
    await this.#pass.idle();
  }

  async pumpPendingStarts(): Promise<void> {
    for (;;) {
      const board = await readBoard(this.#harness, this.#context);
      if (board === undefined || board.pendingStarts.length === 0) return;

      const workers = await this.#workersById(board);
      const invalid = new Set<WorkerId>();
      for (const start of board.pendingStarts) {
        const worker = workers.get(start.workerId);
        if (worker === undefined || worker.closedAt !== undefined) invalid.add(start.workerId);
      }
      if (invalid.size > 0) {
        await this.#removePendingStarts(invalid);
        continue;
      }

      const active = await this.#activeRunCount(workers);
      if (active >= this.#maxActiveWorkers()) return;

      for (const start of board.pendingStarts) {
        const worker = workers.get(start.workerId);
        if (worker === undefined) {
          await this.#removePendingStarts(new Set([start.workerId]));
          break;
        }
        const live = await this.#harness.snapshot(LiveDoc, worker.conversationId, this.#context);
        if (live?.run !== undefined) continue;
        const conversation = await this.#harness.conversation(worker.conversationId, this.#context);
        if (conversation === undefined) {
          await this.#removePendingStarts(new Set([start.workerId]));
          break;
        }

        try {
          const started = await this.#harness.commit(async (tx) => {
            const draft = await tx.doc(ProjectBoardDoc);
            const index = draft.pendingStarts.findIndex(
              (candidate) => candidate.requestId === start.requestId,
            );
            if (index < 0) return false;
            const current = await tx.doc(WorkerDoc, start.workerId, null);
            if (
              current.closedAt !== undefined ||
              current.conversationId !== worker.conversationId
            ) {
              draft.pendingStarts.splice(index, 1);
              return false;
            }
            await conversation.submit(tx, { type: "continue", requestId: start.requestId });
            draft.pendingStarts.splice(index, 1);
            return true;
          }, this.#context);
          if (started) break;
        } catch (error) {
          if (error instanceof ConversationBusy) continue;
          throw error;
        }
      }
      // If no start made progress in this scan, exit until the next commit triggers a pass.
      const after = await readBoard(this.#harness, this.#context);
      if (
        after === undefined ||
        (after.pendingStarts.length === board.pendingStarts.length &&
          after.pendingStarts.every(
            (item, idx) => item.requestId === board.pendingStarts[idx]?.requestId,
          ))
      ) {
        return;
      }
    }
  }

  async reportRunFailures(): Promise<void> {
    const board = await readBoard(this.#harness, this.#context);
    if (board === undefined || board.workerOrder.length === 0) return;
    const workers = await readWorkers(this.#harness, this.#context, board);
    const snapshots = await Promise.all(
      workers
        .filter((worker) => worker.closedAt === undefined)
        .map(async (worker) => ({
          worker,
          live: await this.#harness.snapshot(LiveDoc, worker.conversationId, this.#context),
        })),
    );
    const due: { worker: WorkerDocState; failure: RunFailure }[] = [];

    for (const { worker, live } of snapshots) {
      if (live?.run !== undefined || live?.runFailure === undefined) continue;
      const failure = live.runFailure;
      if (DELIBERATE_FAILURE_REASONS.has(failure.reason)) continue;
      if (worker.reportedFailure === failure.taskId) continue;
      due.push({ worker, failure });
    }
    if (due.length === 0) return;

    const router = await this.#harness.conversation(ROOT_CONVERSATION_ID, this.#context);
    if (router === undefined) return;

    for (const { worker, failure } of due) {
      const description = describeFailure(failure);
      await this.#harness.commit(async (tx) => {
        const currentBoard = await tx.doc(ProjectBoardDoc);
        if (!currentBoard.workerOrder.includes(worker.id)) return;
        const current = await tx.doc(WorkerDoc, worker.id, null);
        if (current.closedAt !== undefined || current.reportedFailure === failure.taskId) return;
        const ticketId = current.activeTicketId;
        await router.submit(tx, {
          type: "input",
          content: `Worker ${current.name} (${current.id}) run failed: ${description}`,
          whenBusy: "followUp",
          onAbort: "keep",
          requestId: `eevee.worker.failed:${failure.taskId}`,
          entry: {
            kind: NOTICE_ENTRY_KIND,
            data: {
              type: "worker_failed",
              workerId: current.id,
              workerName: current.name,
              ...(ticketId === undefined ? {} : { ticketId }),
              taskId: failure.taskId,
              reason: failure.reason,
              ...(failure.detail === undefined ? {} : { detail: failure.detail }),
            },
          },
        });
        current.reportedFailure = failure.taskId;
      }, this.#context);
    }
  }

  async #workersById(board: ProjectBoardState): Promise<Map<WorkerId, WorkerDocState>> {
    const workers = new Map<WorkerId, WorkerDocState>();
    for (const worker of await readWorkers(this.#harness, this.#context, board)) {
      workers.set(worker.id, worker);
    }
    for (const start of board.pendingStarts) {
      if (workers.has(start.workerId)) continue;
      const worker = await readWorker(this.#harness, start.workerId, this.#context);
      if (worker !== undefined) workers.set(worker.id, worker);
    }
    return workers;
  }

  async #activeRunCount(workers: ReadonlyMap<WorkerId, WorkerDocState>): Promise<number> {
    const snapshots = await Promise.all(
      [...workers.values()]
        .filter((worker) => worker.closedAt === undefined)
        .map((worker) => this.#harness.snapshot(LiveDoc, worker.conversationId, this.#context)),
    );
    let active = 0;
    for (const live of snapshots) {
      if (live?.run !== undefined) active += 1;
    }
    return active;
  }

  async #removePendingStarts(workerIds: ReadonlySet<WorkerId>): Promise<void> {
    await this.#harness.commit(async (tx) => {
      const board = await tx.doc(ProjectBoardDoc);
      const kept = board.pendingStarts.filter((start) => !workerIds.has(start.workerId));
      board.pendingStarts.splice(0, board.pendingStarts.length, ...kept);
    }, this.#context);
  }
}
