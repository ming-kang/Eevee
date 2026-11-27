import {
  type EntryModelMessagePayload,
  type EntryRecordPayload,
  parseNoticeData,
  parseTaskNotificationData,
} from "@eevee/protocol";
import { isRecord } from "../object.ts";
import {
  type ExtractedToolCall,
  extractText,
  extractThinking,
  extractToolCalls,
  extractUserParts,
} from "./content.ts";
import { buildToolCallItems, type ToolResultRecord } from "./tools.ts";
import type { DisplayItem, LiveDocView, NoticeInfo, ToolStep } from "./types.ts";

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

function parseNoticeInfo(entry: EntryRecordPayload): NoticeInfo {
  if (entry.kind === "eevee.task-notification") {
    const taskNote = parseTaskNotificationData(entry.data);
    if (taskNote) {
      return { kind: "task_notification", data: taskNote };
    }
    return { kind: "generic", type: "task_notification" };
  }

  const notice = parseNoticeData(entry.data);
  if (notice) {
    return { kind: "notice", data: notice };
  }

  const raw = isRecord(entry.data) ? entry.data : {};
  return {
    kind: "generic",
    type: typeof raw.type === "string" ? raw.type : "notice",
  };
}

function buildAssistantItems(
  entry: EntryRecordPayload,
  msg: EntryModelMessagePayload | undefined,
  calls: readonly ExtractedToolCall[],
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

  items.push(...buildToolCallItems(entry.id, calls, resultsByCallId, liveToolsById, at));

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

function mergeLiveToolSteps(
  partialTools: readonly ToolStep[],
  activeTools: readonly ToolStep[],
  renderedToolCallIds: ReadonlySet<string>,
): ToolStep[] {
  const activeById = new Map(activeTools.map((slot) => [slot.id, slot]));
  const merged: ToolStep[] = [];
  const seenIds = new Set<string>();

  for (const step of partialTools) {
    if (renderedToolCallIds.has(step.id)) continue;
    seenIds.add(step.id);
    const active = activeById.get(step.id);
    merged.push(
      active
        ? {
            ...step,
            status: active.status,
            ...(active.streamingOutput !== undefined
              ? { streamingOutput: active.streamingOutput }
              : {}),
            ...(active.diagnostics !== undefined ? { diagnostics: active.diagnostics } : {}),
          }
        : step,
    );
  }

  for (const active of activeTools) {
    if (renderedToolCallIds.has(active.id) || seenIds.has(active.id)) continue;
    seenIds.add(active.id);
    merged.push(active);
  }

  return merged;
}

export function buildDisplayItems(
  entries: readonly EntryRecordPayload[],
  live: LiveDocView,
): DisplayItem[] {
  const resultsByCallId = collectToolResults(entries);
  const liveToolsById = new Map(live.activeTools.map((slot) => [slot.id, slot]));
  const renderedToolCallIds = new Set<string>();
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
        meta: parseNoticeInfo(entry),
        ...(at ? { at } : {}),
      });
    } else if (entry.kind === "pi.user" || firstMsg?.role === "user") {
      const userParts = extractUserParts(firstMsg?.content);
      if (userParts.text.length > 0 || userParts.images.length > 0 || userParts.files.length > 0) {
        items.push({
          kind: "user",
          key: `e:${entry.id}`,
          id: entry.id,
          text: userParts.text,
          ...(userParts.images.length > 0 ? { images: userParts.images } : {}),
          ...(userParts.files.length > 0 ? { files: userParts.files } : {}),
          ...(at ? { at } : {}),
        });
      }
    } else if (entry.kind === "pi.assistant" || firstMsg?.role === "assistant") {
      const calls = extractToolCalls(firstMsg?.content);
      for (const call of calls) renderedToolCallIds.add(call.id);
      items.push(
        ...buildAssistantItems(entry, firstMsg, calls, resultsByCallId, liveToolsById, at),
      );
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
    const liveTools = mergeLiveToolSteps(live.partialTools, live.activeTools, renderedToolCallIds);
    if (liveTools.length > 0) {
      const liveById = new Map(liveTools.map((step) => [step.id, step]));
      items.push(...buildToolCallItems("live", liveTools, resultsByCallId, liveById, undefined));
    }
    if (live.partialText) {
      items.push({ kind: "assistant", key: "live:text", text: live.partialText, streaming: true });
    }
  }

  return items;
}
