import { connectLocalEngine } from "@eevee/engine";
import {
  parseWithSchema,
  type TaskListStatusFilter,
  TaskListStatusFilterSchema,
  type TaskReadMode,
  TaskReadModeSchema,
  WorkerIdSchema,
} from "@eevee/protocol";
import type { Command } from "commander";
import {
  installSignalAbort,
  parseIntRangeFlag,
  parseNonEmptyTaskId,
  parseNonNegativeIntFlag,
  parsePositiveIntFlag,
} from "../args.ts";
import {
  aggregateBoardTasks,
  buildTaskLineMatcher,
  formatTaskList,
  formatTaskOutput,
  TASK_FILTER_MAX_CONTEXT_LINES,
  TaskWatchRenderer,
} from "../format.ts";

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

  let filter: string | undefined;
  if (options.filter !== undefined) {
    buildTaskLineMatcher(options.filter);
    filter = options.filter;
  }

  let contextLines: number | undefined;
  if (options.context !== undefined) {
    contextLines = parseIntRangeFlag(
      options.context,
      "--context",
      0,
      TASK_FILTER_MAX_CONTEXT_LINES,
    );
    if (filter === undefined) {
      throw new Error("--context requires --filter");
    }
  }

  return {
    ...(mode === undefined ? {} : { mode }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(sinceBytes === undefined ? {} : { sinceBytes }),
    ...(filter === undefined ? {} : { filter }),
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
        let status: TaskListStatusFilter | undefined;
        if (options.status !== undefined) {
          status = parseWithSchema(TaskListStatusFilterSchema, options.status, "--status");
        }
        const limit =
          options.limit === undefined ? undefined : parsePositiveIntFlag(options.limit, "--limit");

        const { client } = await connectLocalEngine(env);
        if (workerId !== undefined) {
          const response = await client.listWorkerTasks(projectId, workerId, {
            ...(status === undefined ? {} : { status }),
            ...(limit === undefined ? {} : { limit }),
          });
          if (options.json) {
            console.log(JSON.stringify(response, null, 2));
            return;
          }
          console.log(formatTaskList(response.tasks, { showWorker: false }));
          return;
        }

        const board = await client.getBoard(projectId);
        const tasks = aggregateBoardTasks(board, {
          ...(status === undefined ? {} : { status }),
          ...(limit === undefined ? {} : { limit }),
        });
        if (options.json) {
          console.log(JSON.stringify({ tasks }, null, 2));
          return;
        }
        console.log(formatTaskList(tasks, { showWorker: true }));
      },
    );

  taskCommand
    .command("read")
    .description("Read output from a Worker background task")
    .argument("<project>", "Project ID")
    .argument("<worker>", "Worker ID (e.g. w1)")
    .argument("<taskId>", "Task ID (e.g. task-1)")
    .option("--mode <mode>", "Read mode: head or tail")
    .option("--bytes <n>", "Max bytes to read")
    .option("--since-bytes <n>", "Read output starting from byte offset")
    .option("--end-byte <n>", "Read output ending at byte offset")
    .option("--filter <pattern>", "Filter matching lines (substring or /regex/flags)")
    .option("--context <0..5>", "Context lines (0..5) around --filter matches")
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

        const { client } = await connectLocalEngine(env);
        const response = await client.readWorkerTask(projectId, workerId, taskId, {
          ...parsed,
          ...(endByte === undefined ? {} : { endByte }),
        });
        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(formatTaskOutput(workerId, response));
      },
    );

  taskCommand
    .command("watch")
    .description("Stream live output and status for a Worker background task")
    .argument("<project>", "Project ID")
    .argument("<worker>", "Worker ID (e.g. w1)")
    .argument("<taskId>", "Task ID (e.g. task-1)")
    .option("--mode <mode>", "Initial snapshot mode: head or tail")
    .option("--bytes <n>", "Max bytes in initial snapshot")
    .option("--since-bytes <n>", "Stream output starting from byte offset")
    .option("--filter <pattern>", "Filter matching lines (substring or /regex/flags)")
    .option("--context <0..5>", "Context lines (0..5) around --filter matches")
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

        const { client } = await connectLocalEngine(env);
        const controller = new AbortController();
        const cleanup = installSignalAbort(controller);
        const renderer = new TaskWatchRenderer((chunk) => process.stdout.write(chunk), {
          workerId,
          ...(parsed.filter === undefined ? {} : { filter: parsed.filter }),
          ...(parsed.contextLines === undefined ? {} : { contextLines: parsed.contextLines }),
        });

        try {
          for await (const event of client.streamWorkerTask(projectId, workerId, taskId, {
            ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
            ...(parsed.bytes === undefined ? {} : { bytes: parsed.bytes }),
            ...(parsed.sinceBytes === undefined ? {} : { sinceBytes: parsed.sinceBytes }),
            signal: controller.signal,
          })) {
            if (options.json) {
              process.stdout.write(`${JSON.stringify(event)}\n`);
              if (event.type === "end") break;
              continue;
            }
            if (event.type === "snapshot") {
              renderer.onSnapshot(event.task, event.output);
            } else if (event.type === "chunk") {
              renderer.onChunk(event.text);
            } else if (event.type === "status") {
              renderer.onStatus(event.task);
            } else if (event.type === "end") {
              renderer.onEnd(event);
              break;
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          cleanup();
        }
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
        const { client } = await connectLocalEngine(env);
        const response = await client.killWorkerTask(projectId, workerId, taskId);
        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        const reason =
          response.task.cancelReason === undefined ? "" : `, reason: ${response.task.cancelReason}`;
        console.log(
          `Killed task ${response.task.id} on ${workerId} (status: ${response.task.status}${reason})`,
        );
      },
    );
}
