import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationDocFamilyToken,
  type ConversationId,
  defineTool,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type Tx,
} from "@earendil-works/pi-durable";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { withToolPromptMeta } from "../../context/tool-meta.ts";
import { errorMessage } from "../../shared/guards.ts";
import { formatSize } from "../../shared/truncate.ts";
import {
  type BackgroundTaskRecord,
  type BackgroundTaskStatus,
  describeTaskOutcome,
  isTaskActiveStatus,
  isTaskTerminalStatus,
  listConversationTasks,
  resolveTaskId,
  TASKS_TOOL_NAME,
  TaskRecordDoc,
} from "./docs.ts";
import {
  MAX_FILTER_SCAN_BYTES,
  TASK_FILTER_MAX_CONTEXT_LINES,
  TASK_READ_DEFAULT_BYTES,
  TASK_READ_MAX_BYTES,
  TASK_READ_MIN_BYTES,
} from "./output.ts";
import type { TaskKillReason, TaskManager } from "./runner.ts";

const DEFAULT_LIST_FINISHED_LIMIT = 5;
const MAX_LIST_FINISHED_LIMIT = 100;

type TasksToolArgs = {
  readonly action: "list" | "read" | "kill";
  readonly taskId?: string;
  readonly status?: "all" | "active" | "finished";
  readonly limit?: number;
  readonly mode?: "head" | "tail";
  readonly bytes?: number;
  readonly sinceBytes?: number;
  readonly endByte?: number;
  readonly filter?: string;
  readonly contextLines?: number;
};

export type KillConversationTaskOperations = {
  readonly commit: <T>(change: (tx: Tx) => T | Promise<T>, context: Context) => Promise<T>;
  readonly snapshot: (
    token: ConversationDocFamilyToken<BackgroundTaskRecord, null>,
    conversationId: ConversationId,
    key: string,
    context: Context,
  ) => Promise<Readonly<BackgroundTaskRecord> | undefined>;
  readonly waitForTask: (id: TaskId, context: Context) => Promise<unknown>;
  readonly abortTask?: (id: TaskId, context: Context) => Promise<unknown>;
  readonly now: () => number;
};

export type KillConversationTaskResult = {
  readonly status: BackgroundTaskStatus;
  readonly record: BackgroundTaskRecord | undefined;
};

export function textResult(text: string, isError = false): ToolExecutionResult {
  return {
    output: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function formatTaskSummaryLine(record: BackgroundTaskRecord): string {
  return `- ${record.id} [${describeTaskOutcome(record)}]: ${record.command}`;
}

function clampFinishedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 0) {
    return DEFAULT_LIST_FINISHED_LIMIT;
  }
  return Math.min(MAX_LIST_FINISHED_LIMIT, Math.floor(limit));
}

function listTasksResult(
  records: readonly BackgroundTaskRecord[],
  statusFilter: "all" | "active" | "finished",
  rawLimit: number | undefined,
): ToolExecutionResult {
  const finishedLimit = clampFinishedLimit(rawLimit);
  const active = records.filter((record) => isTaskActiveStatus(record.status));
  const finished = records.filter((record) => isTaskTerminalStatus(record.status));
  const shownFinished = finishedLimit === 0 ? [] : finished.slice(-finishedLimit);
  const shown =
    statusFilter === "active"
      ? active
      : statusFilter === "finished"
        ? shownFinished
        : [...active, ...shownFinished];
  const omittedFinished = statusFilter === "active" ? 0 : finished.length - shownFinished.length;

  let text: string;
  if (shown.length === 0) {
    text =
      statusFilter === "active" && finished.length > 0
        ? `No active background tasks (${finished.length} finished).`
        : "No background tasks.";
  } else {
    const summary =
      omittedFinished > 0
        ? ` (${shown.length} shown; ${omittedFinished} older finished omitted)`
        : ` (${shown.length})`;
    text =
      `Background tasks${summary}:\n` +
      shown
        .map((record) => `${record.id}\t${describeTaskOutcome(record)}\t${record.command}`)
        .join("\n");
  }
  return {
    output: [{ type: "text", text }],
    structuredOutput: {
      tasks: shown,
      ...(omittedFinished > 0 ? { omittedFinished } : {}),
    },
  };
}

