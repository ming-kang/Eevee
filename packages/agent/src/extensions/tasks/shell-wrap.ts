import type { Context } from "@earendil-works/chord/context";
import type {
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
  Wrap,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { getToolPromptMeta, withToolPromptMeta } from "../../context/tool-meta.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../../shared/truncate.ts";
import type { ResolvedPowerShell } from "../../shell/index.ts";
import { isTaskActiveStatus, listConversationTasks, TaskRecordDoc, TasksBoardDoc } from "./docs.ts";
import {
  type CommandOutcome,
  type RunningCommand,
  startCommand,
  type TaskManager,
  type TaskShell,
} from "./runner.ts";
import type { BackgroundShellTask } from "./task-def.ts";
import { formatTaskSummaryLine, textResult } from "./tasks-tool.ts";

export const DEFAULT_BACKGROUND_AFTER_MS = 30_000;
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

type ShellArgs = {
  readonly command: string;
  readonly timeout?: number;
  readonly background?: boolean;
};

type AbortRace = {
  readonly promise: Promise<"aborted">;
  dispose(): void;
};

export type ShellWrapDependencies = {
  readonly manager: TaskManager;
  readonly backgroundShellTask: BackgroundShellTask;
  readonly backgroundAfterMs: () => number | undefined;
  readonly env?: () => Record<string, string> | undefined;
  readonly resolvePowerShell?: () => Promise<ResolvedPowerShell | undefined>;
};

export type AdoptedCommand = {
  readonly taskId: string;
  readonly durableTaskId: number;
};

export type AdoptCommandOptions = {
  readonly api: ToolExecutionApi;
  readonly manager: TaskManager;
  readonly backgroundShellTask: BackgroundShellTask;
  readonly running: RunningCommand;
  readonly shell: TaskShell;
  readonly command: string;
  readonly skipIfSettled?: boolean;
  readonly context: Context;
};

function abortedResult(api: ToolExecutionApi): ToolExecutionResult {
  const retained = api.retainedOutput();
  return {
    isError: true,
    diagnostics: [{ severity: "error", code: "aborted", message: "Command aborted" }],
    structuredOutput: {
      output: retained.text,
      truncated: retained.truncated,
    },
  };
}

function backgroundStartedResult(
  taskId: string,
  output: string,
  truncated: boolean,
  text: string,
): ToolExecutionResult {
  return {
    output: [{ type: "text", text }],
    structuredOutput: {
      output,
      truncated,
      taskId,
      status: "running",
    },
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

async function checkAdmission(
  manager: TaskManager,
  api: ToolExecutionApi,
  context: Context,
): Promise<string | undefined> {
  const convTasks = await listConversationTasks(api, api.conversationId, context);
  const activeConv = convTasks.filter((record) => isTaskActiveStatus(record.status));
  const liveConvCount = manager.activeCount(api.conversationId);
  if (Math.max(activeConv.length, liveConvCount) >= manager.maxActivePerConversation) {
    const listing =
      activeConv.length > 0
        ? activeConv.map(formatTaskSummaryLine)
        : manager
            .listActive(api.conversationId)
            .map((entry) => `- ${entry.taskId} [running]: ${entry.command.command}`);
    return (
      `Cannot start background task: conversation active limit (${manager.maxActivePerConversation}) reached.\n` +
      `Active tasks:\n${listing.join("\n")}`
    );
  }

  const activeTotal = manager.activeCount();
  if (activeTotal >= manager.maxActiveTotal) {
    const listing = manager
      .listActive()
      .map((entry) => `- conv ${entry.conversationId} ${entry.taskId}: ${entry.command.command}`);
    return (
      `Cannot start background task: total active limit (${manager.maxActiveTotal}) reached.\n` +
      `Active tasks:\n${listing.join("\n")}`
    );
  }

  return undefined;
}

export async function adoptCommand(
  options: AdoptCommandOptions,
): Promise<AdoptedCommand | undefined> {
  const {
    api,
    manager,
    backgroundShellTask,
    running,
    shell,
    command,
    skipIfSettled = false,
    context,
  } = options;
  let attachedTaskId: string | undefined;
  try {
    return await api.commit(async (tx) => {
      if (attachedTaskId !== undefined) {
        manager.delete(api.conversationId, attachedTaskId, false);
        attachedTaskId = undefined;
      }
      if (skipIfSettled && running.settled) {
        return undefined;
      }
      const board = await tx.doc(TasksBoardDoc, api.conversationId);
      const taskId = `task-${board.nextSeq}`;
      board.nextSeq += 1;
      board.order.push(taskId);
      manager.attach(api.conversationId, taskId, running);
      attachedTaskId = taskId;
      const durableTaskId = await tx.createTask(
        backgroundShellTask,
        { taskId, command, shell },
        {
          ownership: { kind: "conversation" },
          conversationId: api.conversationId,
          background: true,
        },
      );
      const record = await tx.doc(TaskRecordDoc, api.conversationId, taskId, null);
      record.id = taskId;
      record.durableTaskId = durableTaskId;
      record.shell = shell;
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
    running.detachCancel();
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

async function runBackground(
  deps: ShellWrapDependencies,
  api: ToolExecutionApi,
  running: RunningCommand,
  shell: TaskShell,
  command: string,
  timeoutSeconds: number | undefined,
  context: Context,
): Promise<ToolExecutionResult> {
  const adopted = await adoptCommand({
    api,
    manager: deps.manager,
    backgroundShellTask: deps.backgroundShellTask,
    running,
    shell,
    command,
    context,
  });
  if (adopted === undefined) {
    return finishedResult(await running.done, timeoutSeconds, api);
  }
  return backgroundStartedResult(
    adopted.taskId,
    "",
    false,
    `Started background task ${adopted.taskId}. You will be notified when it finishes; inspect its output meanwhile with tasks({ action: "read", taskId: "${adopted.taskId}" }).`,
  );
}

async function runForeground(
  deps: ShellWrapDependencies,
  api: ToolExecutionApi,
  running: RunningCommand,
  shell: TaskShell,
  command: string,
  timeoutSeconds: number | undefined,
  context: Context,
): Promise<ToolExecutionResult> {
  const abortRace = abortedBy(context.abortSignal);
  try {
    const afterMs = deps.backgroundAfterMs();
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
      return finishedResult(raced.outcome, timeoutSeconds, api);
    }
    if (raced.kind === "aborted") {
      running.detachCancel();
      await running.done;
      return abortedResult(api);
    }
    if (running.settled) {
      return finishedResult(await running.done, timeoutSeconds, api);
    }
    const admissionError = await checkAdmission(deps.manager, api, context);
    if (running.settled) {
      return finishedResult(await running.done, timeoutSeconds, api);
    }
    if (admissionError !== undefined) {
      running.detachCancel();
      await running.done;
      return textResult(admissionError, true);
    }
    const adopted = await adoptCommand({
      api,
      manager: deps.manager,
      backgroundShellTask: deps.backgroundShellTask,
      running,
      shell,
      command,
      skipIfSettled: true,
      context,
    });
    if (adopted === undefined) {
      return finishedResult(await running.done, timeoutSeconds, api);
    }
    const retained = api.retainedOutput();
    const notice =
      `Still running after ${afterMs}ms; moved to background task ${adopted.taskId}. ` +
      `You will be notified when it finishes; inspect output with tasks({ action: "read", taskId: "${adopted.taskId}" }).`;
    return backgroundStartedResult(
      adopted.taskId,
      retained.text,
      retained.truncated,
      retained.text === "" ? notice : `${retained.text}\n${notice}`,
    );
  } finally {
    abortRace?.dispose();
  }
}

async function executeShell(
  deps: ShellWrapDependencies,
  shell: TaskShell,
  args: ShellArgs,
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

  if (args.background === true) {
    const admissionError = await checkAdmission(deps.manager, api, context);
    if (admissionError !== undefined) return textResult(admissionError, true);
  }

  const extraEnv = deps.env?.();
  const running = startCommand(env, {
    shell,
    command: args.command,
    cwd: env.cwd,
    ...(extraEnv === undefined ? {} : { env: extraEnv }),
    ...(args.timeout === undefined ? {} : { timeoutSeconds: args.timeout }),
    ...(deps.resolvePowerShell === undefined ? {} : { resolvePowerShell: deps.resolvePowerShell }),
    ...(args.background === true
      ? {}
      : { spill: { afterBytes: DEFAULT_MAX_BYTES, afterLines: DEFAULT_MAX_LINES } }),
  });
  if (running.rewrittenNul) {
    api.diagnostic({
      severity: "info",
      code: "normalized_nul_redirect",
      message: "Normalized Windows CMD nul redirection to /dev/null for POSIX bash.",
    });
  }
  const detach = running.onOutput((chunk) => {
    try {
      api.output(chunk);
    } catch {
      // The invocation may have ended while detached output still arrives.
    }
  });
  try {
    await running.ready;
    if (running.settled) {
      return finishedResult(await running.done, args.timeout, api);
    }
    if (context.abortSignal?.aborted) {
      running.detachCancel();
      await running.done;
      return abortedResult(api);
    }
    return args.background === true
      ? await runBackground(deps, api, running, shell, args.command, args.timeout, context)
      : await runForeground(deps, api, running, shell, args.command, args.timeout, context);
  } finally {
    detach();
  }
}

export function makeShellWrap(shell: TaskShell, deps: ShellWrapDependencies): Wrap {
  const label = shell === "bash" ? "Bash" : "PowerShell";
  return {
    tool: shell,
    wrap: (base: ToolRegistration): ToolRegistration => {
      const inherited = getToolPromptMeta(base);
      const wrapped: ToolRegistration = {
        ...base,
        parameters: obj(
          {
            command: str({ description: `${label} command to execute` }),
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
          executeShell(deps, shell, args as ShellArgs, api, context),
      };
      const fallbackRule =
        shell === "bash"
          ? "Use bash for builds, tests, and system commands. Quote paths with spaces, prefer non-interactive commands, and use POSIX shell syntax (/dev/null, not NUL or $null)."
          : "Use powershell for PowerShell scripts and Windows-native commands; prefer non-interactive commands, and use PowerShell syntax ($null rather than /dev/null or NUL).";
      return withToolPromptMeta(
        wrapped,
        {
          promptSnippet: `Execute ${shell === "bash" ? "bash" : "PowerShell"} commands, foreground or background`,
          promptGuidelines: [
            ...(inherited === undefined ? [fallbackRule] : []),
            "Choose foreground (default) when your next step needs the output; use background: true for long-running work (builds, servers, watchers, large test suites) or when you have independent work to continue.",
            "Foreground commands exceeding the handoff timeout move to a background task automatically; do not poll, wait for the completion notice or inspect with tasks.",
          ],
        },
        base,
      );
    },
  };
}
