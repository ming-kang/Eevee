import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationHandle,
  type ConversationId,
  defineTask,
  type JsonObject,
  type Task,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  type BackgroundTaskRecord,
  describeTaskOutcome,
  isTaskActiveStatus,
  isTaskTerminalStatus,
  TASK_NOTIFICATION_ENTRY_KIND,
  TaskRecordDoc,
  TasksBoardDoc,
} from "./docs.ts";
import { utf8Tail } from "./output.ts";
import type { CommandOutcome, TaskKillReason, TaskManager, TaskShell } from "./runner.ts";

export const BACKGROUND_SHELL_TASK_NAME = "eevee.background-shell";

export type BackgroundShellInput = {
  readonly taskId: string;
  readonly command: string;
  readonly shell?: TaskShell;
};

export type EvictedTask = {
  readonly id: string;
  readonly logPath?: string;
};

export type BackgroundShellCheckpoint =
  | { readonly phase: "run" }
  | { readonly phase: "evict"; readonly evicted: readonly EvictedTask[] };

const NOTIFICATION_TAIL_BYTES = 8192;
const TERMINAL_COMPLETED = {
  status: "terminal",
  outcome: { status: "completed", result: null },
} as const;
const TERMINAL_ABORTED = {
  status: "terminal",
  outcome: { status: "aborted" },
} as const;

type TerminalState = typeof TERMINAL_COMPLETED | typeof TERMINAL_ABORTED;

type TerminalNotification = {
  readonly tail: string;
  readonly data: JsonObject;
};