function resolveTargetTask(
  records: readonly BackgroundTaskRecord[],
  action: "read" | "kill",
  rawTaskId: string | undefined,
): BackgroundTaskRecord | ToolExecutionResult {
  if (rawTaskId === undefined || rawTaskId.trim() === "") {
    return textResult(`tasks ${action} requires a taskId`, true);
  }
  const resolution = resolveTaskId(records, rawTaskId);
  if (resolution.kind === "not_found") {
    const hint =
      records.length === 0
        ? " (no background tasks in this conversation)"
        : `. Available tasks:\n${records.slice(-5).map(formatTaskSummaryLine).join("\n")}`;
    return textResult(`Unknown task ${rawTaskId}${hint}`, true);
  }
  if (resolution.kind === "ambiguous") {
    return textResult(
      `Ambiguous task id "${rawTaskId}"; matches: ${resolution.matches.map((m) => m.id).join(", ")}`,
      true,
    );
  }
  return resolution.record;
}

async function readTaskResult(
  manager: TaskManager,
  conversationId: ConversationId,
  record: BackgroundTaskRecord,
  args: TasksToolArgs,
): Promise<ToolExecutionResult> {
  let slice: Awaited<ReturnType<TaskManager["readOutput"]>>;
  try {
    slice = await manager.readOutput(conversationId, record.id, record, {
      ...(args.mode === undefined ? {} : { mode: args.mode }),
      ...(args.bytes === undefined ? {} : { bytes: args.bytes }),
      ...(args.sinceBytes === undefined ? {} : { sinceBytes: args.sinceBytes }),
      ...(args.endByte === undefined ? {} : { endByte: args.endByte }),
      ...(args.filter === undefined ? {} : { filter: args.filter }),
      ...(args.contextLines === undefined ? {} : { contextLines: args.contextLines }),
    });
  } catch (error) {
    return textResult(errorMessage(error), true);
  }

  const lines = [`task ${record.id} — ${describeTaskOutcome(record)}`];
  if (record.logError !== undefined) lines.push(`Log warning: ${record.logError}`);
  if (record.logTruncated === true) {
    lines.push("Note: full output log was truncated at the size limit.");
  }
  if (args.filter !== undefined && args.filter !== "") {
    lines.push(
      `matched ${slice.matchedLines ?? 0} of ${slice.totalMatchedLines ?? 0} lines in bytes ${slice.fromByte}..${slice.endByte} of ${slice.totalBytes}` +
        (slice.scanTruncated ? ` (scan capped at ${formatSize(MAX_FILTER_SCAN_BYTES)})` : ""),
      slice.text === "" ? "(no matching lines)" : slice.text,
    );
  } else if (slice.totalBytes === 0) {
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
      ...(slice.matchedLines === undefined ? {} : { matchedLines: slice.matchedLines }),
      ...(slice.totalMatchedLines === undefined
        ? {}
        : { totalMatchedLines: slice.totalMatchedLines }),
      ...(slice.scanTruncated === undefined ? {} : { scanTruncated: slice.scanTruncated }),
      ...(record.logPath === undefined ? {} : { logPath: record.logPath }),
    },
  };
}

export async function killConversationTask(
  manager: TaskManager,
  conversationId: ConversationId,
  record: BackgroundTaskRecord,
  reason: TaskKillReason,
  ops: KillConversationTaskOperations,
  context: Context,
): Promise<KillConversationTaskResult> {
  const taskId = record.id;
  await ops.commit(async (tx) => {
    const doc = await tx.doc(TaskRecordDoc, conversationId, taskId, null);
    if (doc.status === "queued" || doc.status === "running") {
      doc.status = "stopping";
    }
  }, context);

  const hadLive = manager.kill(conversationId, taskId, reason);
  if (hadLive) {
    if (record.durableTaskId !== undefined) {
      await ops.waitForTask(record.durableTaskId as TaskId, context);
    }
  } else if (ops.abortTask !== undefined && record.durableTaskId !== undefined) {
    await ops.abortTask(record.durableTaskId as TaskId, context);
    await ops.waitForTask(record.durableTaskId as TaskId, context);
  } else {
    // The process is already gone; mark the record so a still-live durable
    // task ends quietly instead of reporting an interruption.
    await ops.commit(async (tx) => {
      const doc = await tx.doc(TaskRecordDoc, conversationId, taskId, null);
      if (isTaskActiveStatus(doc.status)) {
        doc.status = "cancelled";
        doc.cancelReason = reason;
        doc.endedAt = ops.now();
      }
    }, context);
    if (record.durableTaskId !== undefined) {
      await ops.waitForTask(record.durableTaskId as TaskId, context);
    }
  }

  const after = await ops.snapshot(TaskRecordDoc, conversationId, taskId, context);
  const finalRecord = after === undefined ? undefined : { ...after };
  return {
    status: finalRecord?.status ?? "cancelled",
    record: finalRecord,
  };
}

