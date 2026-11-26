import { connectLocalEngine } from "@eevee/engine";
import {
  parseWithSchema,
  type TaskReadMode,
  TaskReadModeSchema,
  WorkerIdSchema,
} from "@eevee/protocol";
import type { Command } from "commander";
import { parseNonEmptyTaskId, parseNonNegativeIntFlag, parsePositiveIntFlag } from "../args.ts";
import { formatTaskOutput } from "../format.ts";

export function registerTaskCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const taskCommand = program
    .command("task")
    .description("Inspect and control Worker background tasks");

  taskCommand
    .command("read")
    .description("Read output from a Worker background task")
    .argument("<project>", "Project ID")
    .argument("<worker>", "Worker ID (e.g. w1)")
    .argument("<taskId>", "Task ID (e.g. task-1)")
    .option("--mode <mode>", "Read mode: head or tail")
    .option("--bytes <n>", "Max bytes to read")
    .option("--since-bytes <n>", "Read output starting from byte offset")
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        rawWorker: string,
        rawTaskId: string,
        options: { mode?: string; bytes?: string; sinceBytes?: string; json?: boolean },
      ) => {
        const workerId = parseWithSchema(WorkerIdSchema, rawWorker, "worker");
        const taskId = parseNonEmptyTaskId(rawTaskId);
        let mode: TaskReadMode | undefined;
        if (options.mode !== undefined) {
          mode = parseWithSchema(TaskReadModeSchema, options.mode, "--mode");
        }
        const bytes =
          options.bytes === undefined ? undefined : parsePositiveIntFlag(options.bytes, "--bytes");
        const sinceBytes =
          options.sinceBytes === undefined
            ? undefined
            : parseNonNegativeIntFlag(options.sinceBytes, "--since-bytes");

        const { client } = await connectLocalEngine(env);
        const response = await client.readWorkerTask(projectId, workerId, taskId, {
          ...(mode === undefined ? {} : { mode }),
          ...(bytes === undefined ? {} : { bytes }),
          ...(sinceBytes === undefined ? {} : { sinceBytes }),
        });
        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(formatTaskOutput(workerId, response));
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
        console.log(
          `Killed task ${response.task.id} on ${workerId} (status: ${response.task.status})`,
        );
      },
    );
}
