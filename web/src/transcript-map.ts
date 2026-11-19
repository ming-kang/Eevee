import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type EntryRecord,
  type InboxState,
  type LiveState,
  ResetEntry,
  ToolResultEntry,
  type ToolSlot,
  type TranscriptItem,
  UserEntry,
} from "@earendil-works/pi-durable";
import {
  type AskDetails,
  type BashDetails,
  isDeliberateEnd,
  type NoticeData,
  type Report,
  type ReportStatus,
  type TicketDetails,
  type TicketId,
  type TicketStage,
  type TicketStatus,
} from "../../src/contracts/index.ts";
import type { GapItem } from "./conversation.ts";
import { t } from "./i18n.ts";
import { failureText, jobStatusText, reportSummary } from "./labels.ts";

export type DiffLine = {
  k: "ctx" | "add" | "del" | "hunk";
  n: string;
  s: string;
};

export type ToolStepItem = {
  id: string;
  tool: string;
  label: string;
  status: "ok" | "err" | "run";
  ms?: number;
  output?: string;
};

export type DispatchActionKind =
  | "create"
  | "ask"
  | "accept"
  | "rework"
  | "message"
  | "interrupt"
  | "close"
  | "model";

export type DispatchAction = {
  id: string;
  kind: DispatchActionKind;
  ticketId?: string;
  questionId?: string;
  title: string;
  detail?: string;
  status: "ok" | "err" | "run";
};

export type EventKind = "report" | "answer" | "intervene" | "deliver" | "job" | "notice";

/** What a folded turn reports: tool steps, commands, files edited and tickets dispatched. */
export type WorkedCounts = {
  tools: number;
  commands: number;
  files: number;
  dispatched: number;
};

export type TranscriptDisplayItem =
  | { kind: "more"; key: string }
  | { kind: "gap"; key: string; gap: GapItem }
  | { kind: "reset"; key: string; at?: number; summary: string }
  | { kind: "opening"; key: string; text: string }
  | {
      kind: "user";
      key: string;
      text: string;
      at?: number;
      /** Sent but still in the inbox, waiting for the next boundary to place it. */
      pending?: true;
    }
  | { kind: "assistant"; key: string; text: string; at?: number; streaming?: boolean }
  | { kind: "tools"; key: string; live: boolean; steps: ToolStepItem[] }
  | { kind: "dispatch"; key: string; live: boolean; actions: DispatchAction[] }
  | {
      kind: "event";
      key: string;
      eventKind: EventKind;
      ticketId?: string;
      questionId?: string;
      jobId?: string;
      status?: ReportStatus;
      text: string;
      detail?: string;
      at?: number;
    }
  | {
      kind: "edit";
      key: string;
      action: "edit" | "write";
      path: string;
      status: "ok" | "err" | "run";
      diff: DiffLine[];
      added: number;
      removed: number;
      error?: string;
      ms?: number;
    }
  | {
      kind: "bash";
      key: string;
      command: string;
      status: "run" | "exit" | "stopped" | "job";
      output: string;
      exitCode?: number;
      ms?: number;
      jobId?: string;
      at?: number;
    }
  | {
      kind: "report";
      key: string;
      report: Report;
    }
  | { kind: "qa"; key: string; questionId?: string; question: string; answer: string; at?: number }
  | { kind: "failure"; key: string; reason: string; text: string }
  | { kind: "idle"; key: string; text: string }
  | {
      /** A finished turn's folded work; `items` holds the lines it hides until expanded. */
      kind: "worked";
      key: string;
      items: TranscriptDisplayItem[];
      ms?: number;
      counts: WorkedCounts;
    };

type EventItem = Extract<TranscriptDisplayItem, { kind: "event" }>;
type EventFields = Partial<
  Pick<EventItem, "ticketId" | "questionId" | "jobId" | "status" | "detail">
>;

/** A tool result's `details`, for the fields a tool documents in `src/contracts/details.ts`. */
const detailsOf = <T>(result: ToolResultMessage | undefined): Partial<T> =>
  (result?.details ?? {}) as Partial<T>;

const NOTICE_KIND = "eevee.notice";

