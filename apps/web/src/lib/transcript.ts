import type {
  BoardViewPayload,
  ConversationViewPayload,
  EntryModelMessagePayload,
  EntryRecordPayload,
  WorkerId,
} from "@eevee/protocol";

export type DiffLine = {
  readonly id: number;
  readonly k: "ctx" | "add" | "del";
  readonly text: string;
};

export type ToolStep = {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly arguments: Record<string, unknown>;
  readonly status: "pending" | "running" | "sleeping" | "waiting" | "done" | "error";
  readonly outputText?: string;
  readonly streamingOutput?: string;
  readonly isError?: boolean;
  readonly diagnostics?: readonly { readonly severity: string; readonly message: string }[];
};

export type DispatchAction = {
  readonly id: string;
  readonly tool: string;
  readonly verb: string;
  readonly target?: string;
  readonly workerId?: WorkerId;
  readonly detail?: string;
  readonly status: "run" | "ok" | "err";
};

export type ActivityKind = "read" | "edit" | "commands" | "memory" | "search" | "scripts" | "tools";
export type ActivityCount = { readonly kind: ActivityKind; readonly count: number };

export type EditSummary = {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  readonly paths: readonly {
    readonly key: string;
    readonly path: string;
    readonly added: number;
    readonly removed: number;
  }[];
};

export type NoticeMeta = {
  readonly type: string;
  readonly workerId?: WorkerId;
  readonly workerName?: string;
  readonly ticketId?: string;
  readonly questionId?: string;
  readonly taskId?: string;
};

export type DisplayItem =
  | {
      readonly kind: "user";
      readonly key: string;
      readonly id: number;
      readonly text: string;
      readonly at?: number;
    }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly id: number;
      readonly text: string;
      readonly meta: NoticeMeta;
      readonly at?: number;
    }
  | {
      readonly kind: "thinking";
      readonly key: string;
      readonly text: string;
      readonly streaming?: boolean;
      readonly at?: number;
    }
  | {
      readonly kind: "bash";
      readonly key: string;
      readonly command: string;
      readonly status: "run" | "ok" | "err";
      readonly output: string;
      readonly at?: number;
    }
  | {
      readonly kind: "edit";
      readonly key: string;
      readonly action: "edit" | "write";
      readonly path: string;
      readonly status: "run" | "ok" | "err";
      readonly diff: readonly DiffLine[];
      readonly added: number;
      readonly removed: number;
      readonly error?: string;
      readonly at?: number;
    }
  | {
      readonly kind: "dispatch";
      readonly key: string;
      readonly actions: readonly DispatchAction[];
      readonly live: boolean;
      readonly at?: number;
    }
  | {
      readonly kind: "tools";
      readonly key: string;
      readonly steps: readonly ToolStep[];
      readonly live: boolean;
      readonly at?: number;
    }
  | {
      readonly kind: "assistant";
      readonly key: string;
      readonly text: string;
      readonly streaming?: boolean;
      readonly error?: string;
      readonly at?: number;
    }
  | {
      readonly kind: "compaction";
      readonly key: string;
      readonly summary: string;
      readonly at?: number;
    }
  | { readonly kind: "reset"; readonly key: string; readonly text: string; readonly at?: number }
  | {
      readonly kind: "worked";
      readonly key: string;
      readonly items: readonly DisplayItem[];
      readonly ms?: number;
      readonly activity: readonly ActivityCount[];
    };

export type LiveDocView = {
  readonly busy: boolean;
  readonly turns: number;
  readonly partialText: string;
  readonly partialThinking: string;
  readonly partialTools: readonly ToolStep[];
  readonly activeTools: readonly ToolStep[];
  readonly compacting: boolean;
  readonly runFailure?: { readonly reason: string; readonly detail?: string };
  readonly retryError?: string;
};

export type InboxPreview = {
  readonly id: number;
  readonly mode: "steer" | "followUp";
  readonly text: string;
};