function signalAborted(signal: AbortSignal): Promise<void> {
  return signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function buildCompletionNotice(record: BackgroundTaskRecord, tail: string): string {
  const headline =
    record.status === "cancelled" && record.cancelReason === "user"
      ? `Background task ${record.id} was cancelled by the user.`
      : record.status === "interrupted"
        ? `Background task ${record.id} was interrupted when the host restarted; the process is no longer running.`
        : `Background task ${record.id} ${describeTaskOutcome(record)}.`;

  const lines = [headline, `Command: ${record.command}`];
  if (record.logPath !== undefined) {
    lines.push(`Log: ${record.logPath}`);
  }
  if (record.logTruncated === true) {
    lines.push("Warning: output exceeded the background log size limit and was truncated.");
  }
  if (record.logError !== undefined) {
    lines.push(`Warning: log write failed (${record.logError}).`);
  }
  if (tail !== "") {
    lines.push("", "Output (tail):", tail);
  }
  lines.push("", `Read output with tasks({ action: "read", taskId: "${record.id}" }).`);
  return lines.join("\n");
}

function logFooter(outcome: CommandOutcome, killed: boolean, killReason?: TaskKillReason): string {
  if (killed) {
    return killReason === "user" ? "\n[cancelled by user]\n" : "\n[cancelled]\n";
  }
  return outcome.kind === "exit"
    ? `\n[exited with code ${outcome.exitCode}]\n`
    : `\n[error: ${outcome.message}]\n`;
}

async function evictFinishedTasks(
  tx: Tx,
  conversationId: ConversationId,
  maxFinished: number,
): Promise<EvictedTask[]> {
  const board = await tx.doc(TasksBoardDoc, conversationId);
  const terminal: EvictedTask[] = [];
  for (const id of board.order) {
    const rec = await tx.doc(TaskRecordDoc, conversationId, id, null);
    if (isTaskTerminalStatus(rec.status)) {
      terminal.push({ id, ...(rec.logPath === undefined ? {} : { logPath: rec.logPath }) });
    }
  }
  const excess = terminal.length - maxFinished;
  if (excess <= 0) return [];
  const toEvict = terminal.slice(0, excess);
  const evictIds = new Set(toEvict.map((entry) => entry.id));
  const kept = board.order.filter((id) => !evictIds.has(id));
  board.order.splice(0, board.order.length, ...kept);
  return toEvict;
}

async function commitTerminalState(
  runtime: TaskRuntime<BackgroundShellInput, BackgroundShellCheckpoint, null, object>,
  context: Context,
  manager: TaskManager,
  options: {
    readonly taskId: string;
    readonly terminalState: TerminalState;
    readonly evictInPhase?: boolean;
    readonly conv?: ConversationHandle;
    readonly updateDoc: (doc: BackgroundTaskRecord) => TerminalNotification | undefined;
  },
): Promise<void> {
  const { taskId, terminalState, evictInPhase = true, conv, updateDoc } = options;
  const conversationId = runtime.conversationId;
  let evicted: EvictedTask[] = [];
  await runtime.commit(async (tx) => {
    const doc = await tx.doc(TaskRecordDoc, conversationId, taskId, null);
    if (isTaskActiveStatus(doc.status)) {
      const notice = updateDoc(doc);
      if (notice !== undefined && conv !== undefined) {
        await conv.admit(tx, {
          type: "input",
          content: buildCompletionNotice({ ...doc }, notice.tail),
          whenBusy: "steer",
          onAbort: "keep",
          requestId: `eevee.task.done:${taskId}`,
          entry: {
            kind: TASK_NOTIFICATION_ENTRY_KIND,
            data: notice.data,
          },
        });
      }
    }
    evicted = await evictFinishedTasks(tx, conversationId, manager.maxFinishedPerConversation);
    if (evicted.length === 0) return terminalState;
    return evictInPhase
      ? ({ status: "running", checkpoint: { phase: "evict", evicted } } as const)
      : undefined;
  }, context);

  if (!evictInPhase && evicted.length > 0) {
    for (const item of evicted) {
      await manager.evict(conversationId, item.id, item.logPath);
    }
    await runtime.commit(() => terminalState, context);
  }
}

export type BackgroundShellTask = Task<
  BackgroundShellInput,
  BackgroundShellCheckpoint,
  null,
  object
>;

export function createBackgroundShellTask(manager: TaskManager): BackgroundShellTask {
  return defineTask<BackgroundShellInput, BackgroundShellCheckpoint, null>({
    name: BACKGROUND_SHELL_TASK_NAME,
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const { taskId, command } = task.input;
        const conversationId = runtime.conversationId;
        const running = manager.get(conversationId, taskId);

        if (running === undefined) {
          const record = await runtime.snapshot(TaskRecordDoc, conversationId, taskId, context);
          if (record === undefined || !isTaskActiveStatus(record.status)) {
            await runtime.commit(() => TERMINAL_COMPLETED, context);
            return;
          }
          const conv = await runtime.conversation(conversationId, context);
          await commitTerminalState(runtime, context, manager, {
            taskId,
            terminalState: TERMINAL_COMPLETED,
            ...(conv === undefined ? {} : { conv }),
            updateDoc: (doc) => {
              doc.status = "interrupted";
              doc.error = "Interrupted by host restart";
              doc.endedAt = runtime.now();
              return {
                tail: "",
                data: { taskId, status: "interrupted", command },
              };
            },
          });
          return;
        }

        await manager.openLog(conversationId, taskId, running);

        const raced = await Promise.race([
          running.done.then((outcome) => ({ kind: "done" as const, outcome })),
          signalAborted(runtime.signal).then(() => ({ kind: "signal" as const })),
        ]);

        if (raced.kind === "signal") {
          // A close leaves the task active to recover as "interrupted" on reopen;
          // an abort mark runs the abort handler next.
          running.detachCancel();
          await running.done;
          manager.delete(conversationId, taskId);
          await manager.finishLog(conversationId, taskId);
          return;
        }

        const outcome = raced.outcome;
        const tail = utf8Tail(running.output().text, NOTIFICATION_TAIL_BYTES).text;
        const killed = running.killed;
        const killReason = running.killReason;
        const preLogStatus = manager.logStatus(conversationId, taskId);
        manager.delete(conversationId, taskId);
        const footer = preLogStatus.overflowFailed
          ? `\n[error: ${preLogStatus.logError ?? "Output exceeded background log size limit"}]\n`
          : preLogStatus.logTruncated
            ? undefined
            : logFooter(outcome, killed, killReason);
        await manager.finishLog(conversationId, taskId, footer);
        const logStatus = manager.logStatus(conversationId, taskId);

        let nextStatus: BackgroundTaskRecord["status"];
        let exitCode: number | undefined;
        let error: string | undefined;
        let cancelReason: BackgroundTaskRecord["cancelReason"];
        let shouldNotify: boolean;

        if (logStatus.overflowFailed) {
          nextStatus = "failed";
          error = logStatus.logError ?? "Output exceeded background log size limit";
          shouldNotify = true;
        } else if (killed) {
          nextStatus = "cancelled";
          cancelReason = killReason ?? "tool";
          shouldNotify = cancelReason === "user";
        } else if (outcome.kind === "exit") {
          exitCode = outcome.exitCode;
          nextStatus = outcome.exitCode === 0 ? "completed" : "failed";
          shouldNotify = true;
        } else {
          nextStatus = outcome.code === "timeout" ? "timed_out" : "failed";
          error = outcome.message;
          shouldNotify = true;
        }

        const conv = shouldNotify ? await runtime.conversation(conversationId, context) : undefined;
        await commitTerminalState(runtime, context, manager, {
          taskId,
          terminalState: TERMINAL_COMPLETED,
          ...(conv === undefined ? {} : { conv }),
          updateDoc: (doc) => {
            doc.status = nextStatus;
            doc.endedAt = runtime.now();
            if (exitCode !== undefined) doc.exitCode = exitCode;
            if (error !== undefined) doc.error = error;
            if (cancelReason !== undefined) doc.cancelReason = cancelReason;
            if (logStatus.logTruncated) doc.logTruncated = true;
            if (logStatus.logError !== undefined) doc.logError = logStatus.logError;

            if (!shouldNotify) return undefined;
            return {
              tail,
              data: {
                taskId,
                status: nextStatus,
                command,
                ...(exitCode === undefined ? {} : { exitCode }),
                ...(error === undefined ? {} : { error }),
                ...(cancelReason === undefined ? {} : { cancelReason }),
              },
            };
          },
        });
      },
      evict: async (task, runtime, context) => {
        const conversationId = runtime.conversationId;
        for (const item of task.state.checkpoint.evicted) {
          await manager.evict(conversationId, item.id, item.logPath);
        }
        await runtime.commit(() => TERMINAL_COMPLETED, context);
      },
    },
    abort: async (task, runtime, context) => {
      const { taskId } = task.input;
      const conversationId = runtime.conversationId;
      if (task.state.checkpoint.phase === "evict") {
        for (const item of task.state.checkpoint.evicted) {
          await manager.evict(conversationId, item.id, item.logPath);
        }
        await runtime.commit(() => TERMINAL_ABORTED, context);
        return;
      }
      const running = manager.get(conversationId, taskId);
      let killReason: TaskKillReason = "abort";
      if (running !== undefined) {
        killReason = running.killReason ?? "abort";
        running.kill(killReason);
        await running.done;
        manager.delete(conversationId, taskId);
      }
      await manager.finishLog(conversationId, taskId, "\n[cancelled]\n");
      const logStatus = manager.logStatus(conversationId, taskId);
      await commitTerminalState(runtime, context, manager, {
        taskId,
        terminalState: TERMINAL_ABORTED,
        evictInPhase: false,
        updateDoc: (doc) => {
          doc.status = "cancelled";
          doc.cancelReason = doc.cancelReason ?? killReason;
          doc.endedAt = runtime.now();
          if (logStatus.logTruncated) doc.logTruncated = true;
          if (logStatus.logError !== undefined) doc.logError = logStatus.logError;
          return undefined;
        },
      });
    },
  });
}
