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
  command: str({ description: "要执行的 bash 命令" }),
  timeout: opt(int({ minimum: 1, description: "超时秒数，超时后终止命令；转入后台后同样生效" })),
  background: opt(bool({ description: "直接转入后台，不等待前台输出" })),
});

export function createBashTool(deps: BashDeps) {
  return defineTool({
    name: "bash",
    description:
      "在工作目录执行 bash 命令，返回合并的 stdout 与 stderr。" +
      "命令运行较久时会自动转入后台作业（job://jN），结束后结果作为新消息送达；此时可以先结束本轮或继续做别的。",
    parameters: Parameters,
    outputLimits: { retain: "tail" },
    async execute(args, api, context) {
      if (api.env === undefined) throw new Error("没有执行环境");
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
          return { isError: true, output: [{ type: "text", text: "命令已中止" }], details };
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
                `命令仍在运行，已转入后台作业 ${address}。完整输出写入日志，可用 read ${address} 查看。` +
                "作业结束后会作为新消息通知你；可以先做别的，或者直接结束本轮。",
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
  if (result.error === "timeout") throw new Error(`命令超时（${timeout} 秒）`);
  if (result.error !== undefined) throw new Error(result.error);
  const details: BashDetails = result.exitCode === undefined ? {} : { exitCode: result.exitCode };
  if (result.exitCode === 0) return { details };
  return {
    isError: true,
    details,
    diagnostics: [
      { severity: "error" as const, code: "exit_code", message: `退出码 ${result.exitCode}` },
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
