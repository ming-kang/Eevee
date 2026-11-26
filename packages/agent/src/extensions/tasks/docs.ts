import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type DocumentReader,
  defineDoc,
  defineDocFamily,
} from "@earendil-works/pi-durable";

export const TASKS_EXTENSION = "eevee.tasks";
export const TASKS_TOOL_NAME = "tasks";
export const TASK_NOTIFICATION_ENTRY_KIND = "eevee.task-notification";

export type BackgroundTaskStatus =
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted";

export function isTaskActiveStatus(status: BackgroundTaskStatus): boolean {
  return status === "queued" || status === "running" || status === "stopping";
}

export function isTaskTerminalStatus(status: BackgroundTaskStatus): boolean {
  return !isTaskActiveStatus(status);
}

export type BackgroundTaskRecord = {
  id: string;
  durableTaskId?: number;
  shell?: "bash" | "powershell";
  command: string;
  cwd?: string;
  status: BackgroundTaskStatus;
  exitCode?: number;
  error?: string;
  logPath?: string;
  logTruncated?: boolean;
  logError?: string;
  cancelReason?: "user" | "tool" | "abort";
  startedAt: number;
  endedAt?: number;
};

export type TaskIdResolution =
  | { readonly kind: "match"; readonly record: BackgroundTaskRecord }
  | { readonly kind: "ambiguous"; readonly matches: readonly BackgroundTaskRecord[] }
  | { readonly kind: "not_found" };

export type TasksBoard = {
  nextSeq: number;
  order: string[];
};

export const TasksBoardDoc = defineDoc<TasksBoard>({
  kind: "eevee.tasks-board",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ nextSeq: 1, order: [] }),
  checkpointWhen: () => true,
});

export const TaskRecordDoc = defineDocFamily<BackgroundTaskRecord, null>({
  kind: "eevee.task-record",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: () => ({ id: "", command: "", status: "running", startedAt: 0 }),
  checkpointWhen: () => true,
});

export async function listConversationTasks(
  reader: DocumentReader,
  conversationId: ConversationId,
  context: Context,
): Promise<BackgroundTaskRecord[]> {
  const board = await reader.snapshot(TasksBoardDoc, conversationId, context);
  const records: BackgroundTaskRecord[] = [];
  for (const taskId of board?.order ?? []) {
    const record = await reader.snapshot(TaskRecordDoc, conversationId, taskId, context);
    if (record !== undefined) records.push({ ...record });
  }
  return records;
}

export async function getConversationTask(
  reader: DocumentReader,
  conversationId: ConversationId,
  taskId: string,
  context: Context,
): Promise<BackgroundTaskRecord | undefined> {
  const record = await reader.snapshot(TaskRecordDoc, conversationId, taskId, context);
  return record === undefined ? undefined : { ...record };
}

export async function hasActiveTasks(
  reader: DocumentReader,
  conversationId: ConversationId,
  context: Context,
): Promise<boolean> {
  const records = await listConversationTasks(reader, conversationId, context);
  return records.some((record) => isTaskActiveStatus(record.status));
}

export function describeTaskOutcome(record: BackgroundTaskRecord): string {
  switch (record.status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "completed":
      return record.exitCode === undefined ? "completed" : `completed with code ${record.exitCode}`;
    case "failed":
      if (record.exitCode !== undefined && record.error !== undefined) {
        return `failed with code ${record.exitCode}: ${record.error}`;
      }
      if (record.exitCode !== undefined) {
        return `failed with code ${record.exitCode}`;
      }
      return record.error === undefined ? "failed" : `failed: ${record.error}`;
    case "timed_out":
      if (record.error === undefined) return "timed out";
      if (record.error.startsWith("timeout:")) {
        const secs = record.error.slice("timeout:".length);
        return secs !== "" && secs !== "undefined" ? `timed out after ${secs}s` : "timed out";
      }
      return /timed?\s*out/i.test(record.error) ? record.error : `timed out: ${record.error}`;
    case "cancelled":
      return record.cancelReason === "user" ? "cancelled by user" : "cancelled";
    case "interrupted":
      return record.error ?? "interrupted by host restart";
  }
}

export function resolveTaskId(
  records: readonly BackgroundTaskRecord[],
  rawId: string,
): TaskIdResolution {
  const needle = rawId.trim();
  if (needle === "") return { kind: "not_found" };

  const exact = records.find((record) => record.id === needle);
  if (exact !== undefined) return { kind: "match", record: exact };

  const lower = needle.toLowerCase();
  const exactInsensitive = records.filter((record) => record.id.toLowerCase() === lower);
  if (exactInsensitive.length === 1 && exactInsensitive[0] !== undefined) {
    return { kind: "match", record: exactInsensitive[0] };
  }

  const matches = records.filter((record) => {
    const idLower = record.id.toLowerCase();
    if (idLower.startsWith(lower)) return true;
    if (idLower.startsWith("task-")) {
      return idLower.slice("task-".length).startsWith(lower);
    }
    return false;
  });

  if (matches.length === 1 && matches[0] !== undefined) {
    return { kind: "match", record: matches[0] };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", matches };
  }
  return { kind: "not_found" };
}
