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
  describeRunFailure,
  isDeliberateEnd,
  type Report,
  type ReportStatus,
  type TicketId,
  type TicketStage,
  type TicketStatus,
} from "../../src/contracts/index.ts";
import type { GapItem } from "./conversation.ts";
import { t } from "./i18n.ts";

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
  | { kind: "idle"; key: string; text: string };

const NOTICE_KIND = "eevee.notice";

const REPORT_RE =
  /^\[(t\d+)「([^」]*)」报告 · (progress|waiting|ready|blocked|failed|dropped)\]\s*([\s\S]*)$/;
const ANSWER_ROUTER_RE = /^用户已回答 (q\d+)，答案已直接投给 (t\d+)。(?:\n([\s\S]*))?$/;
const ANSWER_DIRECT_RE = /^用户回答了问题 (q\d+)：\n([\s\S]*)$/;
const DELIVER_RE = /^已把 (t\d+) 的结果投递给 ([^。]+)。$/;
const PANEL_MSG_RE = /^用户直接给 (t\d+) 发了消息：\n([\s\S]*)$/;
const PANEL_INT_RE = /^用户在面板打断了 (t\d+) 当前这一轮。$/;
const JOB_DONE_RE = /^后台作业 job:\/\/(j\d+) 已结束（([^）]*)）。\n输出末尾：\n([\s\S]*)$/;
const HANDOVER_RE = /^你等待的 (t\d+)「([^」]*)」已验收(?:。|：\n([\s\S]*))$/;
const ANSWER_PREFIX_RE = /^用户回答了问题 q\d+：\n/;

