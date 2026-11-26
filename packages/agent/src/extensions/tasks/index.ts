import type { Context } from "@earendil-works/chord/context";
import {
  CompactionEntry,
  type ConversationId,
  type Cursor,
  defineExtension,
  defineTool,
  type EntryId,
  type EntryRecord,
  GenerationTask,
  hook,
  ResetEntry,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  type Wrap,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { getToolPromptMeta, withToolPromptMeta } from "../../context/tool-meta.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../../shared/truncate.ts";
import { type ResolvedPowerShell, resolvePowerShell } from "../../shell/index.ts";
import {
  type BackgroundTaskRecord,
  describeTaskOutcome,
  isTaskActiveStatus,
  isTaskTerminalStatus,
  listConversationTasks,
  resolveTaskId,
  TASKS_EXTENSION,
  TASKS_TOOL_NAME,
  TaskRecordDoc,
  TasksBoardDoc,
} from "./docs.ts";
import {
  TASK_FILTER_MAX_CONTEXT_LINES,
  TASK_READ_DEFAULT_BYTES,
  TASK_READ_MAX_BYTES,
  TASK_READ_MIN_BYTES,
} from "./output.ts";
import {
  type CommandOutcome,
  type RunningCommand,
  startCommand,
  TaskManager,
  type TaskShell,
} from "./runner.ts";
import { createBackgroundShellTask } from "./task-def.ts";

export const DEFAULT_BACKGROUND_AFTER_MS = 30_000;
const DEFAULT_LIST_FINISHED_LIMIT = 5;
const MAX_LIST_FINISHED_LIMIT = 100;
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const COMPACTION_SCAN_PAGE = 64;

export type TasksExtensionOptions = {
  readonly manager?: TaskManager;
  readonly backgroundAfterMs?: number | (() => number);
  readonly env?: () => Record<string, string> | undefined;
  readonly resolvePowerShell?: () => Promise<ResolvedPowerShell | undefined>;
};

type ShellArgs = {
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

function clampFinishedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 0) {
    return DEFAULT_LIST_FINISHED_LIMIT;
  }
  return Math.min(MAX_LIST_FINISHED_LIMIT, Math.floor(limit));
}

