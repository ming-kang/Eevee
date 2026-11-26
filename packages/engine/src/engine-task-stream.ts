import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  clampReadBytes,
  getConversationTask,
  isTaskTerminalStatus,
  resolveTaskId,
  sliceRetainedOutput,
  TASK_READ_MAX_BYTES,
} from "@eevee/agent";
import {
  type BoardView,
  type WorkerId as CoreWorkerId,
  type OutputReadOptions,
  type OutputSlice,
  ProjectError,
  type ProjectHandle,
} from "@eevee/core";
import type {
  BackgroundTaskRecordPayload,
  BackgroundTaskStatus,
  ReadWorkerTaskResponse,
  TaskStreamChunkEvent,
  WorkerId,
} from "@eevee/protocol";
import { EngineError } from "./engine-error.ts";

export type WorkerTaskStreamCallbacks = {
  readonly onChunk: (chunk: TaskStreamChunkEvent) => void;
  readonly onStatus: (task: BackgroundTaskRecordPayload) => void;
  readonly onEnd: (
    reason: "completed" | "terminal" | "failed" | "closed",
    message?: string,
  ) => void;
};

export type WorkerTaskStream = {
  readonly snapshot: ReadWorkerTaskResponse;
  readonly terminal: boolean;
  start(callbacks: WorkerTaskStreamCallbacks): void;
  close(): void;
};

export function taskStatusPhase(status: BackgroundTaskStatus): number {
  switch (status) {
    case "queued":
      return 0;
    case "running":
      return 1;
    case "stopping":
      return 2;
    default:
      return 3;
  }
}

function needsPreRetainedRead(
  droppedBytes: number,
  totalBytes: number,
  options?: OutputReadOptions,
): boolean {
  if (droppedBytes <= 0) return false;
  if (options?.filter !== undefined && options.filter !== "") return true;
  const mode = options?.mode ?? "tail";
  const ceiling =
    options?.endByte !== undefined && Number.isFinite(options.endByte)
      ? Math.min(totalBytes, Math.max(0, Math.floor(options.endByte)))
      : totalBytes;
  if (options?.endByte !== undefined && ceiling <= droppedBytes) return true;
  const since =
    options?.sinceBytes !== undefined && Number.isFinite(options.sinceBytes)
      ? Math.max(0, Math.floor(options.sinceBytes))
      : undefined;
  const effectiveSince = since === undefined || since > ceiling ? 0 : since;
  if (mode === "head") return effectiveSince < droppedBytes;
  return Math.max(effectiveSince, ceiling - clampReadBytes(options?.bytes)) < droppedBytes;
}

