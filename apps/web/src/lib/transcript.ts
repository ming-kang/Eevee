import type {
  ConversationViewPayload,
  EntryModelMessagePayload,
  EntryRecordPayload,
} from "@eevee/protocol";

export type ToolCallBlock = {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly status: "pending" | "running" | "sleeping" | "waiting" | "done" | "error";
  readonly outputText?: string;
  readonly isError?: boolean;
  readonly streamingOutput?: string;
  readonly diagnostics?: readonly { readonly severity: string; readonly message: string }[];
};

export type LiveDocView = {
  readonly busy: boolean;
  readonly turns: number;
  readonly partialText: string;
  readonly partialThinking: string;
  readonly partialTools: readonly ToolCallBlock[];
  readonly activeTools: readonly ToolCallBlock[];
  readonly compacting: boolean;
  readonly runFailure?: { readonly reason: string; readonly detail?: string };
  readonly retryError?: string;
};

export type InboxPreview = {
  readonly id: number;
  readonly mode: "steer" | "followUp" | "write";
  readonly text: string;
};

export type NoticeMeta = {
  readonly type: string;
  readonly workerId?: string;
  readonly workerName?: string;
  readonly ticketId?: string;
  readonly questionId?: string;
  readonly taskId?: string;
  readonly reason?: string;
};

export type TranscriptItem =
  | { readonly kind: "user"; readonly id: number; readonly text: string }
  | {
      readonly kind: "notice";
      readonly id: number;
      readonly text: string;
      readonly meta: NoticeMeta;
    }
  | {
      readonly kind: "assistant";
      readonly id: number;
      readonly text: string;
      readonly thinking: string;
      readonly tools: readonly ToolCallBlock[];
      readonly error?: string;
    }
  | { readonly kind: "compaction"; readonly id: number; readonly summary: string }
  | { readonly kind: "reset"; readonly id: number; readonly text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (isRecord(block) && block.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    }
  }
  return parts.join("\n\n");
}

function extractToolCalls(content: unknown): {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}[] {
  if (!Array.isArray(content)) return [];
  const calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "toolCall" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      calls.push({
        id: block.id,
        name: block.name,
        arguments: isRecord(block.arguments) ? block.arguments : {},
      });
    }
  }
  return calls;
}

export function parseLiveDoc(view: ConversationViewPayload | undefined): LiveDocView {
  const raw = view?.docs?.["pi.live"];
  if (!isRecord(raw)) {
    return {
      busy: false,
      turns: 0,
      partialText: "",
      partialThinking: "",
      partialTools: [],
      activeTools: [],
      compacting: false,
    };
  }

  const run = isRecord(raw.run) ? raw.run : undefined;
  const generation = isRecord(raw.generation) ? raw.generation : undefined;
  const partialMsg = isRecord(generation?.message) ? generation.message : undefined;
  const retry = isRecord(generation?.retry) ? generation.retry : undefined;
  const runFailureRaw = isRecord(raw.runFailure) ? raw.runFailure : undefined;

  const partialTools: ToolCallBlock[] = extractToolCalls(partialMsg?.content).map((call) => ({
    ...call,
    status: "pending",
  }));

  const activeTools: ToolCallBlock[] = [];
  if (Array.isArray(raw.tools)) {
    for (const slot of raw.tools) {
      if (!isRecord(slot) || typeof slot.callId !== "string" || typeof slot.name !== "string") {
        continue;
      }
      const status =
        slot.status === "pending" ||
        slot.status === "running" ||
        slot.status === "sleeping" ||
        slot.status === "waiting" ||
        slot.status === "done"
          ? slot.status
          : "running";
      const diagnostics = Array.isArray(slot.diagnostics)
        ? slot.diagnostics
            .filter(
              (d): d is Record<string, unknown> => isRecord(d) && typeof d.message === "string",
            )
            .map((d) => ({
              severity: typeof d.severity === "string" ? d.severity : "info",
              message: String(d.message),
            }))
        : undefined;
      activeTools.push({
        id: slot.callId,
        name: slot.name,
        arguments: {},
        status,
        ...(typeof slot.output === "string" ? { streamingOutput: slot.output } : {}),
        ...(diagnostics && diagnostics.length > 0 ? { diagnostics } : {}),
      });
    }
  }

  return {
    busy: run !== undefined,
    turns: typeof run?.turns === "number" ? run.turns : 0,
    partialText: extractText(partialMsg?.content),
    partialThinking: extractThinking(partialMsg?.content),
    partialTools,
    activeTools,
    compacting: Array.isArray(raw.compactions) && raw.compactions.length > 0,
    ...(runFailureRaw && typeof runFailureRaw.reason === "string"
      ? {
          runFailure: {
            reason: runFailureRaw.reason,
            ...(typeof runFailureRaw.detail === "string" ? { detail: runFailureRaw.detail } : {}),
          },
        }
      : {}),
    ...(retry && typeof retry.error === "string" ? { retryError: retry.error } : {}),
  };
}