type MapTranscriptOptions = {
  mode: "router" | "worker";
  live?: LiveState;
  ticketId?: TicketId;
  reports?: readonly Report[];
  ticketStatus?: TicketStatus;
  ticketStage?: TicketStage;
  inbox?: InboxState;
};

export function mapTranscript(
  items: readonly TranscriptItem[],
  options: MapTranscriptOptions,
): TranscriptDisplayItem[] {
  const resultsByCallId = new Map<string, ToolResultMessage>();
  const liveSlotByCallId = new Map<string, ToolSlot>();
  for (const slot of options.live?.tools ?? []) {
    liveSlotByCallId.set(slot.callId, slot);
  }

  for (const item of items) {
    if (item.kind !== "entry" || !ToolResultEntry.is(item.entry)) continue;
    for (const msg of (item.entry.model ?? []) as readonly ToolResultMessage[]) {
      if (msg.role === "toolResult" && msg.toolCallId) {
        resultsByCallId.set(msg.toolCallId, msg);
      }
    }
  }

  const pairedCallIds = new Set<string>();
  const out: TranscriptDisplayItem[] = [];
  let sawResetOrOpening = false;
  let reportOrdinal = 0;

  const pushTools = (key: string, steps: ToolStepItem[]) => {
    if (steps.length === 0) return;
    const prev = out.at(-1);
    if (prev?.kind === "tools") {
      prev.steps.push(...steps);
      prev.live = prev.live || steps.some((s) => s.status === "run");
      return;
    }
    out.push({
      kind: "tools",
      key,
      live: steps.some((s) => s.status === "run"),
      steps,
    });
  };

  const pushDispatch = (key: string, actions: DispatchAction[]) => {
    if (actions.length === 0) return;
    const prev = out.at(-1);
    if (prev?.kind === "dispatch") {
      prev.actions.push(...actions);
      prev.live = prev.live || actions.some((a) => a.status === "run");
      return;
    }
    out.push({
      kind: "dispatch",
      key,
      live: actions.some((a) => a.status === "run"),
      actions,
    });
  };

  for (const item of items) {
    if (item.kind === "earlier") {
      out.push({ kind: "more", key: "earlier" });
      continue;
    }
    if (item.kind === "gap") {
      out.push({ kind: "gap", key: `gap:${item.after}:${item.upTo}`, gap: item });
      continue;
    }

    const entry = item.entry;
    if (ResetEntry.is(entry)) {
      const mapped = mapReset(entry, options.mode, sawResetOrOpening);
      sawResetOrOpening = true;
      if (mapped) out.push(mapped);
      continue;
    }

    if (UserEntry.is(entry)) {
      const { text, at } = extractTextAndTime(entry);
      if (text !== "") {
        out.push({
          kind: "user",
          key: `e:${entry.id}`,
          text,
          ...(at === undefined ? {} : { at }),
        });
      }
      continue;
    }

    if (entry.kind === NOTICE_KIND) {
      const mapped = mapNotice(entry, options.mode);
      if (mapped) out.push(mapped);
      continue;
    }

    if (AssistantEntry.is(entry)) {
      const messages = (entry.model ?? []) as readonly AssistantMessage[];
      for (const [mIdx, message] of messages.entries()) {
        const content = Array.isArray(message.content) ? message.content : [];
        for (const [bIdx, part] of content.entries()) {
          if (part.type === "text") {
            const trimmed = part.text.trim();
            if (trimmed !== "") {
              out.push({
                kind: "assistant",
                key: `e:${entry.id}:${mIdx}:${bIdx}`,
                text: trimmed,
                ...(message.timestamp ? { at: message.timestamp } : {}),
              });
            }
            continue;
          }
          if (part.type === "toolCall") {
            pairedCallIds.add(part.id);
            const result = resultsByCallId.get(part.id);
            const slot = liveSlotByCallId.get(part.id);
            const keyPrefix = `e:${entry.id}:${mIdx}:${bIdx}:${part.id}`;
            if (options.mode === "router" && (part.name === "ticket" || part.name === "ask_user")) {
              pushDispatch(`e:${entry.id}:d:${part.id}`, [
                mapDispatch(part, result, slot, options.live?.run !== undefined),
              ]);
            } else if (
              options.mode === "worker" &&
              (part.name === "edit" || part.name === "write")
            ) {
              out.push(
                mapWorkerEdit(keyPrefix, part, result, slot, options.live?.run !== undefined),
              );
            } else if (options.mode === "worker" && part.name === "bash") {
              out.push(
                mapWorkerBash(
                  keyPrefix,
                  part,
                  result,
                  slot,
                  options.live?.run !== undefined,
                  message.timestamp,
                ),
              );
            } else if (options.mode === "worker" && part.name === "report") {
              const mappedReport = mapWorkerReport(keyPrefix, part, result, {
                ticketId: options.ticketId,
                reports: options.reports,
                fallbackSeq: reportOrdinal + 1,
                timestamp: message.timestamp,
              });
              if (mappedReport) {
                reportOrdinal = mappedReport.report.seq;
                out.push(mappedReport);
              } else {
                pushTools(`e:${entry.id}:t:${part.id}`, [
                  mapToolStep(part, result, slot, options.live?.run !== undefined),
                ]);
              }
            } else {
              pushTools(`e:${entry.id}:t:${part.id}`, [
                mapToolStep(part, result, slot, options.live?.run !== undefined),
              ]);
            }
          }
        }
      }
      continue;
    }

    if (ToolResultEntry.is(entry)) {
      for (const [idx, msg] of ((entry.model ?? []) as readonly ToolResultMessage[]).entries()) {
        if (msg.role !== "toolResult" || pairedCallIds.has(msg.toolCallId)) continue;
        pushTools(`e:${entry.id}:r:${idx}`, [
          {
            id: msg.toolCallId || `${entry.id}:${idx}`,
            tool: msg.toolName,
            label: msg.toolName,
            status: msg.isError ? "err" : "ok",
            ...(msg.durationMs === undefined ? {} : { ms: msg.durationMs }),
            ...(toolResultText(msg) ? { output: toolResultText(msg) } : {}),
          },
        ]);
      }
    }
  }

  const live = options.live;
  if (live?.run !== undefined) {
    if (live.generation?.retry) {
      out.push({
        kind: "event",
        key: "live:retry",
        eventKind: "notice",
        text: t("Model request held up ({error}); retrying automatically…", {
          error: live.generation.retry.error,
        }),
      });
    }
    const partial = live.generation?.message;
    const partialText = partial ? extractAssistantText(partial) : "";
    const hasRunningTools = (live.tools ?? []).some((t) => t.status !== "done");
    if (partialText !== "" || !hasRunningTools) {
      out.push({
        kind: "assistant",
        key: "live:gen",
        text: partialText,
        streaming: true,
      });
    }
  } else if (live?.runFailure !== undefined) {
    const failure = live.runFailure;
    if (failure.reason === "aborted") {
      out.push({
        kind: "idle",
        key: `live:abort:${failure.taskId}`,
        text:
          options.mode === "worker"
            ? t("You interrupted this turn · the ticket is still open; send a message to continue")
            : t("This turn was interrupted · send a message to continue"),
      });
    } else if (!isDeliberateEnd(failure.reason)) {
      out.push({
        kind: "failure",
        key: `live:fail:${failure.taskId}`,
        reason: failure.reason,
        text: failureText(failure),
      });
    }
  }

  if (
    options.mode === "worker" &&
    live?.run === undefined &&
    options.ticketStatus === "open" &&
    options.ticketStage &&
    out.length > 0 &&
    out.at(-1)?.kind !== "idle" &&
    out.at(-1)?.kind !== "failure"
  ) {
    const idleText = WORKER_IDLE_TEXT[options.ticketStage];
    if (idleText) {
      out.push({
        kind: "idle",
        key: `stage-idle:${options.ticketStage}`,
        text: idleText,
      });
    }
  }

  out.push(...mapInbox(options.inbox));
  return out;
}

