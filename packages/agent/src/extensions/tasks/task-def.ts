import { defineTask, type Task } from "@earendil-works/pi-durable";
import { TASK_NOTIFICATION_ENTRY_KIND, TaskRecordDoc } from "./docs.ts";
import { utf8Tail } from "./output.ts";
import type { CommandOutcome, TaskManager } from "./runner.ts";

export const BACKGROUND_SHELL_TASK_NAME = "eevee.background-shell";

export type BackgroundShellInput = {
  readonly taskId: string;
  readonly command: string;
};

export type BackgroundShellCheckpoint = {
  readonly phase: "run";
};

const NOTIFICATION_TAIL_BYTES = 2048;
const TERMINAL_COMPLETED = {
  status: "terminal",
  outcome: { status: "completed", result: null },
} as const;

function signalAborted(signal: AbortSignal): Promise<void> {
  return signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function outcomeDescription(outcome: CommandOutcome): string {
  return outcome.kind === "exit"
    ? `exited with code ${outcome.exitCode}`
    : outcome.code === "timeout"
      ? "timed out"
      : `failed: ${outcome.message}`;
}

function completionMessage(
  taskId: string,
  command: string,
  outcome: CommandOutcome,
  tail: string,
): string {
  const lines = [
    `Background task ${taskId} ${outcomeDescription(outcome)}.`,
    `Command: ${command}`,
  ];
  if (tail !== "") {
    lines.push("", "Output (tail):", tail);
  }
  lines.push("", `Read the full output with tasks({ action: "read", taskId: "${taskId}" }).`);
  return lines.join("\n");
}

function interruptedMessage(taskId: string, command: string): string {
  return [
    `Background task ${taskId} was interrupted when the host restarted; the process is no longer running.`,
    `Command: ${command}`,
    `Any output it produced is still available via tasks({ action: "read", taskId: "${taskId}" }). Rerun the command if it is still needed.`,
  ].join("\n");
}

function logFooter(outcome: CommandOutcome, killed: boolean): string {
  if (killed) return "\n[killed]\n";
  return outcome.kind === "exit"
    ? `\n[exited with code ${outcome.exitCode}]\n`
    : `\n[error: ${outcome.message}]\n`;
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
          if (record?.status !== "running") {
            await runtime.commit(() => TERMINAL_COMPLETED, context);
            return;
          }
          const conv = await runtime.conversation(conversationId, context);
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(TaskRecordDoc, conversationId, taskId, null);
            if (doc.status === "running") {
              if (conv !== undefined) {
                await conv.submit(tx, {
                  type: "input",
                  content: interruptedMessage(taskId, command),
                  whenBusy: "followUp",
                  onAbort: "keep",
                  requestId: `eevee.task.done:${taskId}`,
                  entry: {
                    kind: TASK_NOTIFICATION_ENTRY_KIND,
                    data: { taskId, status: "interrupted", command },
                  },
                });
              }
              doc.status = "interrupted";
              doc.error = "Interrupted by host restart";
              doc.endedAt = runtime.now();
            }
            return TERMINAL_COMPLETED;
          }, context);
          return;
        }

        await manager.openLog(conversationId, taskId, running);

        const raced = await Promise.race([
          running.done.then((outcome) => ({ kind: "done" as const, outcome })),
          signalAborted(runtime.signal).then(() => ({ kind: "signal" as const })),
        ]);

        if (raced.kind === "signal") {
          // A close leaves the task pending to recover as "interrupted" on reopen;
          // an abort mark runs the abort handler next.
          running.kill(false);
          await running.done;
          manager.delete(conversationId, taskId);
          await manager.finishLog(conversationId, taskId);
          return;
        }

        const outcome = raced.outcome;
        const tail = utf8Tail(running.output().text, NOTIFICATION_TAIL_BYTES).text;
        const killed = running.killed;
        manager.delete(conversationId, taskId);
        await manager.finishLog(conversationId, taskId, logFooter(outcome, killed));

        if (killed) {
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(TaskRecordDoc, conversationId, taskId, null);
            if (doc.status === "running") {
              doc.status = "killed";
              doc.endedAt = runtime.now();
            }
            return TERMINAL_COMPLETED;
          }, context);
          return;
        }

        const conv = await runtime.conversation(conversationId, context);
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(TaskRecordDoc, conversationId, taskId, null);
          if (doc.status === "running") {
            if (conv !== undefined) {
              await conv.submit(tx, {
                type: "input",
                content: completionMessage(taskId, command, outcome, tail),
                whenBusy: "followUp",
                onAbort: "keep",
                requestId: `eevee.task.done:${taskId}`,
                entry: {
                  kind: TASK_NOTIFICATION_ENTRY_KIND,
                  data: {
                    taskId,
                    status: "exited",
                    command,
                    ...(outcome.kind === "exit" ? { exitCode: outcome.exitCode } : {}),
                    ...(outcome.kind === "error" ? { error: outcome.message } : {}),
                  },
                },
              });
            }
            doc.status = "exited";
            if (outcome.kind === "exit") doc.exitCode = outcome.exitCode;
            if (outcome.kind === "error") doc.error = outcome.message;
            doc.endedAt = runtime.now();
          }
          return TERMINAL_COMPLETED;
        }, context);
      },
    },
    abort: async (task, runtime, context) => {
      const { taskId } = task.input;
      const conversationId = runtime.conversationId;
      const running = manager.get(conversationId, taskId);
      if (running !== undefined) {
        running.kill(true);
        await running.done;
        manager.delete(conversationId, taskId);
      }
      await manager.finishLog(conversationId, taskId, "\n[killed]\n");
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(TaskRecordDoc, conversationId, taskId, null);
        if (doc.status === "running") {
          doc.status = "killed";
          doc.endedAt = runtime.now();
        }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });
}