export type MapTranscriptOptions = {
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
        text: t("模型请求暂时受阻（{error}），正在等待自动重试…", {
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
            ? t("本轮已被你打断 · 工单仍为 open，发消息即可继续")
            : t("本轮已被打断 · 发消息即可继续"),
      });
    } else if (!isDeliberateEnd(failure.reason)) {
      out.push({
        kind: "failure",
        key: `live:fail:${failure.taskId}`,
        reason: failure.reason,
        text: describeRunFailure(failure),
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
  queued: t("排队中 · 等待空闲的 Worker 槽位"),
  jobs: t("本轮已结束 · 等待后台作业"),
  answer: t("本轮已结束 · 等你回答问题"),
  review: t("本轮已结束 · 等 Router 验收"),
  blocked: t("本轮已结束 · 等 Router 处理"),
  waiting: t("本轮已结束 · 等待所需材料"),
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
        summary: latest ?? t("工单上下文已交接重置"),
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
    summary: text || t("（上下文已重置）"),
    ...(at === undefined ? {} : { at }),
  };
}

function mapNotice(
  entry: EntryRecord,
  mode: "router" | "worker",
): TranscriptDisplayItem | undefined {
  const { text, at } = extractTextAndTime(entry);
  if (text === "") return undefined;

  if (mode === "worker" && text.includes("<ticket>")) {
    return { kind: "opening", key: `e:${entry.id}`, text: extractTag(text, "ticket") ?? text };
  }

  const reportMatch = REPORT_RE.exec(text);
  if (reportMatch) {
    const ticketId = reportMatch[1] ?? "";
    const status = reportMatch[3] as ReportStatus;
    if (mode === "router" && status === "progress") return undefined;
    const body = reportMatch[4] ?? "";
    const firstLine =
      body
        .split("\n")[0]
        ?.replace(/^完整报告：.*$/, "")
        .trim() ?? "";
    return {
      kind: "event",
      key: `e:${entry.id}`,
      eventKind: "report",
      ticketId,
      status,
      text: firstLine || body,
      ...(at === undefined ? {} : { at }),
    };
  }

  const answerRouter = ANSWER_ROUTER_RE.exec(text);
  if (answerRouter) {
    const questionId = answerRouter[1] ?? "";
    const ticketId = answerRouter[2] ?? "";
    const detail = answerRouter[3]?.replace(ANSWER_PREFIX_RE, "").trim();
    return {
      kind: "event",
      key: `e:${entry.id}`,
      eventKind: "answer",
      questionId,
      ticketId,
      text: t("你回答了 {question}（已直接投给 {ticket}）", {
        question: questionId,
        ticket: ticketId,
      }),
      ...(detail ? { detail } : {}),
      ...(at === undefined ? {} : { at }),
    };
  }

  const answerDirect = ANSWER_DIRECT_RE.exec(text);
  if (answerDirect) {
    const questionId = answerDirect[1] ?? "";
    const answer = answerDirect[2]?.trim() ?? "";
    if (mode === "router") {
      return {
        kind: "qa",
        key: `e:${entry.id}`,
        questionId,
        question: t("回答 {question}", { question: questionId }),
        answer,
        ...(at === undefined ? {} : { at }),
      };
    }
    return {
      kind: "user",
      key: `e:${entry.id}`,
      text: t("[{question} 的回答] {answer}", { question: questionId, answer }),
      ...(at === undefined ? {} : { at }),
    };
  }

  const deliverMatch = DELIVER_RE.exec(text);
  if (deliverMatch) {
    const ticketId = deliverMatch[1] ?? "";
    return {
      kind: "event",
      key: `e:${entry.id}`,
      eventKind: "deliver",
      ticketId,
      text,
      ...(at === undefined ? {} : { at }),
    };
  }

  const jobDone = JOB_DONE_RE.exec(text);
  if (jobDone) {
    const jobId = jobDone[1] ?? "";
    const tail = jobDone[3]?.trim();
    return {
      kind: "event",
      key: `e:${entry.id}`,
      eventKind: "job",
      jobId,
      text: t("后台作业 {job} 已结束（{status}）", { job: jobId, status: jobDone[2] ?? "" }),
      ...(tail ? { detail: tail } : {}),
      ...(at === undefined ? {} : { at }),
    };
  }

  const handover = HANDOVER_RE.exec(text);
  if (handover) {
    const ticketId = handover[1] ?? "";
    const detail = handover[3]?.trim();
    return {
      kind: "event",
      key: `e:${entry.id}`,
      eventKind: "deliver",
      ticketId,
      text: t("你等待的 {ticket}「{title}」已验收", { ticket: ticketId, title: handover[2] ?? "" }),
      ...(detail ? { detail } : {}),
      ...(at === undefined ? {} : { at }),
    };
  }

  const panelMsg = PANEL_MSG_RE.exec(text);
  if (panelMsg) {
    const ticketId = panelMsg[1] ?? "";
    const msg = panelMsg[2]?.trim() ?? "";
    return {
      kind: "event",
      key: `e:${entry.id}`,
      eventKind: "intervene",
      ticketId,
      text: t("你直接给 {ticket} 发了消息：{text}", { ticket: ticketId, text: msg }),
      ...(at === undefined ? {} : { at }),
    };
  }

  const panelInt = PANEL_INT_RE.exec(text);
  if (panelInt) {
    const ticketId = panelInt[1] ?? "";
    return {
      kind: "event",
      key: `e:${entry.id}`,
      eventKind: "intervene",
      ticketId,
      text,
      ...(at === undefined ? {} : { at }),
    };
  }

  return {
    kind: "event",
    key: `e:${entry.id}`,
    eventKind: "notice",
    text,
    ...(at === undefined ? {} : { at }),
  };
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
    const qMatch = /已提问 (q\d+)/.exec(resText);
    const questionId = qMatch?.[1];
    const ticketId = typeof args.ticketId === "string" ? args.ticketId : undefined;
    const firstTitle = items[0]?.text ?? t("向用户提问");
    const title =
      items.length > 1
        ? t("{title}（共 {n} 题）", { title: firstTitle, n: items.length })
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
          ? { detail: t("来自 {ticket}", { ticket: ticketId }) }
          : {}),
      status,
    };
  }

  const action = String(args.action ?? "");
  const argTicketId = typeof args.ticketId === "string" ? args.ticketId : undefined;
  const createdId = /^已建单 (t\d+)/.exec(resText)?.[1];
  const ticketId = argTicketId ?? createdId;

  if (action === "create") {
    const deliverTo = Array.isArray(args.deliverTo)
      ? (args.deliverTo as string[]).filter(Boolean)
      : [];
    const model =
      typeof args.provider === "string" && typeof args.modelId === "string"
        ? `${args.provider}/${args.modelId}${typeof args.modelReason === "string" && args.modelReason ? ` · ${args.modelReason}` : ""}`
        : t("默认模型");
    const targets = deliverTo.join(t("、"));
    const parts = [deliverTo.length > 0 ? t("投递给 {targets}", { targets }) : "", model].filter(
      Boolean,
    );
    return {
      id: call.id,
      kind: "create",
      ...(ticketId === undefined ? {} : { ticketId }),
      title: typeof args.title === "string" ? args.title : t("新建工单"),
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
      title: verdict === "accept" ? t("验收结单") : t("打回返工"),
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
      title: args.mode === "steer" ? t("引导指令") : t("排队指令"),
      ...(result?.isError ? { detail: resText } : msgText ? { detail: msgText } : {}),
      status,
    };
  }

  if (action === "interrupt") {
    return {
      id: call.id,
      kind: "interrupt",
      ...(ticketId === undefined ? {} : { ticketId }),
      title: t("打断当前这一轮"),
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
      title: t("取消工单"),
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
    title: model || t("更换模型"),
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
        : typeof args.commit === "string"
          ? ` ${args.commit}`
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
  const jobMatch = /^命令仍在运行，已转入后台作业 (?:job:\/\/)?(j\d+)/.exec(output);
  if (jobMatch) {
    return {
      kind: "bash",
      key,
      command,
      status: "job",
      output,
      jobId: jobMatch[1],
      ...(result.durationMs === undefined ? {} : { ms: result.durationMs }),
    };
  }
  if (result.isError) {
    if (
      /命令已中止/.test(output) ||
      output.toLowerCase().includes("aborted") ||
      output.toLowerCase().includes("interrupted")
    ) {
      return {
        kind: "bash",
        key,
        command,
        status: "stopped",
        output,
        ...(result.durationMs === undefined ? {} : { ms: result.durationMs }),
      };
    }
    const exitMatch = /退出码\s+(\d+)/.exec(output);
    return {
      kind: "bash",
      key,
      command,
      status: "exit",
      output,
      exitCode: exitMatch ? Number(exitMatch[1]) : 1,
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