/** What you sent that no boundary has placed yet; entries written by the system are not yours to see here. */
function mapInbox(inbox: InboxState | undefined): TranscriptDisplayItem[] {
  const out: TranscriptDisplayItem[] = [];
  for (const item of inbox?.items ?? []) {
    if (item.mode === "write" || item.entry !== undefined) continue;
    const content = item.content;
    const text = (
      typeof content === "string"
        ? content
        : content.map((part) => (part.type === "text" ? part.text : "")).join("")
    ).trim();
    if (text === "") continue;
    out.push({
      kind: "user",
      key: `q:${item.id}`,
      text,
      pending: true,
    });
  }
  return out;
}

const WORKER_IDLE_TEXT: Partial<Record<TicketStage, string>> = {
  queued: t("Queued · waiting for a free Worker slot"),
  jobs: t("Turn ended · waiting on background jobs"),
  answer: t("Turn ended · waiting for your answer"),
  review: t("Turn ended · waiting for the Router to review"),
  blocked: t("Turn ended · waiting for the Router"),
  waiting: t("Turn ended · waiting for what it needs"),
};

function mapReset(
  entry: EntryRecord,
  mode: "router" | "worker",
  sawPriorReset: boolean,
): TranscriptDisplayItem | undefined {
  const { text, at } = extractTextAndTime(entry);
  const handoff = extractTag(text, "handoff-summary");
  if (handoff !== undefined) {
    return {
      kind: "reset",
      key: `e:${entry.id}`,
      summary: handoff,
      ...(at === undefined ? {} : { at }),
    };
  }
  if (mode === "worker") {
    const ticket = extractTag(text, "ticket");
    if (ticket !== undefined) {
      if (!sawPriorReset) {
        return { kind: "opening", key: `e:${entry.id}`, text: ticket };
      }
      const latest = extractTag(text, "latest-report");
      return {
        kind: "reset",
        key: `e:${entry.id}`,
        summary: latest ?? t("Ticket context handed over and reset"),
        ...(at === undefined ? {} : { at }),
      };
    }
  }
  if (
    text.includes("<project>") ||
    text.includes("<project-memory>") ||
    text.includes("<global-memory>")
  ) {
    return undefined;
  }
  return {
    kind: "reset",
    key: `e:${entry.id}`,
    summary: text || t("(context reset)"),
    ...(at === undefined ? {} : { at }),
  };
}

