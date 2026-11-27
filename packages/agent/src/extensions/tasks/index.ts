import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ResolvedPowerShell } from "../../shell/index.ts";
import { createCompactionReminderHook } from "./compaction-reminder.ts";
import { TASKS_EXTENSION } from "./docs.ts";
import { TaskManager } from "./runner.ts";
import { DEFAULT_BACKGROUND_AFTER_MS, makeShellWrap } from "./shell-wrap.ts";
import { createBackgroundShellTask } from "./task-def.ts";
import { createTasksTool } from "./tasks-tool.ts";

export type TasksExtensionOptions = {
  readonly manager?: TaskManager;
  readonly backgroundAfterMs?: number | (() => number);
  readonly env?: () => Record<string, string> | undefined;
  readonly resolvePowerShell?: () => Promise<ResolvedPowerShell | undefined>;
};

export function createTasksExtension(options: TasksExtensionOptions = {}) {
  const manager = options.manager ?? new TaskManager();
  const backgroundShellTask = createBackgroundShellTask(manager);

  const backgroundAfterMs = (): number | undefined => {
    const configured = options.backgroundAfterMs;
    const ms = typeof configured === "function" ? configured() : configured;
    const value = ms ?? DEFAULT_BACKGROUND_AFTER_MS;
    return value > 0 && Number.isFinite(value) ? value : undefined;
  };

  const shellDeps = {
    manager,
    backgroundShellTask,
    backgroundAfterMs,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.resolvePowerShell === undefined
      ? {}
      : { resolvePowerShell: options.resolvePowerShell }),
  };

  return defineExtension<ToolRegistration>({
    name: TASKS_EXTENSION,
    tools: [createTasksTool(manager)],
    wraps: [makeShellWrap("bash", shellDeps), makeShellWrap("powershell", shellDeps)],
    tasks: [backgroundShellTask],
    hooks: [createCompactionReminderHook()],
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
export { DEFAULT_BACKGROUND_AFTER_MS } from "./shell-wrap.ts";
export {
  BACKGROUND_SHELL_TASK_NAME,
  type BackgroundShellInput,
  createBackgroundShellTask,
} from "./task-def.ts";
export {
  type KillConversationTaskOperations,
  type KillConversationTaskResult,
  killConversationTask,
} from "./tasks-tool.ts";
