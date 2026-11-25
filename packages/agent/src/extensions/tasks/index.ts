import type { Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTool,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  type Wrap,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../../shared/truncate.ts";
import {
  type BackgroundTaskRecord,
  describeTaskOutcome,
  TASKS_EXTENSION,
  TASKS_TOOL_NAME,
  TaskRecordDoc,
  TasksBoardDoc,
} from "./docs.ts";
import { TASK_READ_DEFAULT_BYTES, TASK_READ_MAX_BYTES, TASK_READ_MIN_BYTES } from "./output.ts";
import { type CommandOutcome, type RunningCommand, startCommand, TaskManager } from "./runner.ts";
import { createBackgroundShellTask } from "./task-def.ts";

export const DEFAULT_BACKGROUND_AFTER_MS = 30_000;
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

export type TasksExtensionOptions = {
  readonly manager?: TaskManager;
  readonly backgroundAfterMs?: number | (() => number);
  readonly env?: () => Record<string, string> | undefined;
};

type BashArgs = {
  readonly command: string;
  readonly timeout?: number;
  readonly background?: boolean;
};

function textResult(text: string, isError = false): ToolExecutionResult {
  return {
    output: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function timeoutMessage(timeout: number | undefined): string | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return "Invalid timeout: must be a finite number of seconds";
  }
  if (timeout > MAX_TIMEOUT_SECONDS) {
    return `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`;
  }
  return undefined;
}

type AbortRace = {
  readonly promise: Promise<"aborted">;
  dispose(): void;
};

function abortedBy(signal: AbortSignal | undefined): AbortRace | undefined {
  if (signal === undefined) return undefined;
  if (signal.aborted) return { promise: Promise.resolve("aborted"), dispose: () => {} };
  let onAbort: () => void = () => {};
  const promise = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

export function createTasksExtension(options: TasksExtensionOptions = {}) {
  const manager = options.manager ?? new TaskManager();
  const backgroundShellTask = createBackgroundShellTask(manager);

  const backgroundAfterMs = (): number | undefined => {
    const configured = options.backgroundAfterMs;
    const ms = typeof configured === "function" ? configured() : configured;
    const value = ms ?? DEFAULT_BACKGROUND_AFTER_MS;
    return value > 0 && Number.isFinite(value) ? value : undefined;
  };

  async function adopt(
    api: ToolExecutionApi,
    running: RunningCommand,
    command: string,
    context: Context,
  ): Promise<{ taskId: string; durableTaskId: number }> {
    let attachedTaskId: string | undefined;
    try {
      return await api.commit(async (tx) => {
        const board = await tx.doc(TasksBoardDoc, api.conversationId);
        const taskId = `task-${board.nextSeq}`;
        board.nextSeq += 1;
        board.order.push(taskId);
        manager.attach(api.conversationId, taskId, running);
        attachedTaskId = taskId;
        const durableTaskId = await tx.createTask(
          backgroundShellTask,
          { taskId, command },
          {
            ownership: { kind: "conversation" },
            conversationId: api.conversationId,
            background: true,
          },
        );
        const record = await tx.doc(TaskRecordDoc, api.conversationId, taskId, null);
        record.id = taskId;
        record.durableTaskId = durableTaskId;
        record.command = command;
        if (running.cwd !== undefined) record.cwd = running.cwd;
        record.status = "running";
        record.startedAt = api.now();
        const logPath = manager.logPathOf(api.conversationId, taskId);
        if (logPath !== undefined) record.logPath = logPath;
        return { taskId, durableTaskId };
      }, context);
    } catch (error) {
      if (attachedTaskId !== undefined) manager.delete(api.conversationId, attachedTaskId, false);
      running.kill(false);
      throw error;
    }
  }

  function finishedResult(
    outcome: CommandOutcome,
    timeoutSeconds: number | undefined,
    api: ToolExecutionApi,
  ): ToolExecutionResult {
    if (outcome.spillPath !== undefined) {
      api.diagnostic({
        severity: "info",
        code: "full_output",
        message: `Full output: ${outcome.spillPath}`,
      });
    }
    const retained = api.retainedOutput();
    const structuredOutput = {
      output: retained.text,
      truncated: retained.truncated,
      ...(outcome.spillPath === undefined ? {} : { fullOutputPath: outcome.spillPath }),
      ...(outcome.kind === "exit" ? { exitCode: outcome.exitCode } : {}),
    };
    if (outcome.kind === "exit") {
      if (outcome.exitCode === 0) return { structuredOutput };
      return {
        structuredOutput,
        isError: true,
        diagnostics: [
          {
            severity: "error",
            code: "exit_code",
            message: `Command exited with code ${outcome.exitCode}`,
          },
        ],
      };
    }
    const message =
      outcome.code === "timeout"
        ? `Command timed out after ${timeoutSeconds ?? "?"} seconds`
        : outcome.code === "aborted"
          ? "Command aborted"
          : outcome.message;
    return {
      structuredOutput,
      isError: true,
      diagnostics: [{ severity: "error", code: outcome.code, message }],
    };
  }

  async function executeBash(
    args: BashArgs,
    api: ToolExecutionApi,
    context: Context,
  ): Promise<ToolExecutionResult> {
    const env: ExecutionEnv | undefined = api.env;
    if (env === undefined) {
      return textResult(
        "This tool needs a workspace environment, which this conversation does not have.",
        true,
      );
    }
    const invalid = timeoutMessage(args.timeout);
    if (invalid !== undefined) return textResult(invalid, true);

    const extraEnv = options.env?.();
    const running = startCommand(env, {
      command: args.command,
      cwd: env.cwd,
      ...(extraEnv === undefined ? {} : { env: extraEnv }),
      ...(args.timeout === undefined ? {} : { timeoutSeconds: args.timeout }),
      ...(args.background === true
        ? {}
        : { spill: { afterBytes: DEFAULT_MAX_BYTES, afterLines: DEFAULT_MAX_LINES } }),
    });
    const detach = running.onOutput((chunk) => {
      try {
        api.output(chunk);
      } catch {
        // The invocation may have ended while detached output still arrives.
      }
    });
    const abortRace = abortedBy(context.abortSignal);
    try {
      if (args.background === true) {
        const adopted = await adopt(api, running, args.command, context);
        return {
          output: [
            {
              type: "text",
              text: `Started background task ${adopted.taskId}. You will be notified when it finishes; inspect its output meanwhile with tasks({ action: "read", taskId: "${adopted.taskId}" }).`,
            },
          ],
          structuredOutput: {
            output: "",
            truncated: false,
            taskId: adopted.taskId,
            status: "running",
          },
        };
      }

      const afterMs = backgroundAfterMs();
      const handoff =
        afterMs === undefined
          ? undefined
          : new Promise<"handoff">((resolve) => {
              const id = setTimeout(() => resolve("handoff"), afterMs);
              id.unref?.();
              void running.done.then(() => clearTimeout(id));
            });
      const raced = await Promise.race([
        running.done.then((outcome) => ({ kind: "done" as const, outcome })),
        ...(handoff === undefined ? [] : [handoff.then(() => ({ kind: "handoff" as const }))]),
        ...(abortRace === undefined
          ? []
          : [abortRace.promise.then(() => ({ kind: "aborted" as const }))]),
      ]);

      if (raced.kind === "done") {
        return finishedResult(raced.outcome, args.timeout, api);
      }
      if (raced.kind === "aborted") {
        running.kill(false);
        await running.done;
        return {
          isError: true,
          diagnostics: [{ severity: "error", code: "aborted", message: "Command aborted" }],
          structuredOutput: {
            output: api.retainedOutput().text,
            truncated: api.retainedOutput().truncated,
          },
        };
      }
      if (running.settled) {
        return finishedResult(await running.done, args.timeout, api);
      }
      const adopted = await adopt(api, running, args.command, context);
      const retained = api.retainedOutput();
      const notice =
        `Still running after ${afterMs}ms; moved to background task ${adopted.taskId}. ` +
        `You will be notified when it finishes; inspect output with tasks({ action: "read", taskId: "${adopted.taskId}" }).`;
      return {
        output: [
          {
            type: "text",
            text: retained.text === "" ? notice : `${retained.text}\n${notice}`,
          },
        ],
        structuredOutput: {
          output: retained.text,
          truncated: retained.truncated,
          taskId: adopted.taskId,
          status: "running",
        },
      };
    } finally {
      abortRace?.dispose();
      detach();
    }
  }

  const bashWrap: Wrap = {
    tool: "bash",
    wrap: (base: ToolRegistration): ToolRegistration => ({
      ...base,
      parameters: obj(
        {
          command: str({ description: "Bash command to execute" }),
          timeout: opt(num({ description: "Timeout in seconds (optional, no default timeout)" })),
          background: opt(
            bool({
              description:
                "Run in the background immediately and return a taskId instead of waiting for the command",
            }),
          ),
        },
        { open: true },
      ),
      structuredOutputSchema: obj(
        {
          output: str({
            description: "Combined stdout and stderr: the retained tail, as the model sees it",
          }),
          truncated: bool({ description: "Whether earlier output was dropped" }),
          fullOutputPath: opt(
            str({ description: "File with the complete output, when it was spilled" }),
          ),
          exitCode: opt(num()),
          taskId: opt(str({ description: "Background task id, when moved to background" })),
          status: opt(str()),
        },
        { open: true },
      ),
      execute: (args: unknown, api: ToolExecutionApi, context: Context) =>
        executeBash(args as BashArgs, api, context),
    }),
  };

  const tasksTool = defineTool({
    name: TASKS_TOOL_NAME,
    description: `Inspect and control background tasks started by bash. list shows every background task of this conversation; read returns a task's output (${TASK_READ_MIN_BYTES}..${TASK_READ_MAX_BYTES} bytes, default ${TASK_READ_DEFAULT_BYTES}, tail mode, with a sinceBytes cursor for incremental reads); kill stops a running task.`,
    parameters: obj(
      {
        action: oneOf(["list", "read", "kill"], {
          description: "list tasks, read a task's output, or kill a running task",
        }),
        taskId: opt(str({ description: "Task id (required for read and kill)" })),
        mode: opt(
          oneOf(["head", "tail"], {
            description: "Read from the start (head) or the end (tail, default)",
          }),
        ),
        bytes: opt(
          num({
            description: `Bytes of output to return (default ${TASK_READ_DEFAULT_BYTES}, clamped to ${TASK_READ_MIN_BYTES}..${TASK_READ_MAX_BYTES})`,
          }),
        ),
        sinceBytes: opt(
          num({
            description:
              "Incremental cursor: read output starting at this byte offset (a previous read's endByte)",
          }),
        ),
      },
      { open: true },
    ),
    structuredOutputSchema: obj(
      {
        tasks: opt(
          arr(
            obj(
              {
                id: str(),
                durableTaskId: opt(num()),
                command: str(),
                cwd: opt(str()),
                status: str(),
                exitCode: opt(num()),
                error: opt(str()),
                logPath: opt(str()),
                startedAt: num(),
                endedAt: opt(num()),
              },
              { open: true },
            ),
          ),
        ),
        taskId: opt(str()),
        status: opt(str()),
        output: opt(str()),
        fromByte: opt(num()),
        endByte: opt(num()),
        totalBytes: opt(num()),
        truncated: opt(bool()),
        sinceBytes: opt(num()),
        logPath: opt(str()),
      },
      { open: true },
    ),
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      if (args.action === "list") {
        const board = await api.snapshot(TasksBoardDoc, api.conversationId, context);
        const records: BackgroundTaskRecord[] = [];
        for (const taskId of board?.order ?? []) {
          const record = await api.snapshot(TaskRecordDoc, api.conversationId, taskId, context);
          if (record !== undefined) records.push({ ...record });
        }
        const text =
          records.length === 0
            ? "No background tasks."
            : `Background tasks (${records.length}):\n` +
              records
                .map((record) => `${record.id}\t${describeTaskOutcome(record)}\t${record.command}`)
                .join("\n");
        return {
          output: [{ type: "text", text }],
          structuredOutput: { tasks: records },
        };
      }

      const taskId = args.taskId;
      if (taskId === undefined || taskId === "") {
        return textResult(`tasks ${args.action} requires a taskId`, true);
      }
      const record = await api.snapshot(TaskRecordDoc, api.conversationId, taskId, context);
      if (record === undefined) {
        return textResult(`Unknown task ${taskId}`, true);
      }

      if (args.action === "read") {
        const slice = await manager.readOutput(api.conversationId, taskId, record, {
          ...(args.mode === undefined ? {} : { mode: args.mode }),
          ...(args.bytes === undefined ? {} : { bytes: args.bytes }),
          ...(args.sinceBytes === undefined ? {} : { sinceBytes: args.sinceBytes }),
        });
        const lines = [`task ${record.id} — ${describeTaskOutcome(record)}`];
        if (slice.totalBytes === 0) {
          lines.push("(no output recorded)");
        } else {
          lines.push(
            `bytes ${slice.fromByte}..${slice.endByte} of ${slice.totalBytes}` +
              (slice.truncated ? " (truncated)" : ""),
            slice.text === "" ? "(empty)" : slice.text,
          );
        }
        lines.push(`next sinceBytes: ${slice.endByte}`);
        return {
          output: [{ type: "text", text: lines.join("\n") }],
          structuredOutput: {
            taskId: record.id,
            status: record.status,
            output: slice.text,
            fromByte: slice.fromByte,
            endByte: slice.endByte,
            totalBytes: slice.totalBytes,
            truncated: slice.truncated,
            sinceBytes: slice.endByte,
            ...(record.logPath === undefined ? {} : { logPath: record.logPath }),
          },
        };
      }

      if (record.status !== "running") {
        return textResult(`task ${record.id} already ${describeTaskOutcome(record)}`, true);
      }
      const hadLive = manager.kill(api.conversationId, taskId);
      if (!hadLive) {
        // The process is already gone; mark the record so a still-live durable
        // task ends quietly instead of reporting an interruption.
        await api.commit(async (tx) => {
          const doc = await tx.doc(TaskRecordDoc, api.conversationId, taskId, null);
          if (doc.status === "running") {
            doc.status = "killed";
            doc.endedAt = api.now();
          }
        }, context);
      }
      let status: string = "killed";
      if (record.durableTaskId !== undefined) {
        await api.waitForTask(record.durableTaskId as TaskId, context).catch(() => undefined);
        const after = await api.snapshot(TaskRecordDoc, api.conversationId, taskId, context);
        status = after?.status ?? status;
      }
      return {
        output: [{ type: "text", text: `task ${taskId}: ${status}` }],
        structuredOutput: { taskId, status },
      };
    },
  });

  return defineExtension<ToolRegistration>({
    name: TASKS_EXTENSION,
    tools: [tasksTool],
    wraps: [bashWrap],
    tasks: [backgroundShellTask],
  });
}

export {
  type BackgroundTaskRecord,
  type BackgroundTaskStatus,
  describeTaskOutcome,
  getConversationTask,
  hasActiveTasks,
  listConversationTasks,
  TASK_NOTIFICATION_ENTRY_KIND,
  TASKS_EXTENSION,
  TASKS_TOOL_NAME,
  TaskRecordDoc,
  TasksBoardDoc,
} from "./docs.ts";
export {
  clampReadBytes,
  type OutputReadOptions,
  type OutputSlice,
  readOutputFileSlice,
  sliceOutputText,
  sliceRetainedOutput,
  TASK_READ_DEFAULT_BYTES,
  TASK_READ_MAX_BYTES,
  TASK_READ_MIN_BYTES,
  utf8Tail,
} from "./output.ts";
export {
  type CommandOutcome,
  type CommandOutput,
  createTaskManager,
  type RunningCommand,
  type StartCommandOptions,
  startCommand,
  TaskManager,
  type TaskManagerOptions,
} from "./runner.ts";
export {
  BACKGROUND_SHELL_TASK_NAME,
  type BackgroundShellInput,
  createBackgroundShellTask,
} from "./task-def.ts";