/** A notice in the reader's words, from the facts the Engine attached; an older notice shows its text. */
function mapNotice(
  entry: EntryRecord,
  mode: "router" | "worker",
): TranscriptDisplayItem | undefined {
  const { text, at } = extractTextAndTime(entry);
  const notice = (entry.data as NoticeData | undefined)?.notice;
  const key = `e:${entry.id}`;
  const time = at === undefined ? {} : { at };
  const event = (eventKind: EventKind, line: string, fields: EventFields = {}) =>
    ({ kind: "event", key, eventKind, text: line, ...fields, ...time }) as const;
  const list = (ids: readonly string[]) => ids.join(t(", "));

  switch (notice?.type) {
    case undefined:
      return text === "" ? undefined : event("notice", text);
    case "opening":
      return { kind: "opening", key, text: extractTag(text, "ticket") ?? text };
    case "router-message":
      return event("notice", text);
    case "report": {
      const { status } = notice.report;
      if (mode === "router" && status === "progress") return undefined;
      return event("report", reportSummary(notice.report), { ticketId: notice.ticketId, status });
    }
    case "accepted":
      return event(
        "deliver",
        t("{ticket} “{title}”, which this waits on, was accepted", {
          ticket: notice.ticketId,
          title: notice.title,
        }),
        {
          ticketId: notice.ticketId,
          ...(notice.report ? { detail: reportSummary(notice.report) } : {}),
        },
      );
    case "delivered":
      return event(
        "deliver",
        t("Delivered the result of {ticket} to {targets}", {
          ticket: notice.ticketId,
          targets: list(notice.to),
        }),
        { ticketId: notice.ticketId },
      );
    case "cancelled":
      return event(
        "notice",
        t("{ticket} “{title}” was cancelled while {waiting} still waits on it", {
          ticket: notice.ticketId,
          title: notice.title,
          waiting: list(notice.waiting),
        }),
        { ticketId: notice.ticketId, ...(notice.reason ? { detail: notice.reason } : {}) },
      );
    case "answer": {
      const question = notice.questionId;
      if (notice.forwardedTo !== undefined) {
        return event(
          "answer",
          t("You answered {question} (sent straight to {ticket})", {
            question,
            ticket: notice.forwardedTo,
          }),
          { questionId: question, ticketId: notice.forwardedTo, detail: notice.answer },
        );
      }
      if (mode === "router") {
        return {
          kind: "qa",
          key,
          questionId: question,
          question: t("Answer to {question}", { question }),
          answer: notice.answer,
          ...time,
        };
      }
      return {
        kind: "user",
        key,
        text: t("[Answer to {question}] {answer}", { question, answer: notice.answer }),
        ...time,
      };
    }
    case "job-finished": {
      const tail = notice.tail.trim();
      return event(
        "job",
        t("Background job {job} finished ({status})", {
          job: notice.jobId,
          status: jobStatusText(notice.outcome),
        }),
        { jobId: notice.jobId, ...(tail ? { detail: tail } : {}) },
      );
    }
    case "jobs-interrupted":
      return event(
        "job",
        t("An Engine restart interrupted background jobs {jobs}", { jobs: list(notice.jobIds) }),
      );
    case "panel-message":
      return event(
        "intervene",
        t("You messaged {ticket} directly: {text}", { ticket: notice.ticketId, text: notice.text }),
        { ticketId: notice.ticketId },
      );
    case "panel-interrupt":
      return event(
        "intervene",
        t("You interrupted the current turn of {ticket}", { ticket: notice.ticketId }),
        {
          ticketId: notice.ticketId,
        },
      );
    case "handoff-nudge":
      return event("notice", t("The context is long; the Router was asked to hand off"));
    case "reminder":
      return event(
        "notice",
        t("{n} report still waits for the Router|{n} reports still wait for the Router", {
          n: notice.reports.length,
        }),
      );
  }
}

