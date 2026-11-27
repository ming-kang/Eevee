import {
  type EntryModelMessagePayload,
  type EntryRecordPayload,
  parseNoticeData,
  parseTaskNotificationData,
  type WorkerId,
} from "@eevee/protocol";
import { isRecord } from "../object.ts";
import { extractText, extractThinking, extractToolCalls } from "./content.ts";
import { buildToolCallItems, type ToolResultRecord } from "./tools.ts";
import type { DisplayItem, LiveDocView, NoticeMeta, ToolStep } from "./types.ts";

export { activitySummary, formatToolLabel, toolActivity } from "./tools.ts";

function extractTimestamp(
  msg: EntryModelMessagePayload | undefined,
  fallback?: number,
): number | undefined {
  const ts = msg?.timestamp;
  if (typeof ts === "number" && ts > 0) return ts;
  return fallback;
}

function collectToolResults(entries: readonly EntryRecordPayload[]): Map<string, ToolResultRecord> {
  const results = new Map<string, ToolResultRecord>();
  for (const entry of entries) {
    if (entry.kind !== "pi.tool-result" && !entry.model?.some((m) => m.role === "toolResult")) {
      continue;
    }
    for (const msg of entry.model ?? []) {
      if (msg.role !== "toolResult" || typeof msg.toolCallId !== "string") continue;
      results.set(msg.toolCallId, {
        text: extractText(msg.content),
        isError: msg.isError === true,
      });
    }
  }
  return results;
}

function parseNoticeMeta(entry: EntryRecordPayload): NoticeMeta {
  if (entry.kind === "eevee.task-notification") {
    const taskNote = parseTaskNotificationData(entry.data);
    if (taskNote) {
      return {
        type: "task_notification",
        taskId: taskNote.taskId,
        taskStatus: taskNote.status,
        ...(taskNote.exitCode !== undefined ? { taskExitCode: taskNote.exitCode } : {}),
        ...(taskNote.cancelReason !== undefined ? { taskCancelReason: taskNote.cancelReason } : {}),
      };
    }
    const raw = isRecord(entry.data) ? entry.data : {};
    return {
      type: "task_notification",
      ...(typeof raw.taskId === "string" ? { taskId: raw.taskId } : {}),
      ...(typeof raw.exitCode === "number" ? { taskExitCode: raw.exitCode } : {}),
    };
  }

  const notice = parseNoticeData(entry.data);
  if (notice) {
    switch (notice.type) {
      case "question_answered":
        return { type: notice.type, questionId: notice.questionId };
      case "handoff":
      case "worker_message":
      case "worker_failed":
        return {
          type: notice.type,
          workerId: notice.workerId,
          workerName: notice.workerName,
          ...(notice.ticketId !== undefined ? { ticketId: notice.ticketId } : {}),
        };
    }
  }

  const raw = isRecord(entry.data) ? entry.data : {};
  return {
    type: typeof raw.type === "string" ? raw.type : "notice",
    ...(typeof raw.workerId === "string" ? { workerId: raw.workerId as WorkerId } : {}),
    ...(typeof raw.workerName === "string" ? { workerName: raw.workerName } : {}),
    ...(typeof raw.ticketId === "string" ? { ticketId: raw.ticketId } : {}),
    ...(typeof raw.questionId === "string" ? { questionId: raw.questionId } : {}),
  };
}

function buildAssistantItems(
  entry: EntryRecordPayload,
  msg: EntryModelMessagePayload | undefined,
  resultsByCallId: ReadonlyMap<string, ToolResultRecord>,
  liveToolsById: ReadonlyMap<string, ToolStep>,
  at: number | undefined,
): DisplayItem[] {
  const items: DisplayItem[] = [];
  const thinking = extractThinking(msg?.content);
  if (thinking) {
    items.push({
      kind: "thinking",
      key: `e:${entry.id}:think`,
      text: thinking,
      ...(at ? { at } : {}),
    });
  }

  items.push(
    ...buildToolCallItems(
      entry.id,
      extractToolCalls(msg?.content),
      resultsByCallId,
      liveToolsById,
      at,
    ),
  );

  const text = extractText(msg?.content);
  const error =
    msg?.stopReason === "error" || msg?.stopReason === "aborted"
      ? msg.errorMessage || msg.stopReason
      : undefined;
  if (text.length > 0 || error) {
    items.push({
      kind: "assistant",
      key: `e:${entry.id}:text`,
      text,
      ...(error ? { error } : {}),
      ...(at ? { at } : {}),
    });
  }
  return items;
}

export function buildDisplayItems(
  entries: readonly EntryRecordPayload[],
  live: LiveDocView,
): DisplayItem[] {
  const resultsByCallId = collectToolResults(entries);
  const liveToolsById = new Map(live.activeTools.map((slot) => [slot.id, slot]));
  const items: DisplayItem[] = [];

  for (const entry of entries) {
    if (entry.kind === "pi.system" || entry.kind === "pi.tool-result") continue;
    const firstMsg = entry.model?.[0];
    const at = extractTimestamp(firstMsg);

    if (entry.kind === "pi.compaction") {
      items.push({
        kind: "compaction",
        key: `e:${entry.id}`,
        summary: extractText(firstMsg?.content),
        ...(at ? { at } : {}),
      });
    } else if (entry.kind === "pi.reset") {
      items.push({
        kind: "reset",
        key: `e:${entry.id}`,
        text: extractText(firstMsg?.content),
        ...(at ? { at } : {}),
      });
    } else if (entry.kind === "eevee.notice" || entry.kind === "eevee.task-notification") {
      items.push({
        kind: "notice",
        key: `e:${entry.id}`,
        id: entry.id,
        text: extractText(firstMsg?.content),
        meta: parseNoticeMeta(entry),
        ...(at ? { at } : {}),
      });
    } else if (entry.kind === "pi.user" || firstMsg?.role === "user") {
      const text = extractText(firstMsg?.content);
      if (text.length > 0) {
        items.push({
          kind: "user",
          key: `e:${entry.id}`,
          id: entry.id,
          text,
          ...(at ? { at } : {}),
        });
      }
    } else if (entry.kind === "pi.assistant" || firstMsg?.role === "assistant") {
      items.push(...buildAssistantItems(entry, firstMsg, resultsByCallId, liveToolsById, at));
    }
  }

  if (live.busy) {
    if (live.partialThinking) {
      items.push({
        kind: "thinking",
        key: "live:think",
        text: live.partialThinking,
        streaming: true,
      });
    }
    if (live.partialTools.length > 0) {
      items.push({ kind: "tools", key: "live:tools", steps: live.partialTools, live: true });
    }
    if (live.partialText) {
      items.push({ kind: "assistant", key: "live:text", text: live.partialText, streaming: true });
    }
  }

  return items;
}