export type ContextUsage = {
  readonly used: number;
  readonly cached: number;
};

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

const DETAIL_KEYS = [
  "path",
  "file_path",
  "command",
  "query",
  "pattern",
  "name",
  "title",
  "prompt",
  "message",
  "workerId",
  "ticketId",
  "taskId",
];

export function formatToolLabel(name: string, args: Record<string, unknown>): string {
  if (name === "read" && typeof args.path === "string") {
    const offset = typeof args.offset === "number" ? `:${args.offset}` : "";
    return `${args.path}${offset}`;
  }
  if (name === "bash" && typeof args.command === "string") return args.command;
  if ((name === "edit" || name === "write") && typeof args.path === "string") return args.path;
  for (const k of DETAIL_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) {
      const flat = v.replace(/\s+/g, " ").trim();
      return flat.length > 72 ? `${flat.slice(0, 71)}…` : flat;
    }
  }
  return name;
}

export function toolActivity(name: string): ActivityKind {
  const n = name.toLowerCase();
  if (n === "read" || n === "ls" || n === "find" || n === "grep") return "read";
  if (n === "edit" || n === "write") return "edit";
  if (n === "bash" || n === "powershell") return "commands";
  if (n === "zoom" || n === "search") return "memory";
  if (n === "tool_search") return "search";
  if (n === "codemode") return "scripts";
  return "tools";
}

export function activitySummary(counts: readonly ActivityCount[]): string {
  const sorted = [...counts].sort((a, b) => b.count - a.count);
  const parts = sorted.slice(0, 3).map((c) => {
    switch (c.kind) {
      case "read":
        return `读取 ${c.count} 处`;
      case "edit":
        return `编辑 ${c.count} 次`;
      case "commands":
        return `命令 ${c.count} 次`;
      case "memory":
        return `记忆 ${c.count} 次`;
      case "search":
        return `搜索工具 ${c.count} 次`;
      case "scripts":
        return `脚本 ${c.count} 次`;
      default:
        return `工具 ${c.count} 次`;
    }
  });
  return parts.join(" · ");
}

function buildEditDiff(
  action: "edit" | "write",
  args: Record<string, unknown>,
): { diff: DiffLine[]; added: number; removed: number } {
  const diff: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let nextLine = 1;
  if (action === "write") {
    const content = typeof args.content === "string" ? args.content : "";
    const lines = content ? content.split(/\r?\n/) : [];
    added = lines.length;
    for (const line of lines.slice(0, 120)) diff.push({ id: nextLine++, k: "add", text: line });
    return { diff, added, removed };
  }
  const edits = Array.isArray(args.edits)
    ? args.edits
    : typeof args.oldText === "string" || typeof args.newText === "string"
      ? [{ oldText: args.oldText, newText: args.newText }]
      : [];
  for (const edit of edits) {
    if (!isRecord(edit)) continue;
    const oldLines =
      typeof edit.oldText === "string" && edit.oldText.length > 0
        ? edit.oldText.split(/\r?\n/)
        : [];
    const newLines =
      typeof edit.newText === "string" && edit.newText.length > 0
        ? edit.newText.split(/\r?\n/)
        : [];
    removed += oldLines.length;
    added += newLines.length;
    for (const l of oldLines.slice(0, 60)) diff.push({ id: nextLine++, k: "del", text: l });
    for (const l of newLines.slice(0, 60)) diff.push({ id: nextLine++, k: "add", text: l });
  }
  return { diff, added, removed };
}

const DISPATCH_TOOLS = new Set([
  "spawn_worker",
  "message_worker",
  "stop_worker",
  "close_ticket",
  "inspect_worker",
  "ask_user",
  "message_router",
]);