function mapDispatch(
  call: ToolCall,
  result: ToolResultMessage | undefined,
  slot: ToolSlot | undefined,
  runActive: boolean,
): DispatchAction {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const resText = result ? toolResultText(result) : "";
  const status: DispatchAction["status"] = callStatus(result, slot, runActive);

  if (call.name === "ask_user") {
    const items = Array.isArray(args.items) ? (args.items as { text?: string }[]) : [];
    const questionId = detailsOf<AskDetails>(result).questionId;
    const ticketId = typeof args.ticketId === "string" ? args.ticketId : undefined;
    const firstTitle = items[0]?.text ?? t("Question for you");
    const title =
      items.length > 1
        ? t("{title} ({n} questions)", { title: firstTitle, n: items.length })
        : firstTitle;
    return {
      id: call.id,
      kind: "ask",
      ...(questionId === undefined ? {} : { questionId }),
      ...(ticketId === undefined ? {} : { ticketId }),
      title,
      ...(result?.isError
        ? { detail: resText }
        : ticketId
          ? { detail: t("From {ticket}", { ticket: ticketId }) }
          : {}),
      status,
    };
  }

  const action = String(args.action ?? "");
  const argTicketId = typeof args.ticketId === "string" ? args.ticketId : undefined;
  const createdId = detailsOf<TicketDetails>(result).ticketId;
  const ticketId = argTicketId ?? createdId;

  if (action === "create") {
    const deliverTo = Array.isArray(args.deliverTo)
      ? (args.deliverTo as string[]).filter(Boolean)
      : [];
    const model =
      typeof args.provider === "string" && typeof args.modelId === "string"
        ? `${args.provider}/${args.modelId}${typeof args.modelReason === "string" && args.modelReason ? ` · ${args.modelReason}` : ""}`
        : t("Default model");
    const targets = deliverTo.join(t(", "));
    const parts = [
      deliverTo.length > 0 ? t("Deliver to {targets}", { targets }) : "",
      model,
    ].filter(Boolean);
    return {
      id: call.id,
      kind: "create",
      ...(ticketId === undefined ? {} : { ticketId }),
      title: typeof args.title === "string" ? args.title : t("New ticket"),
      detail: result?.isError ? resText : parts.join(" · "),
      status,
    };
  }

  if (action === "review") {
    const verdict = args.verdict === "rework" ? "rework" : "accept";
    const note = typeof args.note === "string" ? args.note : undefined;
    return {
      id: call.id,
      kind: verdict,
      ...(ticketId === undefined ? {} : { ticketId }),
      title: verdict === "accept" ? t("Accept and close") : t("Send back"),
      ...(result?.isError ? { detail: resText } : note ? { detail: note } : {}),
      status,
    };
  }

  if (action === "message") {
    const msgText = typeof args.text === "string" ? args.text : undefined;
    return {
      id: call.id,
      kind: "message",
      ...(ticketId === undefined ? {} : { ticketId }),
      title: args.mode === "steer" ? t("Steer instruction") : t("Queued instruction"),
      ...(result?.isError ? { detail: resText } : msgText ? { detail: msgText } : {}),
      status,
    };
  }

  if (action === "interrupt") {
    return {
      id: call.id,
      kind: "interrupt",
      ...(ticketId === undefined ? {} : { ticketId }),
      title: t("Interrupt this turn::current"),
      ...(result?.isError ? { detail: resText } : {}),
      status,
    };
  }

  if (action === "close") {
    const note = typeof args.note === "string" ? args.note : undefined;
    return {
      id: call.id,
      kind: "close",
      ...(ticketId === undefined ? {} : { ticketId }),
      title: t("Cancel ticket"),
      ...(result?.isError ? { detail: resText } : note ? { detail: note } : {}),
      status,
    };
  }

  const model =
    typeof args.provider === "string" && typeof args.modelId === "string"
      ? `${args.provider}/${args.modelId}`
      : "";
  return {
    id: call.id,
    kind: "model",
    ...(ticketId === undefined ? {} : { ticketId }),
    title: model || t("Change model"),
    ...(result?.isError
      ? { detail: resText }
      : typeof args.modelReason === "string" && args.modelReason
        ? { detail: args.modelReason }
        : {}),
    status,
  };
}

