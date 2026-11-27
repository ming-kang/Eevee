import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  clampReadBytes,
  getConversationTask,
  isTaskTerminalStatus,
  sliceRetainedOutput,
  TASK_READ_MAX_BYTES,
} from "@eevee/agent";
import type {
  BoardView,
  WorkerId as CoreWorkerId,
  OutputReadOptions,
  OutputSlice,
  ProjectHandle,
} from "@eevee/core";
import type {
  BackgroundTaskRecordPayload,
  BackgroundTaskStatus,
  ReadWorkerTaskResponse,
  TaskStreamChunkEvent,
} from "@eevee/protocol";

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

function sameTaskRecord(a: BackgroundTaskRecordPayload, b: BackgroundTaskRecordPayload): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.exitCode === b.exitCode &&
    a.error === b.error &&
    a.cancelReason === b.cancelReason &&
    a.endedAt === b.endedAt &&
    a.logPath === b.logPath &&
    a.logTruncated === b.logTruncated &&
    a.logError === b.logError &&
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.shell === b.shell &&
    a.durableTaskId === b.durableTaskId &&
    a.startedAt === b.startedAt
  );
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
  workerId: CoreWorkerId,
  taskId: string,
  options?: OutputReadOptions,
): Promise<WorkerTaskStream> {
  const { worker, record } = await handle.resolveWorkerTask(workerId, taskId, BACKGROUND_CONTEXT);
  const resolvedId = record.id;
  const readOutput = (readOpts?: OutputReadOptions) =>
    handle.readWorkerTaskOutput(workerId, resolvedId, readOpts, BACKGROUND_CONTEXT);

  if (isTaskTerminalStatus(record.status)) {
    return {
      snapshot: await readOutput(options),
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

  const resolveInitialTaskSnapshot = async (
    live:
      | {
          readonly buffer: Buffer;
          readonly droppedBytes: number;
          readonly totalBytes: number;
        }
      | undefined,
  ): Promise<{ readonly snapshot: ReadWorkerTaskResponse; readonly terminal: boolean }> => {
    if (live === undefined) {
      const diskSnapshot = await readOutput(options);
      return { snapshot: diskSnapshot, terminal: isTaskTerminalStatus(diskSnapshot.task.status) };
    }
    const preSnapshot = needsPreRetainedRead(live.droppedBytes, live.totalBytes, options)
      ? await readOutput(options)
      : undefined;
    const freshTask = await getConversationTask(
      handle.harness,
      worker.conversationId,
      resolvedId,
      BACKGROUND_CONTEXT,
    );
    const task = freshTask ?? preSnapshot?.task ?? record;
    if (isTaskTerminalStatus(task.status)) {
      const finalSnapshot =
        preSnapshot !== undefined && task.status === preSnapshot.task.status
          ? preSnapshot
          : await readOutput(options);
      return { snapshot: finalSnapshot, terminal: true };
    }
    const output =
      preSnapshot?.output ??
      sliceRetainedOutput(live.buffer, live.droppedBytes, live.totalBytes, options);
    return { snapshot: { task, output }, terminal: false };
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
    }

    const initial = await resolveInitialTaskSnapshot(
      liveBuffer === undefined
        ? undefined
        : { buffer: liveBuffer, droppedBytes: liveDroppedBytes, totalBytes: liveTotalBytes },
    );
    if (initial.terminal) {
      cleanup();
      return {
        snapshot: initial.snapshot,
        terminal: true,
        start: () => {},
        close: () => {},
      };
    }
    snapshot = initial.snapshot;
  } catch (error) {
    cleanup();
    throw error;
  }

  cursorByte = snapshot.output.endByte;
  let lastTask = snapshot.task;
  let pendingBoard = Promise.resolve();

  const failStream = (error: unknown) => {
    if (closed) return;
    const message = error instanceof Error ? error.message : String(error);
    const onEnd = callbacks?.onEnd;
    cleanup();
    onEnd?.("failed", message || "Task stream failed");
  };

  const emitDiskCatchUp = async (endByte?: number): Promise<void> => {
    while (!closed && (endByte === undefined || cursorByte < endByte)) {
      const read = await readOutput({
        mode: "head",
        sinceBytes: cursorByte,
        ...(endByte === undefined ? {} : { endByte }),
        bytes: TASK_READ_MAX_BYTES,
      });
      if (closed) return;
      const slice = read.output;
      if (slice.fromByte >= cursorByte && slice.endByte > cursorByte && slice.text.length > 0) {
        emitChunkSlice(slice);
        if (slice.endByte < (endByte ?? slice.totalBytes)) continue;
      }
      break;
    }
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
    if (isTaskTerminalStatus(candidate.status)) {
      unsubOutput?.();
      unsubOutput = undefined;
      await emitDiskCatchUp();
      if (closed) return;
      lastTask = candidate;
      callbacks?.onStatus(candidate);
      const onEnd = callbacks?.onEnd;
      cleanup();
      onEnd?.("completed");
      return;
    }
    if (!sameTaskRecord(candidate, lastTask)) {
      lastTask = candidate;
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
      for (const chunk of bufferedChunks.splice(0, bufferedChunks.length)) {
        emitChunkText(chunk);
      }
    }
    if (closed) return;
    started = true;
    for (const board of bufferedBoards.splice(0, bufferedBoards.length)) {
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
        void emitDiskCatchUp(liveDroppedBytes)
          .then(() => {
            if (closed) return;
            cursorByte = Math.max(cursorByte, liveDroppedBytes);
            emitLiveBufferCatchUp();
            finishStart();
          })
          .catch(failStream);
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
