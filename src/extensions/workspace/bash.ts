import { BACKGROUND_CONTEXT, type Context, withCancel } from "@earendil-works/chord/context";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import { type BashDetails, formatAddress, type JobId } from "../../contracts/index.ts";

export type CommandResult = { exitCode?: number; error?: string };

export type RunningCommand = {
  readonly command: string;
  output(): string;
  onOutput(listener: (chunk: string) => void): void;
  readonly done: Promise<CommandResult>;
  kill(): void;
};

export type BackgroundJobs = {
  adopt(
    api: ToolExecutionApi,
    command: RunningCommand,
    context: Context,
  ): Promise<JobId | undefined>;
};

export type BashDeps = {
  backgroundAfterMs: () => number;
  jobs: BackgroundJobs;
  env: () => Record<string, string>;
};

const BUFFER_LIMIT = 2 * 1024 * 1024;

const Parameters = obj({
  command: str({ description: "The bash command to run in the workspace" }),
  timeout: opt(
    int({
      minimum: 1,
      description:
        "Timeout in seconds; the command is killed when it runs out. It still applies once the command has moved to the background",
    }),
  ),
  background: opt(
    bool({
      description: "Move to the background right away, without waiting for foreground output",
    }),
  ),
});

export function createBashTool(deps: BashDeps) {
  return defineTool({
    name: "bash",
    description:
      "Run a bash command in the workspace and return its stdout and stderr combined." +
      "A command that runs for a while moves to a background job (job://jN) on its own." +
      "Its result arrives as a new message once it ends, so end this turn or do something else until then.",
    parameters: Parameters,
    outputLimits: { retain: "tail" },
    async execute(args, api, context) {
      if (api.env === undefined) throw new Error("No execution environment");
      const running = startCommand(api.env, args.command, deps.env(), args.timeout);
      let foreground = true;
      running.onOutput((chunk) => {
        if (foreground) api.output(chunk);
      });
      const stop = () => {
        if (foreground) running.kill();
      };
      context.abortSignal?.addEventListener("abort", stop, { once: true });
      try {
        const waitMs = args.background ? 0 : deps.backgroundAfterMs();
        const settled = await Promise.race([running.done, delay(waitMs, context)]);
        if (settled !== undefined) return finish(settled, args.timeout);
        if (context.abortSignal?.aborted) {
          running.kill();
          const details: BashDetails = { stopped: true };
          return {
            isError: true,
            output: [{ type: "text", text: "The command was aborted." }],
            details,
          };
        }
        const jobId = await deps.jobs.adopt(api, running, context);
        if (jobId === undefined) return finish(await running.done, args.timeout);
        foreground = false;
        const address = formatAddress({ kind: "job", id: jobId });
        const details: BashDetails = { jobId };
        return {
          details,
          output: [
            {
              type: "text",
              text:
                `The command is still running as a background job (${address}). Read its full output with read ${address}.` +
                "You will get a new message once the job ends. Do something else meanwhile, or end this turn now.",
            },
          ],
        };
      } finally {
        context.abortSignal?.removeEventListener("abort", stop);
      }
    },
  });
}

function finish(result: CommandResult, timeout: number | undefined) {
  if (result.error === "timeout")
    throw new Error(
      `The command timed out after ${timeout} s and was killed. Run it in the background, or set a longer timeout, if it needs more time.`,
    );
  if (result.error !== undefined) throw new Error(result.error);
  const details: BashDetails = result.exitCode === undefined ? {} : { exitCode: result.exitCode };
  if (result.exitCode === 0) return { details };
  return {
    isError: true,
    details,
    diagnostics: [
      { severity: "error" as const, code: "exit_code", message: `Exit code ${result.exitCode}` },
    ],
  };
}

export function startCommand(
  env: ExecutionEnv,
  command: string,
  variables: Record<string, string>,
  timeout?: number,
): RunningCommand {
  const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
  let buffer = "";
  const listeners: ((chunk: string) => void)[] = [];
  const done = env
    .exec(
      command,
      {
        env: variables,
        inheritEnv: false,
        ...(timeout === undefined ? {} : { timeout }),
        onOutput: (text) => {
          buffer += text;
          if (buffer.length > BUFFER_LIMIT) buffer = buffer.slice(-BUFFER_LIMIT / 2);
          for (const listener of listeners) listener(text);
        },
      },
      context,
    )
    .then(
      (result): CommandResult =>
        result.ok
          ? { exitCode: result.value.exitCode }
          : { error: result.error.code === "timeout" ? "timeout" : result.error.message },
      (error: unknown): CommandResult => ({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  return {
    command,
    output: () => buffer,
    onOutput: (listener) => {
      listeners.push(listener);
    },
    done,
    kill: () => cancel(new Error("killed")),
  };
}

function delay(ms: number, context: Context): Promise<undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    context.abortSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
      { once: true },
    );
  });
}