function mapToolStep(
  call: ToolCall,
  result: ToolResultMessage | undefined,
  slot: ToolSlot | undefined,
  runActive: boolean,
): ToolStepItem {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const output = result ? toolResultText(result) : slot?.output;
  const status: ToolStepItem["status"] = callStatus(result, slot, runActive);

  return {
    id: call.id,
    tool: call.name,
    label: formatToolLabel(call.name, args),
    status,
    ...(result?.durationMs === undefined ? {} : { ms: result.durationMs }),
    ...(output ? { output } : {}),
  };
}

function formatToolLabel(name: string, args: Record<string, unknown>): string {
  if (name === "read") {
    const path = typeof args.path === "string" ? args.path : "";
    const query = typeof args.query === "string" ? `?query=${args.query}` : "";
    const offset = typeof args.offset === "number" ? `:${args.offset}` : "";
    return `${path}${offset}${query}` || "read";
  }
  if (name === "bash") return typeof args.command === "string" ? args.command : "bash";
  if (name === "edit" || name === "write") return typeof args.path === "string" ? args.path : name;
  if (name === "memory") {
    const action = typeof args.action === "string" ? args.action : "";
    const scope = typeof args.scope === "string" ? args.scope : "";
    const target =
      typeof args.file === "string"
        ? `/${args.file}`
        : typeof args.change === "number"
          ? ` #${args.change}`
          : "";
    return `${action} ${scope}${target}`.trim() || "memory";
  }
  if (name === "handoff") {
    const summary = typeof args.summary === "string" ? args.summary : "";
    return summary.length > 60 ? `${summary.slice(0, 60)}…` : summary || "handoff";
  }
  const firstStr = Object.values(args).find((v): v is string => typeof v === "string");
  if (firstStr) return firstStr.length > 80 ? `${firstStr.slice(0, 80)}…` : firstStr;
  const json = JSON.stringify(args);
  return json === "{}" ? name : json.slice(0, 80);
}

function extractTextAndTime(entry: EntryRecord): { text: string; at?: number } {
  const messages = (entry.model ?? []) as readonly { content?: unknown; timestamp?: number }[];
  let at: number | undefined;
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.timestamp === "number") at = msg.timestamp;
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as { type?: string; text?: string }[]) {
        if (block.type === "text" && block.text) parts.push(block.text);
      }
    }
  }
  return { text: parts.join("\n").trim(), ...(at === undefined ? {} : { at }) };
}

