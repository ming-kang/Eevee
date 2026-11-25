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

export type BackgroundTaskStatus = "running" | "exited" | "killed" | "interrupted";

export type BackgroundTaskRecord = {
  id: string;
  durableTaskId?: number;
  command: string;
  cwd?: string;
  status: BackgroundTaskStatus;
  exitCode?: number;
  error?: string;
  logPath?: string;
  startedAt: number;
  endedAt?: number;
};

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
  return records.some((record) => record.status === "running");
}

export function describeTaskOutcome(record: BackgroundTaskRecord): string {
  switch (record.status) {
    case "running":
      return "running";
    case "exited":
      return record.exitCode === undefined ? "exited" : `exited with code ${record.exitCode}`;
    case "killed":
      return "killed";
    case "interrupted":
      return record.error ?? "interrupted by host restart";
  }
}
