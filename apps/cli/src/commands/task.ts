import {
  type ListProjectTasksResponse,
  type ListWorkerTasksResponse,
  parseWithSchema,
  TASK_FILTER_MAX_CONTEXT_LINES,
  type TaskListStatusFilter,
  TaskListStatusFilterSchema,
  type TaskReadMode,
  TaskReadModeSchema,
  WorkerIdSchema,
} from "@eevee/protocol";
import type { Command } from "commander";
import {
  addTaskReadOptions,
  parseIntRangeFlag,
  parseNonEmptyTaskId,
  parseNonNegativeIntFlag,
  parsePositiveIntFlag,
  validateTaskFilterOptions,
} from "../args.ts";
import { runEngineCommand, runStreamCommand } from "../command-helpers.ts";
import { formatTaskList, formatTaskOutput, TaskWatchRenderer } from "../format.ts";

function parseTaskStreamOptions(options: {
  readonly mode?: string;
  readonly bytes?: string;
  readonly sinceBytes?: string;
  readonly filter?: string;
  readonly context?: string;
}): {
  readonly mode?: TaskReadMode;
  readonly bytes?: number;
  readonly sinceBytes?: number;
  readonly filter?: string;
  readonly contextLines?: number;
} {
  const mode =
    options.mode === undefined
      ? undefined
      : parseWithSchema(TaskReadModeSchema, options.mode, "--mode");
  const bytes =
    options.bytes === undefined ? undefined : parsePositiveIntFlag(options.bytes, "--bytes");
  const sinceBytes =
    options.sinceBytes === undefined
      ? undefined
      : parseNonNegativeIntFlag(options.sinceBytes, "--since-bytes");
  const contextLines =
    options.context === undefined
      ? undefined
      : parseIntRangeFlag(options.context, "--context", 0, TASK_FILTER_MAX_CONTEXT_LINES);

  validateTaskFilterOptions({
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(contextLines === undefined ? {} : { contextLines }),
  });

  return {
    ...(mode === undefined ? {} : { mode }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(sinceBytes === undefined ? {} : { sinceBytes }),
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(contextLines === undefined ? {} : { contextLines }),
  };
}

export function registerTaskCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const taskCommand = program
    .command("task")
    .description("Inspect and control Worker background tasks");

  taskCommand
    .command("list")
    .description("List background tasks for a project or Worker")
    .argument("<project>", "Project ID")
    .argument("[worker]", "Worker ID (e.g. w1)")
    .option("--status <status>", "Filter by status: all, active, or finished")
    .option("--limit <n>", "Maximum number of tasks to return")
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        rawWorker: string | undefined,
        options: { status?: string; limit?: string; json?: boolean },
      ) => {
        const workerId =
          rawWorker === undefined
            ? undefined
            : parseWithSchema(WorkerIdSchema, rawWorker, "worker");
        const status: TaskListStatusFilter | undefined =
          options.status === undefined
            ? undefined
            : parseWithSchema(TaskListStatusFilterSchema, options.status, "--status");
        const limit =
          options.limit === undefined ? undefined : parsePositiveIntFlag(options.limit, "--limit");
        const query = {
          ...(status === undefined ? {} : { status }),
          ...(limit === undefined ? {} : { limit }),
        };

        await runEngineCommand<ListWorkerTasksResponse | ListProjectTasksResponse>(
          env,
          options,
          (client) =>
            workerId !== undefined
              ? client.listWorkerTasks(projectId, workerId, query)
              : client.listProjectTasks(projectId, query),
          (response) => formatTaskList(response.tasks, { showWorker: workerId === undefined }),
        );
      },
    );

  const taskReadCommand = taskCommand
    .command("read")
    .description("Read output from a Worker background task")
    .argument("<project>", "Project ID")
    .argument("<worker>", "Worker ID (e.g. w1)")
    .argument("<taskId>", "Task ID (e.g. task-1)");
  addTaskReadOptions(taskReadCommand, { includeEndByte: true })
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        rawWorker: string,
        rawTaskId: string,
        options: {
          mode?: string;
          bytes?: string;
          sinceBytes?: string;
          endByte?: string;
          filter?: string;
          context?: string;
          json?: boolean;
        },
      ) => {
        const workerId = parseWithSchema(WorkerIdSchema, rawWorker, "worker");
        const taskId = parseNonEmptyTaskId(rawTaskId);
        const parsed = parseTaskStreamOptions(options);
        const endByte =
          options.endByte === undefined
            ? undefined
            : parseNonNegativeIntFlag(options.endByte, "--end-byte");

        await runEngineCommand(
          env,
          options,
          (client) =>
            client.readWorkerTask(projectId, workerId, taskId, {
              ...parsed,
              ...(endByte === undefined ? {} : { endByte }),
            }),
          (response) => formatTaskOutput(workerId, response),
        );
      },
    );

  const taskWatchCommand = taskCommand
    .command("watch")
    .description("Stream live output and status for a Worker background task")
    .argument("<project>", "Project ID")
    .argument("<worker>", "Worker ID (e.g. w1)")
    .argument("<taskId>", "Task ID (e.g. task-1)");
  addTaskReadOptions(taskWatchCommand)
    .option("--json", "Output NDJSON stream events")
    .action(
      async (
        projectId: string,
        rawWorker: string,
        rawTaskId: string,
        options: {
          mode?: string;
          bytes?: string;
          sinceBytes?: string;
          filter?: string;
          context?: string;
          json?: boolean;
        },
      ) => {
        const workerId = parseWithSchema(WorkerIdSchema, rawWorker, "worker");
        const taskId = parseNonEmptyTaskId(rawTaskId);
        const parsed = parseTaskStreamOptions(options);
        const renderer = new TaskWatchRenderer((chunk) => process.stdout.write(chunk), {
          workerId,
          ...(parsed.filter === undefined ? {} : { filter: parsed.filter }),
          ...(parsed.contextLines === undefined ? {} : { contextLines: parsed.contextLines }),
        });

        await runStreamCommand(
          env,
          options,
          (client, signal) =>
            client.streamWorkerTask(projectId, workerId, taskId, {
              ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
              ...(parsed.bytes === undefined ? {} : { bytes: parsed.bytes }),
              ...(parsed.sinceBytes === undefined ? {} : { sinceBytes: parsed.sinceBytes }),
              signal,
            }),
          (event) => {
            if (event.type === "snapshot") {
              renderer.onSnapshot(event.task, event.output);
            } else if (event.type === "chunk") {
              renderer.onChunk(event.text);
            } else if (event.type === "status") {
              renderer.onStatus(event.task);
            } else if (event.type === "end") {
              renderer.onEnd(event);
            }
          },
        );
      },
    );

  taskCommand
    .command("kill")
    .description("Kill a running Worker background task")
    .argument("<project>", "Project ID")
    .argument("<worker>", "Worker ID (e.g. w1)")
    .argument("<taskId>", "Task ID (e.g. task-1)")
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        rawWorker: string,
        rawTaskId: string,
        options: { json?: boolean },
      ) => {
        const workerId = parseWithSchema(WorkerIdSchema, rawWorker, "worker");
        const taskId = parseNonEmptyTaskId(rawTaskId);
        await runEngineCommand(
          env,
          options,
          (client) => client.killWorkerTask(projectId, workerId, taskId),
          (response) => {
            const reason =
              response.task.cancelReason === undefined
                ? ""
                : `, reason: ${response.task.cancelReason}`;
            return `Killed task ${response.task.id} on ${workerId} (status: ${response.task.status}${reason})`;
          },
        );
      },
    );
}