function extractAssistantText(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n")
    .trim();
}

function toolResultText(result: ToolResultMessage): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n")
    .trim();
}

function extractTag(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(text);
  return match?.[1]?.trim();
}

function callStatus(
  result: ToolResultMessage | undefined,
  slot: ToolSlot | undefined,
  runActive: boolean,
): "ok" | "err" | "run" {
  if (result) return result.isError ? "err" : "ok";
  if (slot) return slot.status === "done" ? "ok" : "run";
  return runActive ? "run" : "err";
}

function mapWorkerEdit(
  key: string,
  call: ToolCall,
  result: ToolResultMessage | undefined,
  slot: ToolSlot | undefined,
  runActive: boolean,
): TranscriptDisplayItem {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const action = call.name === "write" ? "write" : "edit";
  const path = typeof args.path === "string" ? args.path : action;
  const status = callStatus(result, slot, runActive);

  let diff: DiffLine[] = [];
  if (status !== "err") {
    if (action === "write") {
      const content = typeof args.content === "string" ? args.content : "";
      if (content !== "") {
        diff = content.split(/\r?\n/).map((line, i) => ({
          k: "add" as const,
          n: String(i + 1),
          s: line,
        }));
      }
    } else {
      const details = result?.details as { diff?: unknown; patch?: unknown } | undefined;
      if (typeof details?.diff === "string" && details.diff.trim() !== "") {
        diff = parseDiffString(details.diff);
      } else if (typeof details?.patch === "string" && details.patch.trim() !== "") {
        diff = parseUnifiedPatch(details.patch);
      } else if (Array.isArray(args.edits)) {
        diff = synthesizeEditDiff(args.edits as { oldText?: unknown; newText?: unknown }[]);
      }
    }
  }

  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.k === "add") added++;
    else if (line.k === "del") removed++;
  }

  return {
    kind: "edit",
    key,
    action,
    path,
    status,
    diff,
    added,
    removed,
    ...(result?.isError ? { error: toolResultText(result) } : {}),
    ...(result?.durationMs === undefined ? {} : { ms: result.durationMs }),
  };
}

function parseDiffString(raw: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (/^ +\.\.\.$/.test(line)) {
      lines.push({ k: "hunk", n: "", s: "…" });
      continue;
    }
    const withText = /^([+\- ])\s*(\d+) (.*)$/.exec(line);
    if (withText) {
      const marker = withText[1];
      lines.push({
        k: marker === "+" ? "add" : marker === "-" ? "del" : "ctx",
        n: withText[2] ?? "",
        s: withText[3] ?? "",
      });
      continue;
    }
    const bare = /^([+\- ])\s*(\d+)$/.exec(line);
    if (bare) {
      const marker = bare[1];
      lines.push({
        k: marker === "+" ? "add" : marker === "-" ? "del" : "ctx",
        n: bare[2] ?? "",
        s: "",
      });
    }
  }
  if (lines.length === 0 && raw.trim() !== "") {
    return raw.split(/\r?\n/).map((line, i) => ({ k: "ctx", n: String(i + 1), s: line }));
  }
  return lines;
}

function parseUnifiedPatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNum = 1;
  let newNum = 1;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldNum = Number(hunk[1]);
      newNum = Number(hunk[2]);
      lines.push({ k: "hunk", n: "", s: line });
      continue;
    }
    if (line.startsWith("+")) {
      lines.push({ k: "add", n: String(newNum++), s: line.slice(1) });
    } else if (line.startsWith("-")) {
      lines.push({ k: "del", n: String(oldNum++), s: line.slice(1) });
    } else if (line.startsWith(" ")) {
      lines.push({ k: "ctx", n: String(newNum++), s: line.slice(1) });
      oldNum++;
    }
  }
  return lines;
}

