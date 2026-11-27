import type { WorkerId } from "@eevee/protocol";
import { t } from "../i18n.ts";
import { isRecord } from "../object.ts";
import { type ExtractedToolCall, formatToolLabel } from "./content.ts";
import type {
  ActivityCount,
  ActivityKind,
  DiffLine,
  DispatchAction,
  DisplayItem,
  ToolStep,
} from "./types.ts";

export { formatToolLabel } from "./content.ts";

export type ToolResultRecord = {
  readonly text: string;
  readonly isError: boolean;
};

const DISPATCH_TOOLS = new Set([
  "spawn_worker",
  "message_worker",
  "stop_worker",
  "close_ticket",
  "inspect_worker",
  "ask_user",
  "message_router",
]);

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
        return t("transcript.activity.read", { count: c.count });
      case "edit":
        return t("transcript.activity.edit", { count: c.count });
      case "commands":
        return t("transcript.activity.commands", { count: c.count });
      case "memory":
        return t("transcript.activity.memory", { count: c.count });
      case "search":
        return t("transcript.activity.search", { count: c.count });
      case "scripts":
        return t("transcript.activity.scripts", { count: c.count });
      default:
        return t("transcript.activity.tools", { count: c.count });
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

function dispatchVerb(name: string, running: boolean): string {
  switch (name) {
    case "spawn_worker":
      return t(running ? "transcript.dispatch.spawn.run" : "transcript.dispatch.spawn.done");
    case "message_worker":
      return t(running ? "transcript.dispatch.message.run" : "transcript.dispatch.message.done");
    case "stop_worker":
      return t(running ? "transcript.dispatch.stop.run" : "transcript.dispatch.stop.done");
    case "close_ticket":
      return t(
        running ? "transcript.dispatch.closeTicket.run" : "transcript.dispatch.closeTicket.done",
      );
    case "inspect_worker":
      return t(running ? "transcript.dispatch.inspect.run" : "transcript.dispatch.inspect.done");
    case "ask_user":
      return t(running ? "transcript.dispatch.askUser.run" : "transcript.dispatch.askUser.done");
    case "message_router":
      return t(running ? "transcript.dispatch.report.run" : "transcript.dispatch.report.done");
    default:
      return name;
  }
}

function isStepLive(status: ToolStep["status"]): boolean {
  return (
    status === "pending" || status === "running" || status === "sleeping" || status === "waiting"
  );
}

function makeToolsItem(
  keyPrefix: string,
  suffix: string,
  steps: readonly ToolStep[],
  at: number | undefined,
): DisplayItem {
  return {
    kind: "tools",
    key: `${keyPrefix}:tools:${suffix}`,
    steps,
    live: steps.some((s) => isStepLive(s.status)),
    ...(at ? { at } : {}),
  };
}

function makeDispatchItem(
  keyPrefix: string,
  suffix: string,
  actions: readonly DispatchAction[],
  at: number | undefined,
): DisplayItem {
  return {
    kind: "dispatch",
    key: `${keyPrefix}:dispatch:${suffix}`,
    actions,
    live: actions.some((a) => a.status === "run"),
    ...(at ? { at } : {}),
  };
}

function buildDispatchAction(
  call: ExtractedToolCall,
  status: ToolStep["status"],
  result: ToolResultRecord | undefined,
): DispatchAction {
  const target =
    typeof call.arguments.name === "string"
      ? call.arguments.name
      : typeof call.arguments.workerId === "string"
        ? call.arguments.workerId
        : typeof call.arguments.ticketId === "string"
          ? call.arguments.ticketId
          : undefined;
  const workerFromArgs =
    typeof call.arguments.workerId === "string" ? (call.arguments.workerId as WorkerId) : undefined;
  const workerFromResult = result?.text.match(/\b(w\d+)\b/)?.[1] as WorkerId | undefined;
  const workerId = workerFromArgs ?? workerFromResult;
  const running = isStepLive(status);
  return {
    id: call.id,
    tool: call.name,
    verb: dispatchVerb(call.name, running),
    ...(target ? { target } : {}),
    ...(workerId ? { workerId } : {}),
    ...(result?.text ? { detail: result.text.slice(0, 260) } : {}),
    status: running ? "run" : status === "error" ? "err" : "ok",
  };
}

export function buildToolCallItems(
  scope: number | string,
  calls: readonly (ExtractedToolCall & { readonly label?: string })[],
  resultsByCallId: ReadonlyMap<string, ToolResultRecord>,
  liveToolsById: ReadonlyMap<string, ToolStep>,
  at: number | undefined,
): DisplayItem[] {
  const keyPrefix = typeof scope === "number" ? `e:${scope}` : scope;
  const items: DisplayItem[] = [];
  let genericSteps: ToolStep[] = [];
  let dispatchActions: DispatchAction[] = [];

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
      if (genericSteps.length > 0) {
        items.push(makeToolsItem(keyPrefix, call.id, genericSteps, at));
        genericSteps = [];
      }
      if (dispatchActions.length > 0) {
        items.push(makeDispatchItem(keyPrefix, call.id, dispatchActions, at));
        dispatchActions = [];
      }
      const command =
        typeof call.arguments.command === "string" ? call.arguments.command : call.name;
      items.push({
        kind: "bash",
        key: `${keyPrefix}:bash:${call.id}`,
        command,
        status: status === "done" ? "ok" : status === "error" ? "err" : "run",
        output: result?.text ?? slot?.streamingOutput ?? "",
        ...(at ? { at } : {}),
      });
      continue;
    }

    if (call.name === "edit" || call.name === "write") {
      if (genericSteps.length > 0) {
        items.push(makeToolsItem(keyPrefix, call.id, genericSteps, at));
        genericSteps = [];
      }
      if (dispatchActions.length > 0) {
        items.push(makeDispatchItem(keyPrefix, call.id, dispatchActions, at));
        dispatchActions = [];
      }
      const path = typeof call.arguments.path === "string" ? call.arguments.path : call.name;
      const { diff, added, removed } = buildEditDiff(call.name, call.arguments);
      items.push({
        kind: "edit",
        key: `${keyPrefix}:edit:${call.id}`,
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
      if (genericSteps.length > 0) {
        items.push(makeToolsItem(keyPrefix, call.id, genericSteps, at));
        genericSteps = [];
      }
      dispatchActions.push(buildDispatchAction(call, status, result));
      continue;
    }

    if (dispatchActions.length > 0) {
      items.push(makeDispatchItem(keyPrefix, call.id, dispatchActions, at));
      dispatchActions = [];
    }
    genericSteps.push({
      id: call.id,
      name: call.name,
      label: call.label ?? formatToolLabel(call.name, call.arguments),
      arguments: call.arguments,
      status,
      ...(result ? { outputText: result.text, isError: result.isError } : {}),
      ...(slot?.streamingOutput !== undefined ? { streamingOutput: slot.streamingOutput } : {}),
      ...(slot?.diagnostics ? { diagnostics: slot.diagnostics } : {}),
    });
  }

  if (genericSteps.length > 0) items.push(makeToolsItem(keyPrefix, "end", genericSteps, at));
  if (dispatchActions.length > 0) {
    items.push(makeDispatchItem(keyPrefix, "end", dispatchActions, at));
  }
  return items;
}
