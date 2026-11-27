import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type {
  Conversation,
  DocumentReader,
  Harness,
  Submission,
  SubmissionDraft,
  TaskId,
} from "@earendil-works/pi-durable";
import {
  type BackgroundTaskRecord,
  getConversationTask,
  isTaskActiveStatus,
  isTaskTerminalStatus,
  listConversationTasks,
  type OutputReadOptions,
  type OutputSlice,
  resolveTaskId,
  type TaskManager,
  TaskRecordDoc,
} from "@eevee/agent";
import {
  ProjectBoardDoc,
  readBoard,
  readWorker,
  readWorkers,
  WorkerDoc,
  type WorkerDocState,
  type WorkerId,
  type WorkerRecord,
} from "./docs.ts";
import { ProjectError } from "./errors.ts";
import { resolveWorkerStatus } from "./status.ts";

export type ProjectTarget = "router" | WorkerId;

export type ListWorkerTasksOptions = {
  readonly status?: "all" | "active" | "finished";
  readonly limit?: number;
};

export type ResolvedWorkerTask = {
  readonly worker: WorkerDocState;
  readonly record: BackgroundTaskRecord;
};

export async function resolveTargetConversation(
  harness: Harness,
  root: Conversation,
  target: ProjectTarget,
  context: Context,
): Promise<Conversation> {
  if (target === "router") return root;
  const worker = await readWorker(harness, target, context);
  if (worker === undefined) {
    throw new ProjectError("worker_not_found", `Unknown worker ${target}`);
  }
  const conversation = await harness.conversation(worker.conversationId, context);
  if (conversation === undefined) {
    throw new ProjectError("worker_not_found", `Worker ${target} has no conversation`);
  }
  return conversation;
}

export async function commitWorkerSubmission(
  harness: Harness,
  workerId: WorkerId,
  context: Context,
  buildSubmission: (input: { readonly queued: boolean }) => SubmissionDraft,
): Promise<Submission> {
  const worker = await readWorker(harness, workerId, context);
  if (worker === undefined) {
    throw new ProjectError("worker_not_found", `Unknown worker ${workerId}`);
  }
  if (worker.closedAt !== undefined) {
    throw new ProjectError("worker_closed", `Worker ${workerId} is closed`);
  }
  const conversation = await harness.conversation(worker.conversationId, context);
  if (conversation === undefined) {
    throw new ProjectError("worker_not_found", `Worker ${workerId} has no conversation`);
  }
  const submissionId = await harness.commit(async (tx) => {
    const current = await tx.doc(WorkerDoc, workerId, null);
    if (current.conversationId !== worker.conversationId) {
      throw new ProjectError("worker_not_found", `Unknown worker ${workerId}`);
    }
    if (current.closedAt !== undefined) {
      throw new ProjectError("worker_closed", `Worker ${workerId} is closed`);
    }
    const board = await tx.doc(ProjectBoardDoc);
    const queued = board.pendingStarts.some((start) => start.workerId === workerId);
    return conversation.submit(tx, buildSubmission({ queued }));
  }, context);
  const submission = await harness.submission(submissionId, context);
  if (submission === undefined) throw new Error(`Submission ${submissionId} does not exist`);
  return submission;
}

export async function resolveWorkerTask(
  reader: DocumentReader,
  workerId: WorkerId,
  taskId: string,
  context: Context = BACKGROUND_CONTEXT,
): Promise<ResolvedWorkerTask> {
  const worker = await readWorker(reader, workerId, context);
  if (worker === undefined) {
    throw new ProjectError("worker_not_found", `Unknown worker ${workerId}`);
  }
  const tasks = await listConversationTasks(reader, worker.conversationId, context);
  const resolution = resolveTaskId(tasks, taskId);
  if (resolution.kind === "not_found") {
    throw new ProjectError("task_not_found", `Unknown task ${taskId} on worker ${workerId}`);
  }
  if (resolution.kind === "ambiguous") {
    throw new ProjectError(
      "task_ambiguous",
      `Ambiguous task id "${taskId}" on worker ${workerId}; matches: ${resolution.matches.map((m) => m.id).join(", ")}.`,
    );
  }
  return { worker, record: resolution.record };
}