export async function subscribeWorkerTaskStream(
  handle: ProjectHandle,
  workerId: WorkerId,
  taskId: string,
  options?: OutputReadOptions,
): Promise<WorkerTaskStream> {
  const workers = await handle.workers(BACKGROUND_CONTEXT);
  const worker = workers.find((candidate) => candidate.id === workerId);
  if (worker === undefined) {
    throw new ProjectError("worker_not_found", `Unknown worker ${workerId}`);
  }

  const tasks = await handle.listWorkerTasks(
    workerId as CoreWorkerId,
    undefined,
    BACKGROUND_CONTEXT,
  );
  const resolution = resolveTaskId(tasks, taskId);
  if (resolution.kind === "not_found") {
    throw new ProjectError("task_not_found", `Unknown task ${taskId} on worker ${workerId}`);
  }
  if (resolution.kind === "ambiguous") {
    throw new EngineError(
      400,
      "task_ambiguous",
      `Ambiguous task id "${taskId}" on worker ${workerId}`,
    );
  }
  const resolvedId = resolution.record.id;

  if (isTaskTerminalStatus(resolution.record.status)) {
    const snapshot = await handle.readWorkerTaskOutput(
      workerId as CoreWorkerId,
      resolvedId,
      options,
      BACKGROUND_CONTEXT,
    );
    return {
      snapshot,
      terminal: true,
      start: () => {},
      close: () => {},
    };
  }

  let closed = false;
  let started = false;
  let startRequested = false;
  let callbacks: WorkerTaskStreamCallbacks | undefined;
  const bufferedChunks: string[] = [];
  const bufferedBoards: BoardView[] = [];
  let unsubOutput: (() => void) | undefined;
  let unsubBoard: (() => void) | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubOutput?.();
    unsubOutput = undefined;
    unsubBoard?.();
    unsubBoard = undefined;
    bufferedChunks.length = 0;
    bufferedBoards.length = 0;
  };

  let handleBoard = (_board: BoardView) => {};

  let snapshot: ReadWorkerTaskResponse;
  let liveBuffer: Buffer | undefined;
  let liveTotalBytes = 0;
  let liveDroppedBytes = 0;
  let cursorByte = 0;

  const emitChunkText = (text: string) => {
    if (closed) return;
    const byteLen = Buffer.byteLength(text, "utf8");
    if (byteLen === 0) return;
    const fromByte = cursorByte;
    const endByte = fromByte + byteLen;
    cursorByte = endByte;
    callbacks?.onChunk({ text, fromByte, endByte, totalBytes: endByte });
  };

  const emitChunkSlice = (slice: OutputSlice) => {
    if (closed) return;
    if (slice.fromByte < cursorByte || slice.endByte <= cursorByte || slice.text.length === 0) {
      return;
    }
    cursorByte = slice.endByte;
    callbacks?.onChunk({
      text: slice.text,
      fromByte: slice.fromByte,
      endByte: slice.endByte,
      totalBytes: slice.totalBytes,
    });
  };

  let running: ReturnType<ProjectHandle["tasks"]["get"]>;
  try {
    unsubBoard = handle.subscribeBoard((board) => {
      if (closed) return;
      if (!started) {
        bufferedBoards.push(board);
        return;
      }
      handleBoard(board);
    });

    running = handle.tasks.get(worker.conversationId, resolvedId);
    if (running !== undefined) {
      unsubOutput = running.onOutput((chunk) => {
        if (closed) return;
        if (!started) {
          bufferedChunks.push(chunk);
          return;
        }
        emitChunkText(chunk);
      });
      const live = running.output();
      liveTotalBytes = live.totalBytes;
      liveDroppedBytes = live.droppedBytes;
      liveBuffer = Buffer.from(live.text, "utf8");

      if (needsPreRetainedRead(liveDroppedBytes, liveTotalBytes, options)) {
        const preSnapshot = await handle.readWorkerTaskOutput(
          workerId as CoreWorkerId,
          resolvedId,
          options,
          BACKGROUND_CONTEXT,
        );
        const freshTask = await getConversationTask(
          handle.harness,
          worker.conversationId,
          resolvedId,
          BACKGROUND_CONTEXT,
        );
        const task = freshTask ?? preSnapshot.task;
        if (isTaskTerminalStatus(task.status)) {
          cleanup();
          const finalSnapshot =
            task.status === preSnapshot.task.status
              ? preSnapshot
              : await handle.readWorkerTaskOutput(
                  workerId as CoreWorkerId,
                  resolvedId,
                  options,
                  BACKGROUND_CONTEXT,
                );
          return {
            snapshot: finalSnapshot,
            terminal: true,
            start: () => {},
            close: () => {},
          };
        }
        snapshot = { task, output: preSnapshot.output };
      } else {
        const initialOutput = sliceRetainedOutput(
          liveBuffer,
          liveDroppedBytes,
          liveTotalBytes,
          options,
        );
        const freshTask = await getConversationTask(
          handle.harness,
          worker.conversationId,
          resolvedId,
          BACKGROUND_CONTEXT,
        );
        const task = freshTask ?? resolution.record;
        if (isTaskTerminalStatus(task.status)) {
          cleanup();
          const finalSnapshot = await handle.readWorkerTaskOutput(
            workerId as CoreWorkerId,
            resolvedId,
            options,
            BACKGROUND_CONTEXT,
          );
          return {
            snapshot: finalSnapshot,
            terminal: true,
            start: () => {},
            close: () => {},
          };
        }
        snapshot = { task, output: initialOutput };
      }
    } else {
      snapshot = await handle.readWorkerTaskOutput(
        workerId as CoreWorkerId,
        resolvedId,
        options,
        BACKGROUND_CONTEXT,
      );
      if (isTaskTerminalStatus(snapshot.task.status)) {
        cleanup();
        return {
          snapshot,
          terminal: true,
          start: () => {},
          close: () => {},
        };
      }
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  cursorByte = snapshot.output.endByte;
  let lastTask = snapshot.task;
  let lastTaskJson = JSON.stringify(lastTask);
  let pendingBoard = Promise.resolve();

  const failStream = (error: unknown) => {
    if (closed) return;
    const message = error instanceof Error ? error.message : String(error);
    const onEnd = callbacks?.onEnd;
    cleanup();
    onEnd?.("failed", message || "Task stream failed");
  };

  const processBoard = async (board: BoardView): Promise<void> => {
    if (closed) return;
    const boardWorker = board.workers.find((candidate) => candidate.id === workerId);
    let candidate = boardWorker?.tasks.find((task) => task.id === resolvedId);
    if (candidate === undefined) {
      candidate = await getConversationTask(
        handle.harness,
        worker.conversationId,
        resolvedId,
        BACKGROUND_CONTEXT,
      );
      if (candidate === undefined || closed) return;
    }
    if (taskStatusPhase(candidate.status) < taskStatusPhase(lastTask.status)) {
      return;
    }
    const candidateJson = JSON.stringify(candidate);
    if (isTaskTerminalStatus(candidate.status)) {
      unsubOutput?.();
      unsubOutput = undefined;
      for (;;) {
        if (closed) return;
        const read = await handle.readWorkerTaskOutput(
          workerId as CoreWorkerId,
          resolvedId,
          { mode: "head", sinceBytes: cursorByte, bytes: TASK_READ_MAX_BYTES },
          BACKGROUND_CONTEXT,
        );
        const slice = read.output;
        if (slice.fromByte >= cursorByte && slice.endByte > cursorByte && slice.text.length > 0) {
          emitChunkSlice(slice);
          if (slice.endByte < slice.totalBytes) continue;
        }
        break;
      }
      if (closed) return;
      lastTask = candidate;
      lastTaskJson = candidateJson;
      callbacks?.onStatus(candidate);
      const onEnd = callbacks?.onEnd;
      cleanup();
      onEnd?.("completed");
      return;
    }
    if (candidateJson !== lastTaskJson) {
      lastTask = candidate;
      lastTaskJson = candidateJson;
      callbacks?.onStatus(candidate);
    }
  };

  handleBoard = (board: BoardView) => {
    pendingBoard = pendingBoard.then(() => processBoard(board)).catch(failStream);
  };

  const emitLiveBufferCatchUp = () => {
    if (closed || liveBuffer === undefined) return;
    while (!closed && cursorByte < liveTotalBytes) {
      const slice = sliceRetainedOutput(liveBuffer, liveDroppedBytes, liveTotalBytes, {
        mode: "head",
        sinceBytes: cursorByte,
        endByte: liveTotalBytes,
        bytes: TASK_READ_MAX_BYTES,
      });
      if (slice.fromByte < cursorByte || slice.endByte <= cursorByte || slice.text.length === 0) {
        break;
      }
      emitChunkSlice(slice);
    }
  };

  const finishStart = () => {
    if (closed) return;
    while (!closed && bufferedChunks.length > 0) {
      const queuedChunks = bufferedChunks.splice(0, bufferedChunks.length);
      for (const chunk of queuedChunks) {
        emitChunkText(chunk);
      }
    }
    if (closed) return;
    started = true;
    const queuedBoards = bufferedBoards.splice(0, bufferedBoards.length);
    for (const board of queuedBoards) {
      handleBoard(board);
    }
  };

  return {
    snapshot,
    terminal: false,
    start: (nextCallbacks) => {
      if (closed || startRequested) return;
      startRequested = true;
      callbacks = nextCallbacks;

      if (running !== undefined && cursorByte < liveDroppedBytes) {
        const runCatchUp = async () => {
          while (!closed && cursorByte < liveDroppedBytes) {
            const read = await handle.readWorkerTaskOutput(
              workerId as CoreWorkerId,
              resolvedId,
              {
                mode: "head",
                sinceBytes: cursorByte,
                endByte: liveDroppedBytes,
                bytes: TASK_READ_MAX_BYTES,
              },
              BACKGROUND_CONTEXT,
            );
            if (closed) return;
            const slice = read.output;
            if (
              slice.fromByte >= cursorByte &&
              slice.endByte > cursorByte &&
              slice.text.length > 0
            ) {
              emitChunkSlice(slice);
              if (slice.endByte < liveDroppedBytes) continue;
            }
            break;
          }
          if (closed) return;
          cursorByte = Math.max(cursorByte, liveDroppedBytes);
          emitLiveBufferCatchUp();
          finishStart();
        };
        void runCatchUp().catch(failStream);
        return;
      }

      if (running !== undefined && cursorByte < liveTotalBytes) {
        emitLiveBufferCatchUp();
      }
      finishStart();
    },
    close: cleanup,
  };
}