function formatTaskSummaryLine(record: BackgroundTaskRecord): string {
  return `- ${record.id} [${describeTaskOutcome(record)}]: ${record.command}`;
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
  const remindedCompaction = new Map<ConversationId, EntryId>();

  const backgroundAfterMs = (): number | undefined => {
    const configured = options.backgroundAfterMs;
    const ms = typeof configured === "function" ? configured() : configured;
    const value = ms ?? DEFAULT_BACKGROUND_AFTER_MS;
    return value > 0 && Number.isFinite(value) ? value : undefined;
  };

  async function checkAdmission(
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

  async function adopt(
    api: ToolExecutionApi,
    running: RunningCommand,
    shell: TaskShell,
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

  async function executeShell(
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

    const extraEnv = options.env?.();
    let resolvedPowerShell: ResolvedPowerShell | undefined;
    if (shell === "powershell") {
      resolvedPowerShell =
        options.resolvePowerShell !== undefined
          ? await options.resolvePowerShell()
          : await resolvePowerShell(
              extraEnv === undefined ? {} : { env: { ...process.env, ...extraEnv } },
            );
      if (resolvedPowerShell === undefined) {
        return textResult(
          "PowerShell executable (pwsh or powershell) is unavailable on this system.",
          true,
        );
      }
    }

    if (args.background === true) {
      const admissionError = await checkAdmission(api, context);
      if (admissionError !== undefined) return textResult(admissionError, true);
    }

    const running = startCommand(env, {
      shell,
      command: args.command,
      cwd: env.cwd,
      ...(extraEnv === undefined ? {} : { env: extraEnv }),
      ...(args.timeout === undefined ? {} : { timeoutSeconds: args.timeout }),
      ...(resolvedPowerShell === undefined ? {} : { powerShell: resolvedPowerShell }),
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
    const abortRace = abortedBy(context.abortSignal);
    try {
      if (args.background === true) {
        await Promise.resolve();
        await Promise.resolve();
        if (running.settled) {
          return finishedResult(await running.done, args.timeout, api);
        }
        if (context.abortSignal?.aborted) {
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
        const adopted = await adopt(api, running, shell, args.command, context);
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
      const admissionError = await checkAdmission(api, context);
      if (admissionError !== undefined) {
        running.kill(false);
        await running.done;
        return textResult(admissionError, true);
      }
      const adopted = await adopt(api, running, shell, args.command, context);
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

  function makeShellWrap(shell: TaskShell): Wrap {
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
              timeout: opt(
                num({ description: "Timeout in seconds (optional, no default timeout)" }),
              ),
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
            executeShell(shell, args as ShellArgs, api, context),
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

  const tasksTool = withToolPromptMeta(
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
          const statusFilter = args.status ?? "all";
          const finishedLimit = clampFinishedLimit(args.limit);
          const active = records.filter((record) => isTaskActiveStatus(record.status));
          const finished = records.filter((record) => isTaskTerminalStatus(record.status));
          const shownFinished = finishedLimit === 0 ? [] : finished.slice(-finishedLimit);
          const shown =
            statusFilter === "active"
              ? active
              : statusFilter === "finished"
                ? shownFinished
                : [...active, ...shownFinished];
          const omittedFinished =
            statusFilter === "active" ? 0 : finished.length - shownFinished.length;

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

        const rawTaskId = args.taskId;
        if (rawTaskId === undefined || rawTaskId.trim() === "") {
          return textResult(`tasks ${args.action} requires a taskId`, true);
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

        const record = resolution.record;
        const taskId = record.id;

        if (args.action === "read") {
          let slice: Awaited<ReturnType<TaskManager["readOutput"]>>;
          try {
            slice = await manager.readOutput(api.conversationId, taskId, record, {
              ...(args.mode === undefined ? {} : { mode: args.mode }),
              ...(args.bytes === undefined ? {} : { bytes: args.bytes }),
              ...(args.sinceBytes === undefined ? {} : { sinceBytes: args.sinceBytes }),
              ...(args.endByte === undefined ? {} : { endByte: args.endByte }),
              ...(args.filter === undefined ? {} : { filter: args.filter }),
              ...(args.contextLines === undefined ? {} : { contextLines: args.contextLines }),
            });
          } catch (error) {
            return textResult(error instanceof Error ? error.message : String(error), true);
          }

          const lines = [`task ${record.id} — ${describeTaskOutcome(record)}`];
          if (record.logError !== undefined) {
            lines.push(`Log warning: ${record.logError}`);
          }
          if (record.logTruncated === true) {
            lines.push("Note: full output log was truncated at the size limit.");
          }
          if (args.filter !== undefined && args.filter !== "") {
            lines.push(
              `matched ${slice.matchedLines ?? 0} of ${slice.totalMatchedLines ?? 0} lines in bytes ${slice.fromByte}..${slice.endByte} of ${slice.totalBytes}` +
                (slice.scanTruncated ? " (scan capped at 20 MiB)" : ""),
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

        if (!isTaskActiveStatus(record.status)) {
          return textResult(`task ${record.id} already ${describeTaskOutcome(record)}`, true);
        }

        await api.commit(async (tx) => {
          const doc = await tx.doc(TaskRecordDoc, api.conversationId, taskId, null);
          if (doc.status === "queued" || doc.status === "running") {
            doc.status = "stopping";
          }
        }, context);

        const hadLive = manager.kill(api.conversationId, taskId, "tool");
        if (!hadLive) {
          // The process is already gone; mark the record so a still-live durable
          // task ends quietly instead of reporting an interruption.
          await api.commit(async (tx) => {
            const doc = await tx.doc(TaskRecordDoc, api.conversationId, taskId, null);
            if (isTaskActiveStatus(doc.status)) {
              doc.status = "cancelled";
              doc.cancelReason = "tool";
              doc.endedAt = api.now();
            }
          }, context);
        }
        let status: string = "cancelled";
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

  async function findLatestCompaction(
    api: {
      entries(
        query: { readonly order?: "ascending" | "descending" },
        limit: number,
        cursor: Cursor | undefined,
        context: Context,
      ): Promise<{ readonly items: readonly EntryRecord[]; readonly next?: Cursor }>;
    },
    context: Context,
  ): Promise<EntryRecord | undefined> {
    let cursor: Cursor | undefined;
    do {
      const page = await api.entries(
        { order: "descending" },
        COMPACTION_SCAN_PAGE,
        cursor,
        context,
      );
      for (const entry of page.items) {
        if (CompactionEntry.is(entry)) return entry;
        if (ResetEntry.is(entry)) return undefined;
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return undefined;
  }

  return defineExtension<ToolRegistration>({
    name: TASKS_EXTENSION,
    tools: [tasksTool],
    wraps: [makeShellWrap("bash"), makeShellWrap("powershell")],
    tasks: [backgroundShellTask],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          const records = await listConversationTasks(api, api.conversationId, context);
          const active = records.filter((record) => isTaskActiveStatus(record.status));
          if (active.length === 0) return undefined;

          const latestCompaction = await findLatestCompaction(api, context);
          if (latestCompaction === undefined) return undefined;
          if (remindedCompaction.get(api.conversationId) === latestCompaction.id) {
            return undefined;
          }

          remindedCompaction.set(api.conversationId, latestCompaction.id);
          const compactionTime = latestCompaction.model?.[0]?.timestamp;
          const preCompactionActive =
            compactionTime === undefined
              ? active
              : active.filter((record) => record.startedAt <= compactionTime);
          if (preCompactionActive.length === 0) return undefined;

          const reminder =
            "Active background tasks from before compaction are still running in this conversation. " +
            "Do not restart or duplicate them; wait for their automatic completion notice or inspect them with tasks:\n" +
            preCompactionActive.map(formatTaskSummaryLine).join("\n");
          return {
            messages: [
              ...request.messages,
              {
                role: "user",
                content: [{ type: "text", text: reminder }],
                timestamp: api.now(),
              },
            ],
          };
        },
      }),
    ],
  });
}

export {
  type BackgroundTaskRecord,
  type BackgroundTaskStatus,
  describeTaskOutcome,
  getConversationTask,
  hasActiveTasks,
  isTaskActiveStatus,
  isTaskTerminalStatus,
  listConversationTasks,
  resolveTaskId,
  TASK_NOTIFICATION_ENTRY_KIND,
  TASKS_EXTENSION,
  TASKS_TOOL_NAME,
  type TaskIdResolution,
  TaskRecordDoc,
  TasksBoardDoc,
} from "./docs.ts";
export {
  clampReadBytes,
  MAX_FILTER_SCAN_BYTES,
  type OutputReadOptions,
  type OutputSlice,
  readOutputFileSlice,
  sliceOutputText,
  sliceRetainedOutput,
  TASK_FILTER_MAX_CONTEXT_LINES,
  TASK_READ_DEFAULT_BYTES,
  TASK_READ_MAX_BYTES,
  TASK_READ_MIN_BYTES,
  utf8Tail,
  validateOutputReadOptions,
} from "./output.ts";
export {
  type ActiveTaskEntry,
  type CommandOutcome,
  type CommandOutput,
  cleanupLog,
  createTaskManager,
  DEFAULT_MAX_ACTIVE_PER_CONVERSATION,
  DEFAULT_MAX_ACTIVE_TOTAL,
  DEFAULT_MAX_FINISHED_PER_CONVERSATION,
  DEFAULT_MAX_LOG_BYTES,
  type LogOverflowPolicy,
  type RunningCommand,
  type StartCommandOptions,
  startCommand,
  type TaskKillReason,
  type TaskLogStatus,
  TaskManager,
  type TaskManagerOptions,
  type TaskShell,
} from "./runner.ts";
export {
  BACKGROUND_SHELL_TASK_NAME,
  type BackgroundShellInput,
  createBackgroundShellTask,
} from "./task-def.ts";
