import {
  type ConversationViewPayload,
  type EntryRecordPayload,
  parseAgentDocPayload,
  parseInboxDocPayload,
  parseLiveDocPayload,
} from "@eevee/protocol";
import { extractText, extractThinking, extractToolCalls, formatToolLabel } from "./content.ts";
import type { ContextUsage, InboxPreview, LiveDocView, ToolStep } from "./types.ts";

export { extractText } from "./content.ts";

const EMPTY_LIVE_DOC: LiveDocView = {
  busy: false,
  turns: 0,
  partialText: "",
  partialThinking: "",
  partialTools: [],
  activeTools: [],
  compacting: false,
};

export function parseLiveDoc(view: ConversationViewPayload | undefined): LiveDocView {
  const doc = parseLiveDocPayload(view?.docs?.["pi.live"]);
  if (!doc) return EMPTY_LIVE_DOC;

  const partialContent = doc.generation?.message?.content;
  const partialTools: ToolStep[] = extractToolCalls(partialContent).map((call) => ({
    ...call,
    label: formatToolLabel(call.name, call.arguments),
    status: "pending",
  }));

  const activeTools: ToolStep[] = (doc.tools ?? []).map((slot) => ({
    id: slot.callId,
    name: slot.name,
    label: slot.name,
    arguments: {},
    status: slot.status,
    ...(slot.output !== undefined ? { streamingOutput: slot.output } : {}),
    ...(slot.diagnostics && slot.diagnostics.length > 0
      ? {
          diagnostics: slot.diagnostics.map((d) => ({
            severity: d.severity,
            message: d.message,
          })),
        }
      : {}),
  }));

  return {
    busy: doc.run !== undefined,
    turns: doc.run?.turns ?? 0,
    partialText: extractText(partialContent),
    partialThinking: extractThinking(partialContent),
    partialTools,
    activeTools,
    compacting: (doc.compactions?.length ?? 0) > 0,
    ...(doc.runFailure
      ? {
          runFailure: {
            reason: doc.runFailure.reason,
            ...(doc.runFailure.detail !== undefined ? { detail: doc.runFailure.detail } : {}),
          },
        }
      : {}),
    ...(doc.generation?.retry ? { retryError: doc.generation.retry.error } : {}),
  };
}

export function parseInbox(view: ConversationViewPayload | undefined): InboxPreview[] {
  const doc = parseInboxDocPayload(view?.docs?.["pi.inbox"]);
  if (!doc?.items) return [];
  const result: InboxPreview[] = [];
  for (const item of doc.items) {
    if (item.mode === "write") continue;
    result.push({
      id: item.id,
      mode: item.mode,
      text: extractText(item.content),
    });
  }
  return result;
}

export function parseAgentDoc(view: ConversationViewPayload | undefined): {
  readonly modelLabel?: string;
  readonly thinkingLevel?: string;
  readonly cwd?: string;
} {
  const doc = parseAgentDocPayload(view?.docs?.["pi.agent"]);
  if (!doc) return {};
  return {
    ...(doc.model ? { modelLabel: `${doc.model.provider}/${doc.model.modelId}` } : {}),
    ...(doc.thinkingLevel !== undefined ? { thinkingLevel: doc.thinkingLevel } : {}),
    ...(doc.cwd !== undefined ? { cwd: doc.cwd } : {}),
  };
}

export function lastContextUsage(entries: readonly EntryRecordPayload[]): ContextUsage | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.kind !== "pi.assistant") continue;
    const usage = entry.model?.[0]?.usage;
    if (!usage) continue;
    const input = usage.input ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    if (input > 0 || cacheRead > 0) {
      return { used: input + cacheRead, cached: cacheRead };
    }
  }
  return undefined;
}