export async function listWorkerTasks(
  reader: DocumentReader,
  workerId: WorkerId,
  options?: ListWorkerTasksOptions,
  context: Context = BACKGROUND_CONTEXT,
): Promise<readonly BackgroundTaskRecord[]> {
  const worker = await readWorker(reader, workerId, context);
  if (worker === undefined) {
    throw new ProjectError("worker_not_found", `Unknown worker ${workerId}`);
  }
  const tasks = await listConversationTasks(reader, worker.conversationId, context);
  const status = options?.status ?? "all";
  const limit =
    options?.limit === undefined || !Number.isFinite(options.limit) || options.limit < 0
      ? undefined
      : Math.min(100, Math.floor(options.limit));
  const active = tasks.filter((task) => isTaskActiveStatus(task.status));
  const finished = tasks.filter((task) => isTaskTerminalStatus(task.status));
  if (status === "active") {
    return limit === undefined ? active : limit === 0 ? [] : active.slice(-limit);
  }
  const boundedFinished =
    limit === undefined ? finished : limit === 0 ? [] : finished.slice(-limit);
  return status === "finished" ? boundedFinished : [...active, ...boundedFinished];
}

export async function readWorkerTaskOutput(
  reader: DocumentReader,
  taskManager: TaskManager,
  workerId: WorkerId,
  taskId: string,
  options?: OutputReadOptions,
  context: Context = BACKGROUND_CONTEXT,
): Promise<{ readonly task: BackgroundTaskRecord; readonly output: OutputSlice }> {
  const { worker, record } = await resolveWorkerTask(reader, workerId, taskId, context);
  return {
    task: record,
    output: await taskManager.readOutput(worker.conversationId, record.id, record, options),
  };
}

export async function subscribeWorkerTaskOutput(
  reader: DocumentReader,
  taskManager: TaskManager,
  workerId: WorkerId,
  taskId: string,
  listener: (chunk: string) => void,
  context: Context = BACKGROUND_CONTEXT,
): Promise<(() => void) | undefined> {
  const { worker, record } = await resolveWorkerTask(reader, workerId, taskId, context);
  return taskManager.subscribeOutput(worker.conversationId, record.id, listener);
}

export async function killWorkerTask(
  harness: Harness,
  taskManager: TaskManager,
  workerId: WorkerId,
  taskId: string,
  context: Context = BACKGROUND_CONTEXT,
): Promise<BackgroundTaskRecord> {
  const { worker, record } = await resolveWorkerTask(harness, workerId, taskId, context);
  if (!isTaskActiveStatus(record.status)) {
    throw new ProjectError(
      "task_not_running",
      `Task ${record.id} on worker ${workerId} is not running (${record.status})`,
    );
  }

  await harness.commit(async (tx) => {
    const doc = await tx.doc(TaskRecordDoc, worker.conversationId, record.id, null);
    if (doc.status === "queued" || doc.status === "running") {
      doc.status = "stopping";
    }
  }, context);

  const hadLive = taskManager.kill(worker.conversationId, record.id, "user");
  if (hadLive) {
    if (record.durableTaskId !== undefined) {
      await harness.waitForTask(record.durableTaskId as TaskId, context);
    }
  } else if (record.durableTaskId !== undefined) {
    await harness.abortTask(record.durableTaskId as TaskId, context);
    await harness.waitForTask(record.durableTaskId as TaskId, context);
  } else {
    await harness.commit(async (tx) => {
      const doc = await tx.doc(TaskRecordDoc, worker.conversationId, record.id, null);
      if (isTaskActiveStatus(doc.status)) {
        doc.status = "cancelled";
        doc.cancelReason = "user";
        doc.endedAt = Date.now();
      }
    }, context);
  }

  const updated = await getConversationTask(harness, worker.conversationId, record.id, context);
  if (updated === undefined) {
    throw new Error(`Task ${record.id} on worker ${workerId} disappeared after kill`);
  }
  return updated;
}

export async function listProjectWorkers(
  harness: Harness,
  context: Context = BACKGROUND_CONTEXT,
): Promise<WorkerRecord[]> {
  const board = await readBoard(harness, context);
  const workers = await readWorkers(harness, context, board);
  const pendingWorkerIds = board?.pendingStarts.map((start) => start.workerId) ?? [];
  return Promise.all(
    workers.map(async (worker) => ({
      ...worker,
      status: await resolveWorkerStatus(harness, worker, pendingWorkerIds, context),
    })),
  );
}