function dispatchVerb(name: string, running: boolean): string {
  switch (name) {
    case "spawn_worker":
      return running ? "正在派出 Worker" : "派出 Worker";
    case "message_worker":
      return running ? "正在通知 Worker" : "发消息给 Worker";
    case "stop_worker":
      return running ? "正在停止 Worker" : "停止 Worker";
    case "close_ticket":
      return running ? "正在关闭 Ticket" : "关闭 Ticket";
    case "inspect_worker":
      return running ? "正在查看 Worker" : "查看 Worker";
    case "ask_user":
      return running ? "正在发起提问" : "向你提问";
    case "message_router":
      return running ? "正在汇报 Router" : "汇报给 Router";
    default:
      return name;
  }
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

  const partialTools: ToolStep[] = extractToolCalls(partialMsg?.content).map((call) => ({
    ...call,
    label: formatToolLabel(call.name, call.arguments),
    status: "pending",
  }));

  const activeTools: ToolStep[] = [];
  if (Array.isArray(raw.tools)) {
    for (const slot of raw.tools) {
      if (!isRecord(slot) || typeof slot.callId !== "string" || typeof slot.name !== "string")
        continue;
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
        label: slot.name,
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
    if (item.mode === "write") continue;
    result.push({
      id: item.id,
      mode: item.mode === "steer" ? "steer" : "followUp",
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

export function lastContextUsage(entries: readonly EntryRecordPayload[]): ContextUsage | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.kind !== "pi.assistant") continue;
    const msg = entry.model?.[0] as Record<string, unknown> | undefined;
    const usage = msg && isRecord(msg.usage) ? msg.usage : undefined;
    if (!usage) continue;
    const input = typeof usage.input === "number" ? usage.input : 0;
    const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
    if (input > 0 || cacheRead > 0) {
      return { used: input + cacheRead, cached: cacheRead };
    }
  }
  return undefined;
}

function extractTimestamp(
  msg: EntryModelMessagePayload | undefined,
  fallback?: number,
): number | undefined {
  const ts = (msg as Record<string, unknown> | undefined)?.timestamp;
  if (typeof ts === "number" && ts > 0) return ts;
  return fallback;
}

function isStepLive(status: ToolStep["status"]): boolean {
  return (
    status === "pending" || status === "running" || status === "sleeping" || status === "waiting"
  );
}

export function buildDisplayItems(
  entries: readonly EntryRecordPayload[],
  live: LiveDocView,
): DisplayItem[] {
  const resultsByCallId = new Map<string, { text: string; isError: boolean }>();
  for (const entry of entries) {
    if (entry.kind !== "pi.tool-result" && !entry.model?.some((m) => m.role === "toolResult"))
      continue;
    for (const msg of entry.model ?? []) {
      if (msg.role !== "toolResult") continue;
      const callId = (msg as Record<string, unknown>).toolCallId;
      if (typeof callId !== "string") continue;
      resultsByCallId.set(callId, {
        text: extractText(msg.content),
        isError: msg.isError === true,
      });
    }
  }

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
      continue;
    }
    if (entry.kind === "pi.reset") {
      items.push({
        kind: "reset",
        key: `e:${entry.id}`,
        text: extractText(firstMsg?.content),
        ...(at ? { at } : {}),
      });
      continue;
    }
    if (entry.kind === "eevee.notice" || entry.kind === "eevee.task-notification") {
      const data = isRecord(entry.data) ? entry.data : {};
      items.push({
        kind: "notice",
        key: `e:${entry.id}`,
        id: entry.id,
        text: extractText(firstMsg?.content),
        ...(at ? { at } : {}),
        meta: {
          type:
            typeof data.type === "string"
              ? data.type
              : entry.kind === "eevee.task-notification"
                ? "task_notification"
                : "notice",
          ...(typeof data.workerId === "string" ? { workerId: data.workerId as WorkerId } : {}),
          ...(typeof data.workerName === "string" ? { workerName: data.workerName } : {}),
          ...(typeof data.ticketId === "string" ? { ticketId: data.ticketId } : {}),
          ...(typeof data.questionId === "string" ? { questionId: data.questionId } : {}),
          ...(typeof data.taskId === "string" ? { taskId: data.taskId } : {}),
        },
      });
      continue;
    }
    if (entry.kind === "pi.user" || firstMsg?.role === "user") {
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
      continue;
    }

    if (entry.kind === "pi.assistant" || firstMsg?.role === "assistant") {
      const thinking = extractThinking(firstMsg?.content);
      if (thinking) {
        items.push({
          kind: "thinking",
          key: `e:${entry.id}:think`,
          text: thinking,
          ...(at ? { at } : {}),
        });
      }

      const calls = extractToolCalls(firstMsg?.content);
      const genericSteps: ToolStep[] = [];
      const dispatchActions: DispatchAction[] = [];

      const flushGeneric = (suffix: string) => {
        if (genericSteps.length === 0) return;
        items.push({
          kind: "tools",
          key: `e:${entry.id}:tools:${suffix}`,
          steps: [...genericSteps],
          live: genericSteps.some((s) => isStepLive(s.status)),
          ...(at ? { at } : {}),
        });
        genericSteps.length = 0;
      };

      const flushDispatch = (suffix: string) => {
        if (dispatchActions.length === 0) return;
        items.push({
          kind: "dispatch",
          key: `e:${entry.id}:dispatch:${suffix}`,
          actions: [...dispatchActions],
          live: dispatchActions.some((a) => a.status === "run"),
          ...(at ? { at } : {}),
        });
        dispatchActions.length = 0;
      };

      for (const call of calls) {
        const result = resultsByCallId.get(call.id);
        const slot = liveToolsById.get(call.id);
        const status: ToolStep["status"] = result
          ? result.isError
            ? "error"
            : "done"
          : slot
            ? slot.status
            : "pending";

        if (call.name === "bash" || call.name === "powershell") {
          flushGeneric(call.id);
          flushDispatch(call.id);
          const command =
            typeof call.arguments.command === "string" ? call.arguments.command : call.name;
          items.push({
            kind: "bash",
            key: `e:${entry.id}:bash:${call.id}`,
            command,
            status: status === "done" ? "ok" : status === "error" ? "err" : "run",
            output: result?.text ?? slot?.streamingOutput ?? "",
            ...(at ? { at } : {}),
          });
          continue;
        }

        if (call.name === "edit" || call.name === "write") {
          flushGeneric(call.id);
          flushDispatch(call.id);
          const path = typeof call.arguments.path === "string" ? call.arguments.path : call.name;
          const { diff, added, removed } = buildEditDiff(call.name, call.arguments);
          items.push({
            kind: "edit",
            key: `e:${entry.id}:edit:${call.id}`,
            action: call.name,
            path,
            status: status === "done" ? "ok" : status === "error" ? "err" : "run",
            diff,
            added,
            removed,
            ...(result?.isError ? { error: result.text } : {}),
            ...(at ? { at } : {}),
          });
          continue;
        }

        if (DISPATCH_TOOLS.has(call.name)) {
          flushGeneric(call.id);
          const target =
            typeof call.arguments.name === "string"
              ? call.arguments.name
              : typeof call.arguments.workerId === "string"
                ? call.arguments.workerId
                : typeof call.arguments.ticketId === "string"
                  ? call.arguments.ticketId
                  : undefined;
          const workerFromArgs =
            typeof call.arguments.workerId === "string"
              ? (call.arguments.workerId as WorkerId)
              : undefined;
          const workerFromResult = result?.text.match(/\b(w\d+)\b/)?.[1] as WorkerId | undefined;
          const running = isStepLive(status);
          dispatchActions.push({
            id: call.id,
            tool: call.name,
            verb: dispatchVerb(call.name, running),
            ...(target ? { target } : {}),
            ...((workerFromArgs ?? workerFromResult)
              ? { workerId: workerFromArgs ?? workerFromResult }
              : {}),
            ...(result?.text ? { detail: result.text.slice(0, 260) } : {}),
            status: running ? "run" : status === "error" ? "err" : "ok",
          });
          continue;
        }

        flushDispatch(call.id);
        genericSteps.push({
          id: call.id,
          name: call.name,
          label: formatToolLabel(call.name, call.arguments),
          arguments: call.arguments,
          status,
          ...(result ? { outputText: result.text, isError: result.isError } : {}),
          ...(slot?.streamingOutput ? { streamingOutput: slot.streamingOutput } : {}),
          ...(slot?.diagnostics ? { diagnostics: slot.diagnostics } : {}),
        });
      }

      flushGeneric("end");
      flushDispatch("end");

      const text = extractText(firstMsg?.content);
      const error =
        firstMsg?.stopReason === "error" || firstMsg?.stopReason === "aborted"
          ? firstMsg.errorMessage || firstMsg.stopReason
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

const INBOUND = new Set<DisplayItem["kind"]>(["user", "notice"]);
const STANDALONE = new Set<DisplayItem["kind"]>(["compaction", "reset", "worked"]);
const VISIBLE_CLOSED = new Set<DisplayItem["kind"]>(["assistant", "dispatch"]);

const isTurnBody = (item: DisplayItem): boolean =>
  !INBOUND.has(item.kind) && !STANDALONE.has(item.kind);

const isWork = (item: DisplayItem): boolean => !VISIBLE_CLOSED.has(item.kind);

const isLiveItem = (item: DisplayItem): boolean => {
  if (item.kind === "assistant" || item.kind === "thinking") return item.streaming === true;
  if (item.kind === "tools" || item.kind === "dispatch") return item.live;
  if (item.kind === "bash" || item.kind === "edit") return item.status === "run";
  return false;
};

export function countWork(items: readonly DisplayItem[]): ActivityCount[] {
  const counts = new Map<ActivityKind, number>();
  const bump = (k: ActivityKind) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const item of items) {
    if (item.kind === "tools") {
      for (const s of item.steps) bump(toolActivity(s.name));
    } else if (item.kind === "edit") {
      bump("edit");
    } else if (item.kind === "bash") {
      bump("commands");
    }
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

export function editSummary(items: readonly DisplayItem[]): EditSummary | undefined {
  const merged = new Map<string, { key: string; added: number; removed: number }>();
  for (const item of items) {
    if (item.kind !== "edit" || item.status !== "ok") continue;
    const cur = merged.get(item.path) ?? { key: item.key, added: 0, removed: 0 };
    cur.added += item.added;
    cur.removed += item.removed;
    merged.set(item.path, cur);
  }
  if (merged.size === 0) return undefined;
  let added = 0;
  let removed = 0;
  for (const v of merged.values()) {
    added += v.added;
    removed += v.removed;
  }
  return {
    files: merged.size,
    added,
    removed,
    paths: [...merged.entries()].map(([path, v]) => ({ path, ...v })),
  };
}

export function closedWorkedItems(worked: Extract<DisplayItem, { kind: "worked" }>): DisplayItem[] {
  return worked.items.filter((child) => !isWork(child));
}

export function foldTurns(items: readonly DisplayItem[], liveBusy: boolean): DisplayItem[] {
  const out: DisplayItem[] = [];
  let turn: DisplayItem[] = [];
  let boundaryAt: number | undefined;

  const flush = (mayFold: boolean) => {
    if (turn.length === 0) return;
    const hasWork = turn.some(isWork);
    const hasReply = turn.some((i) => i.kind === "assistant" && i.text.trim().length > 0);
    if (mayFold && hasWork && hasReply && !turn.some(isLiveItem)) {
      let latestAt: number | undefined;
      for (const i of turn) {
        if ("at" in i && typeof i.at === "number" && (latestAt === undefined || i.at > latestAt)) {
          latestAt = i.at;
        }
      }
      const ms =
        boundaryAt !== undefined && latestAt !== undefined && latestAt > boundaryAt
          ? latestAt - boundaryAt
          : undefined;
      out.push({
        kind: "worked",
        key: `worked:${turn[0]?.key ?? out.length}`,
        items: turn,
        ...(ms !== undefined ? { ms } : {}),
        activity: countWork(turn),
      });
      turn = [];
      return;
    }
    out.push(...turn);
    turn = [];
  };

  for (const item of items) {
    if (isTurnBody(item)) {
      turn.push(item);
      continue;
    }
    flush(true);
    out.push(item);
    boundaryAt = "at" in item && typeof item.at === "number" ? item.at : undefined;
  }
  flush(!liveBusy);
  return out;
}

export type OutlineEntry = {
  readonly key: string;
  readonly text: string;
  readonly reply?: string;
  readonly at?: number;
};

export function outlineEntries(items: readonly DisplayItem[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  let current: { key: string; text: string; reply?: string; at?: number } | undefined;
  for (const item of items) {
    if (item.kind === "user") {
      const first = item.text.trim().split("\n", 1)[0]?.trim() ?? "";
      const text = first.length > 72 ? `${first.slice(0, 71)}…` : first;
      current = { key: item.key, text, ...(item.at ? { at: item.at } : {}) };
      out.push(current);
      continue;
    }
    const reply =
      item.kind === "assistant"
        ? item.text
        : item.kind === "worked"
          ? item.items.findLast((c) => c.kind === "assistant")?.text
          : undefined;
    if (reply && current) {
      const flat = reply.replace(/\s+/g, " ").trim();
      if (flat) current.reply = flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
    }
  }
  return out;
}

export function itemSearchText(item: DisplayItem): string {
  switch (item.kind) {
    case "user":
    case "notice":
    case "thinking":
    case "assistant":
    case "reset":
      return item.text;
    case "compaction":
      return item.summary;
    case "bash":
      return `${item.command}\n${item.output}`;
    case "edit":
      return `${item.path}\n${item.diff.map((d) => d.text).join("\n")}`;
    case "dispatch":
      return item.actions.map((a) => `${a.verb} ${a.target ?? ""} ${a.detail ?? ""}`).join("\n");
    case "tools":
      return item.steps.map((s) => `${s.name} ${s.label} ${s.outputText ?? ""}`).join("\n");
    case "worked":
      return item.items.map(itemSearchText).join("\n");
  }
}

export type FindMatch = { readonly key: string; readonly hits: number };

export function findMatches(items: readonly DisplayItem[], query: string): FindMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: FindMatch[] = [];
  for (const item of items) {
    const text = itemSearchText(item).toLowerCase();
    let hits = 0;
    let idx = text.indexOf(needle);
    while (idx !== -1) {
      hits += 1;
      idx = text.indexOf(needle, idx + needle.length);
    }
    if (hits > 0) matches.push({ key: item.key, hits });
  }
  return matches;
}

export type VisualStage = "answer" | "blocked" | "working" | "queued" | "idle" | "done";

export function deriveBoardSummary(board: BoardViewPayload | undefined): {
  readonly stage: VisualStage;
  readonly pendingQuestions: number;
  readonly activeWorkers: number;
  readonly runningTasks: number;
  readonly openTickets: number;
} {
  if (!board) {
    return {
      stage: "idle",
      pendingQuestions: 0,
      activeWorkers: 0,
      runningTasks: 0,
      openTickets: 0,
    };
  }
  const pendingQuestions = board.questions.filter(
    (q) => q.answeredAt === undefined && q.withdrawnAt === undefined,
  ).length;
  const activeWorkers = board.workers.filter(
    (w) => w.status === "running" || w.status === "queued",
  ).length;
  const runningTasks = board.workers.reduce((sum, w) => sum + w.activeTaskCount, 0);
  const openTickets = board.tickets.filter((t) => t.status === "open").length;
  const stage: VisualStage =
    pendingQuestions > 0
      ? "answer"
      : activeWorkers > 0 || runningTasks > 0
        ? "working"
        : board.workers.some((w) => w.status === "idle")
          ? "idle"
          : "idle";
  return { stage, pendingQuestions, activeWorkers, runningTasks, openTickets };
}