export function parseInbox(view: ConversationViewPayload | undefined): InboxPreview[] {
  const raw = view?.docs?.["pi.inbox"];
  if (!isRecord(raw) || !Array.isArray(raw.items)) return [];
  const result: InboxPreview[] = [];
  for (const item of raw.items) {
    if (!isRecord(item) || typeof item.id !== "number") continue;
    const mode =
      item.mode === "steer" || item.mode === "followUp" || item.mode === "write"
        ? item.mode
        : "followUp";
    if (mode === "write") continue;
    result.push({
      id: item.id,
      mode,
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
  const raw = view?.docs?.["pi.agent"];
  if (!isRecord(raw)) return {};
  const model = isRecord(raw.model) ? raw.model : undefined;
  const modelLabel =
    model && typeof model.provider === "string" && typeof model.modelId === "string"
      ? `${model.provider}/${model.modelId}`
      : undefined;
  return {
    ...(modelLabel ? { modelLabel } : {}),
    ...(typeof raw.thinkingLevel === "string" ? { thinkingLevel: raw.thinkingLevel } : {}),
    ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
  };
}

export function buildTranscriptItems(
  entries: readonly EntryRecordPayload[],
  live: LiveDocView,
): TranscriptItem[] {
  const toolResultsByCallId = new Map<
    string,
    { readonly text: string; readonly isError: boolean }
  >();
  for (const entry of entries) {
    if (entry.kind !== "pi.tool-result" && !entry.model?.some((m) => m.role === "toolResult")) {
      continue;
    }
    for (const msg of entry.model ?? []) {
      if (msg.role !== "toolResult") continue;
      const callId = (msg as Record<string, unknown>).toolCallId;
      if (typeof callId !== "string") continue;
      toolResultsByCallId.set(callId, {
        text: extractText(msg.content),
        isError: msg.isError === true,
      });
    }
  }

  const liveToolsByCallId = new Map(live.activeTools.map((slot) => [slot.id, slot]));
  const items: TranscriptItem[] = [];

  for (const entry of entries) {
    if (entry.kind === "pi.system" || entry.kind === "pi.tool-result") continue;

    if (entry.kind === "pi.compaction") {
      const msg = entry.model?.[0];
      items.push({
        kind: "compaction",
        id: entry.id,
        summary: extractText(msg?.content),
      });
      continue;
    }

    if (entry.kind === "pi.reset") {
      const msg = entry.model?.[0];
      items.push({
        kind: "reset",
        id: entry.id,
        text: extractText(msg?.content),
      });
      continue;
    }

    if (entry.kind === "eevee.notice" || entry.kind === "eevee.task-notification") {
      const data = isRecord(entry.data) ? entry.data : {};
      const msg = entry.model?.[0];
      items.push({
        kind: "notice",
        id: entry.id,
        text: extractText(msg?.content),
        meta: {
          type:
            typeof data.type === "string"
              ? data.type
              : entry.kind === "eevee.task-notification"
                ? "task_notification"
                : "notice",
          ...(typeof data.workerId === "string" ? { workerId: data.workerId } : {}),
          ...(typeof data.workerName === "string" ? { workerName: data.workerName } : {}),
          ...(typeof data.ticketId === "string" ? { ticketId: data.ticketId } : {}),
          ...(typeof data.questionId === "string" ? { questionId: data.questionId } : {}),
          ...(typeof data.taskId === "string" ? { taskId: data.taskId } : {}),
          ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
        },
      });
      continue;
    }

    const firstMsg: EntryModelMessagePayload | undefined = entry.model?.[0];
    if (entry.kind === "pi.user" || firstMsg?.role === "user") {
      const text = extractText(firstMsg?.content);
      if (text.length > 0) {
        items.push({ kind: "user", id: entry.id, text });
      }
      continue;
    }

    if (entry.kind === "pi.assistant" || firstMsg?.role === "assistant") {
      const text = extractText(firstMsg?.content);
      const thinking = extractThinking(firstMsg?.content);
      const calls = extractToolCalls(firstMsg?.content).map((call): ToolCallBlock => {
        const result = toolResultsByCallId.get(call.id);
        if (result !== undefined) {
          return {
            ...call,
            status: result.isError ? "error" : "done",
            outputText: result.text,
            isError: result.isError,
          };
        }
        const liveSlot = liveToolsByCallId.get(call.id);
        if (liveSlot !== undefined) {
          return {
            ...call,
            status: liveSlot.status,
            ...(liveSlot.streamingOutput === undefined
              ? {}
              : { streamingOutput: liveSlot.streamingOutput }),
            ...(liveSlot.diagnostics === undefined ? {} : { diagnostics: liveSlot.diagnostics }),
          };
        }
        return { ...call, status: "pending" };
      });
      const error =
        firstMsg?.stopReason === "error" || firstMsg?.stopReason === "aborted"
          ? firstMsg.errorMessage || firstMsg.stopReason
          : undefined;
      if (text.length === 0 && thinking.length === 0 && calls.length === 0 && !error) continue;
      items.push({
        kind: "assistant",
        id: entry.id,
        text,
        thinking,
        tools: calls,
        ...(error === undefined ? {} : { error }),
      });
    }
  }

  return items;
}