async function killTaskResult(
  manager: TaskManager,
  api: ToolExecutionApi,
  record: BackgroundTaskRecord,
  context: Context,
): Promise<ToolExecutionResult> {
  const taskId = record.id;
  if (!isTaskActiveStatus(record.status)) {
    return textResult(`task ${taskId} already ${describeTaskOutcome(record)}`, true);
  }
  const { status } = await killConversationTask(
    manager,
    api.conversationId,
    record,
    "tool",
    {
      commit: (change, ctx) => api.commit(change, ctx),
      snapshot: (token, conversationId, key, ctx) => api.snapshot(token, conversationId, key, ctx),
      waitForTask: (id, ctx) => api.waitForTask(id, ctx).catch(() => undefined),
      now: () => api.now(),
    },
    context,
  );
  return {
    output: [{ type: "text", text: `task ${taskId}: ${status}` }],
    structuredOutput: { taskId, status },
  };
}

export function createTasksTool(manager: TaskManager) {
  return withToolPromptMeta(
    defineTool({
      name: TASKS_TOOL_NAME,
      description: `Inspect and control background tasks started by bash or powershell. list shows active and recent finished background tasks; read returns a task's output (${TASK_READ_MIN_BYTES}..${TASK_READ_MAX_BYTES} bytes, default ${TASK_READ_DEFAULT_BYTES}, tail mode, with sinceBytes/endByte cursors and filter/contextLines search); kill stops an active task.`,
      parameters: obj(
        {
          action: oneOf(["list", "read", "kill"], {
            description: "list tasks, read a task's output, or kill an active task",
          }),
          taskId: opt(
            str({ description: "Task id or unique prefix (required for read and kill)" }),
          ),
          status: opt(
            oneOf(["all", "active", "finished"], {
              description: "Filter listed tasks by state (list, default all)",
            }),
          ),
          limit: opt(
            num({
              description: `Maximum finished tasks to show (list, default ${DEFAULT_LIST_FINISHED_LIMIT}, max ${MAX_LIST_FINISHED_LIMIT})`,
            }),
          ),
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
          endByte: opt(
            num({
              description:
                "Backward paging cursor: read output ending before this byte offset (a previous read's fromByte)",
            }),
          ),
          filter: opt(
            str({
              description:
                "Filter output to matching lines (case-insensitive substring or /regex/flags) (read)",
            }),
          ),
          contextLines: opt(
            num({
              description: `Context lines around each filtered match, 0..${TASK_FILTER_MAX_CONTEXT_LINES} (read, requires filter)`,
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
                  shell: opt(oneOf(["bash", "powershell"])),
                  command: str(),
                  cwd: opt(str()),
                  status: str(),
                  exitCode: opt(num()),
                  error: opt(str()),
                  logPath: opt(str()),
                  logTruncated: opt(bool()),
                  logError: opt(str()),
                  cancelReason: opt(oneOf(["user", "tool", "abort"])),
                  startedAt: num(),
                  endedAt: opt(num()),
                },
                { open: true },
              ),
            ),
          ),
          omittedFinished: opt(num()),
          taskId: opt(str()),
          status: opt(str()),
          output: opt(str()),
          fromByte: opt(num()),
          endByte: opt(num()),
          totalBytes: opt(num()),
          truncated: opt(bool()),
          sinceBytes: opt(num()),
          matchedLines: opt(num()),
          totalMatchedLines: opt(num()),
          scanTruncated: opt(bool()),
          logPath: opt(str()),
        },
        { open: true },
      ),
      execute: async (args, api, context): Promise<ToolExecutionResult> => {
        const records = await listConversationTasks(api, api.conversationId, context);
        if (args.action === "list") {
          return listTasksResult(records, args.status ?? "all", args.limit);
        }
        const resolved = resolveTargetTask(records, args.action, args.taskId);
        if (!("id" in resolved)) return resolved;
        return args.action === "read"
          ? readTaskResult(manager, api.conversationId, resolved, args)
          : killTaskResult(manager, api, resolved, context);
      },
    }),
    {
      promptSnippet: "List, read, or stop background tasks",
      promptGuidelines: [
        "tasks cannot start work: start background work with bash or powershell (background: true), then continue independent work while it runs.",
        "Never poll tasks with repeated list or read calls. End your turn or continue independent work while background tasks run; you are notified automatically when a task finishes.",
        "Use tasks to read output with mode (head or tail), bytes, sinceBytes, endByte, or filter/contextLines instead of reloading whole logs.",
      ],
    },
  );
}