function synthesizeEditDiff(
  edits: readonly { oldText?: unknown; newText?: unknown }[],
): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const [index, edit] of edits.entries()) {
    if (index > 0) lines.push({ k: "hunk", n: "", s: "…" });
    if (typeof edit.oldText === "string" && edit.oldText !== "") {
      for (const s of edit.oldText.split(/\r?\n/)) lines.push({ k: "del", n: "", s });
    }
    if (typeof edit.newText === "string" && edit.newText !== "") {
      for (const s of edit.newText.split(/\r?\n/)) lines.push({ k: "add", n: "", s });
    }
  }
  return lines;
}

function mapWorkerBash(
  key: string,
  call: ToolCall,
  result: ToolResultMessage | undefined,
  slot: ToolSlot | undefined,
  runActive: boolean,
  at?: number,
): TranscriptDisplayItem {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const command = typeof args.command === "string" ? args.command : "bash";
  if (!result) {
    const status = slot?.status === "done" ? "exit" : runActive ? "run" : "stopped";
    return {
      kind: "bash",
      key,
      command,
      status,
      output: slot?.output ?? "",
      ...(at === undefined ? {} : { at }),
    };
  }
  const output = toolResultText(result);
  const details = detailsOf<BashDetails>(result);
  if (details.jobId !== undefined) {
    return {
      kind: "bash",
      key,
      command,
      status: "job",
      output: slot?.output ?? "",
      jobId: details.jobId,
      ...(result.durationMs === undefined ? {} : { ms: result.durationMs }),
    };
  }
  if (result.isError) {
    if (details.stopped || /aborted|interrupted/i.test(output)) {
      return {
        kind: "bash",
        key,
        command,
        status: "stopped",
        output: details.stopped ? (slot?.output ?? "") : output,
        ...(result.durationMs === undefined ? {} : { ms: result.durationMs }),
      };
    }
    return {
      kind: "bash",
      key,
      command,
      status: "exit",
      output,
      exitCode: details.exitCode ?? 1,
      ...(result.durationMs === undefined ? {} : { ms: result.durationMs }),
    };
  }
  return {
    kind: "bash",
    key,
    command,
    status: "exit",
    output,
    exitCode: 0,
    ...(result.durationMs === undefined ? {} : { ms: result.durationMs }),
  };
}

function mapWorkerReport(
  key: string,
  call: ToolCall,
  result: ToolResultMessage | undefined,
  context: {
    ticketId?: TicketId;
    reports?: readonly Report[];
    fallbackSeq: number;
    timestamp?: number;
  },
): Extract<TranscriptDisplayItem, { kind: "report" }> | undefined {
  if (!result || result.isError) return undefined;
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const status = args.status;
  if (
    status !== "progress" &&
    status !== "waiting" &&
    status !== "ready" &&
    status !== "blocked" &&
    status !== "failed" &&
    status !== "dropped"
  ) {
    return undefined;
  }

  const resText = toolResultText(result);
  const seqMatch = /report:\/\/t\d+#(\d+)/.exec(resText);
  const seq = seqMatch ? Number(seqMatch[1]) : context.fallbackSeq;
  const boardReport = context.reports?.find((r) => r.seq === seq);

  const artifacts = Array.isArray(args.artifacts)
    ? args.artifacts.flatMap((a) =>
        a && typeof a === "object" && typeof (a as { path?: unknown }).path === "string"
          ? [
              {
                path: (a as { path: string }).path,
                note:
                  typeof (a as { note?: unknown }).note === "string"
                    ? (a as { note: string }).note
                    : "",
              },
            ]
          : [],
      )
    : [];

  const lessons = Array.isArray(args.lessons)
    ? args.lessons.filter((l): l is string => typeof l === "string")
    : undefined;

  const report: Report = boardReport ?? {
    ticketId: context.ticketId ?? ("t0" as TicketId),
    seq,
    status,
    summary: typeof args.summary === "string" ? args.summary : "",
    ...(typeof args.detail === "string" ? { detail: args.detail } : {}),
    artifacts,
    ...(typeof args.need === "string" ? { need: args.need } : {}),
    ...(lessons && lessons.length > 0 ? { lessons } : {}),
    handled: false,
    reminded: false,
    at: result.timestamp ?? context.timestamp ?? Date.now(),
  };

  return { kind: "report", key, report };
}
