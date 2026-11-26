import type {
  AnswerQuestionResponse,
  BackgroundTaskRecordPayload,
  BackgroundTaskStatus,
  BoardViewPayload,
  ConversationViewPayload,
  EngineSettings,
  EntryRecordPayload,
  ListModelsResponse,
  ListProvidersResponse,
  McpServerSnapshotPayload,
  McpStateResponse,
  ModelProfilesDocument,
  OutputSlice,
  ProjectUsageResponse,
  ReadWorkerTaskResponse,
  RefreshModelsResponse,
  TaskListStatusFilter,
  TaskStreamEvent,
} from "@eevee/protocol";

export { parseModelFlag } from "./args.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatBoard(board: BoardViewPayload): string {
  const lines: string[] = [];
  const activeWorkers = board.workers.filter((worker) => worker.status !== "closed");
  const closedCount = board.workers.length - activeWorkers.length;

  if (activeWorkers.length === 0) {
    lines.push(
      closedCount === 0
        ? "Workers: none yet."
        : `Workers: no active workers (${closedCount} closed).`,
    );
  } else {
    const ticketById = new Map(board.tickets.map((ticket) => [ticket.id, ticket]));
    lines.push("Workers:");
    for (const worker of activeWorkers) {
      const ticket =
        worker.activeTicketId === undefined ? undefined : ticketById.get(worker.activeTicketId);
      const ticketText =
        ticket === undefined ? "no open ticket" : `ticket ${ticket.id} (${ticket.title})`;
      const taskText =
        worker.activeTaskCount === 0
          ? ""
          : `, ${worker.activeTaskCount} running background task(s)`;
      lines.push(`- ${worker.id} "${worker.name}" [${worker.status}] — ${ticketText}${taskText}`);
    }
    if (closedCount > 0) lines.push(`(${closedCount} closed worker(s))`);
  }

  if (board.tickets.length > 0) {
    lines.push("", "Tickets:");
    for (const ticket of board.tickets) {
      const note = ticket.note === undefined ? "" : ` — ${ticket.note}`;
      lines.push(`- ${ticket.id} [${ticket.status}] (${ticket.workerId}) ${ticket.title}${note}`);
    }
  }

  const pendingQuestions = board.questions.filter(
    (question) => question.answeredAt === undefined && question.withdrawnAt === undefined,
  );
  if (pendingQuestions.length > 0) {
    lines.push("", "Unanswered questions:");
    for (const question of pendingQuestions) {
      const summary = question.items.map((item) => item.question).join("; ");
      lines.push(`- ${question.id}: ${summary}`);
    }
  }

  return lines.join("\n");
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function extractAssistantTextFromMessage(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant") return "";
  return extractContentText(message.content);
}

function extractEntryAssistantText(entry: EntryRecordPayload): string {
  if (!Array.isArray(entry.model)) return "";
  return entry.model.map((msg) => extractAssistantTextFromMessage(msg)).join("");
}

function extractAssistantExtraLines(entry: EntryRecordPayload): string[] {
  const lines: string[] = [];
  if (!Array.isArray(entry.model)) return lines;
  for (const msg of entry.model) {
    if (!isRecord(msg) || msg.role !== "assistant") continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (isRecord(block) && block.type === "toolCall" && typeof block.name === "string") {
          const args = isRecord(block.arguments) ? JSON.stringify(block.arguments) : "{}";
          lines.push(`[toolCall] ${block.name}(${args})`);
        }
      }
    }
    if (msg.stopReason === "error" && typeof msg.errorMessage === "string" && msg.errorMessage) {
      lines.push(`[error] ${msg.errorMessage}`);
    }
  }
  return lines;
}

function formatNonAssistantEntryLines(entry: EntryRecordPayload): string[] {
  if (entry.kind === "pi.system") return [];
  if (entry.kind === "pi.compaction") return ["[compaction] Context summarized"];

  const lines: string[] = [];
  if (entry.kind === "pi.reset") {
    lines.push("[reset]");
  }

  if (!Array.isArray(entry.model)) return lines;
  for (const msg of entry.model) {
    if (!isRecord(msg) || typeof msg.role !== "string") continue;
    if (msg.role === "user") {
      const text = extractContentText(msg.content).trim();
      if (text.length > 0) {
        const label = entry.kind === "eevee.notice" ? "notice" : "user";
        lines.push(`[${label}] ${text}`);
      }
    } else if (msg.role === "toolResult") {
      const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
      const isError = msg.isError === true ? " error" : "";
      const text = extractContentText(msg.content).trim();
      lines.push(`[toolResult:${toolName}${isError}] ${text}`);
    }
  }
  return lines;
}

function isAssistantEntry(entry: EntryRecordPayload): boolean {
  if (entry.kind === "pi.assistant") return true;
  return (
    Array.isArray(entry.model) &&
    entry.model.some((msg) => isRecord(msg) && msg.role === "assistant")
  );
}

export class ConversationWatchRenderer {
  readonly #write: (text: string) => void;
  readonly #renderedEntryIds = new Set<number>();
  #livePrefix = "";
  #liveAttempt: number | undefined;

  constructor(write: (text: string) => void) {
    this.#write = write;
  }

  onSnapshot(view: ConversationViewPayload): void {
    this.#applyView(view);
  }

  onPatch(view: ConversationViewPayload): void {
    this.#applyView(view);
  }

  onFailed(message: string): void {
    this.#flushOpenLiveLine();
    this.#write(`[failed] ${message}\n`);
  }

  onEnd(): void {
    this.#flushOpenLiveLine();
  }

  #applyView(view: ConversationViewPayload): void {
    for (const entry of view.entries) {
      if (this.#renderedEntryIds.has(entry.id)) continue;
      this.#renderedEntryIds.add(entry.id);

      if (isAssistantEntry(entry)) {
        const text = extractEntryAssistantText(entry);
        if (this.#livePrefix.length > 0) {
          if (text.startsWith(this.#livePrefix)) {
            const remaining = text.slice(this.#livePrefix.length);
            if (remaining.length > 0) this.#write(remaining);
            this.#write("\n");
          } else {
            this.#write("\n");
            if (text.length > 0) this.#write(`[assistant] ${text}\n`);
          }
          this.#livePrefix = "";
          this.#liveAttempt = undefined;
        } else if (text.length > 0) {
          this.#write(`[assistant] ${text}\n`);
        }
        for (const extra of extractAssistantExtraLines(entry)) {
          this.#write(`${extra}\n`);
        }
      } else {
        const lines = formatNonAssistantEntryLines(entry);
        if (lines.length > 0) {
          this.#flushOpenLiveLine();
          for (const line of lines) this.#write(`${line}\n`);
        }
      }
    }

    const liveDoc = view.docs["pi.live"];
    const generation =
      isRecord(liveDoc) && isRecord(liveDoc.generation) ? liveDoc.generation : undefined;
    const liveMessage = generation?.message;
    if (liveMessage !== undefined) {
      const attempt = typeof generation?.attempt === "number" ? generation.attempt : undefined;
      if (
        attempt !== undefined &&
        this.#liveAttempt !== undefined &&
        attempt !== this.#liveAttempt
      ) {
        this.#flushOpenLiveLine();
      }
      this.#liveAttempt = attempt;

      const liveText = extractAssistantTextFromMessage(liveMessage);
      if (liveText.length > 0) {
        if (this.#livePrefix.length === 0) {
          this.#write(`[assistant] ${liveText}`);
          this.#livePrefix = liveText;
        } else if (liveText.startsWith(this.#livePrefix)) {
          const delta = liveText.slice(this.#livePrefix.length);
          if (delta.length > 0) {
            this.#write(delta);
            this.#livePrefix = liveText;
          }
        } else {
          this.#write(`\n[assistant] ${liveText}`);
          this.#livePrefix = liveText;
        }
      }
    } else if (this.#livePrefix.length > 0) {
      this.#flushOpenLiveLine();
    }
  }

  #flushOpenLiveLine(): void {
    if (this.#livePrefix.length > 0) {
      this.#write("\n");
      this.#livePrefix = "";
    }
    this.#liveAttempt = undefined;
  }
}

export function formatQuestionAnswered(response: AnswerQuestionResponse): string {
  const { question } = response;
  const count = question.answers?.length ?? 0;
  return `Answered question ${question.id} (${count} answer${count === 1 ? "" : "s"})`;
}

export const TASK_FILTER_MAX_CONTEXT_LINES = 5;

export type TaskListItem = BackgroundTaskRecordPayload & {
  readonly workerId?: string;
};

export function isActiveTaskStatus(status: BackgroundTaskStatus): boolean {
  switch (status) {
    case "queued":
    case "running":
    case "stopping":
      return true;
    case "completed":
    case "failed":
    case "timed_out":
    case "cancelled":
    case "interrupted":
      return false;
  }
}

function formatTaskStatusDetails(task: BackgroundTaskRecordPayload): string {
  const details: string[] = [];
  if (task.exitCode !== undefined) details.push(`exit ${task.exitCode}`);
  if (task.cancelReason !== undefined) details.push(`reason ${task.cancelReason}`);
  if (task.error !== undefined) details.push(task.error);
  return details.length === 0 ? "" : ` (${details.join(", ")})`;
}

function formatTaskStatusLabel(task: BackgroundTaskRecordPayload): string {
  return `${task.status}${formatTaskStatusDetails(task)}`;
}

export function aggregateBoardTasks(
  board: BoardViewPayload,
  options?: { readonly status?: TaskListStatusFilter; readonly limit?: number },
): TaskListItem[] {
  const status = options?.status ?? "all";
  const limit = options?.limit;
  const all: TaskListItem[] = [];
  for (const worker of board.workers) {
    for (const task of worker.tasks) {
      all.push({ ...task, workerId: worker.id });
    }
  }
  const byStartedAt = (a: TaskListItem, b: TaskListItem): number => {
    if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
    const workerCmp = (a.workerId ?? "").localeCompare(b.workerId ?? "");
    return workerCmp !== 0 ? workerCmp : a.id.localeCompare(b.id);
  };
  const active = all.filter((item) => isActiveTaskStatus(item.status)).sort(byStartedAt);
  const finished = all.filter((item) => !isActiveTaskStatus(item.status)).sort(byStartedAt);

  if (status === "active") {
    return limit === undefined ? active : limit <= 0 ? [] : active.slice(-limit);
  }
  if (status === "finished") {
    return limit === undefined ? finished : limit <= 0 ? [] : finished.slice(-limit);
  }
  if (limit === undefined) {
    return [...active, ...finished];
  }
  if (limit <= 0) return [];
  if (active.length >= limit) {
    return active.slice(-limit);
  }
  const remaining = limit - active.length;
  return [...active, ...finished.slice(-remaining)];
}

export function formatTaskList(
  tasks: readonly TaskListItem[],
  options?: { readonly showWorker?: boolean },
): string {
  if (tasks.length === 0) return "No tasks.";
  const showWorker = options?.showWorker ?? tasks.some((task) => task.workerId !== undefined);
  return tasks
    .map((task) => {
      const command = task.command.replace(/\r?\n/g, " ");
      const statusText = formatTaskStatusLabel(task);
      return showWorker
        ? `${task.workerId ?? "-"}\t${task.id}\t${statusText}\t${command}`
        : `${task.id}\t${statusText}\t${command}`;
    })
    .join("\n");
}

export function formatTaskOutput(workerId: string, response: ReadWorkerTaskResponse): string {
  const { task, output } = response;
  const statusDetails = formatTaskStatusDetails(task);
  const bytesParts = [
    `Bytes ${output.fromByte}..${output.endByte} of ${output.totalBytes}${output.truncated ? " (truncated)" : ""}`,
  ];
  if (output.matchedLines !== undefined || output.totalMatchedLines !== undefined) {
    const matched = output.matchedLines ?? 0;
    const total = output.totalMatchedLines ?? matched;
    const scanNote = output.scanTruncated ? ", scan truncated" : "";
    bytesParts.push(`Matches: ${matched} of ${total} line(s)${scanNote}`);
  } else if (output.scanTruncated) {
    bytesParts.push("Scan truncated");
  }

  const lines = [
    `Worker ${workerId} task ${task.id} [${task.status}]${statusDetails} — ${task.command}`,
    bytesParts.join(" | "),
  ];

  const warnings: string[] = [];
  if (task.logTruncated) {
    warnings.push("log truncated (output exceeded log size limit)");
  }
  if (task.logError !== undefined) {
    warnings.push(`log error: ${task.logError}`);
  }
  if (warnings.length > 0) {
    lines.push(`Warnings: ${warnings.join("; ")}`);
  }

  if (output.text.length > 0) {
    lines.push("", output.text);
  }
  return lines.join("\n");
}

export function buildTaskLineMatcher(rawFilter: string): (line: string) => boolean {
  if (rawFilter.length === 0) {
    throw new Error("Invalid --filter: must not be empty");
  }
  const regexMatch = /^\/(.+)\/([dgimsuvy]*)$/.exec(rawFilter);
  if (regexMatch !== null) {
    const pattern = regexMatch[1] ?? "";
    const flags = regexMatch[2] ?? "";
    try {
      new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(
        `Invalid filter regular expression: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const stateless = new RegExp(pattern, flags.replace(/[gy]/g, ""));
    return (line) => stateless.test(line);
  }
  const needle = rawFilter.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

export type TaskWatchRendererOptions = {
  readonly workerId: string;
  readonly filter?: string;
  readonly contextLines?: number;
};

export class TaskWatchRenderer {
  readonly #write: (text: string) => void;
  readonly #workerId: string;
  readonly #matcher?: (line: string) => boolean;
  readonly #contextLines: number;
  readonly #beforeRing: Array<{ readonly lineNo: number; readonly text: string }> = [];
  #pendingLine = "";
  #lineNo = 0;
  #lastEmittedLine = 0;
  #trailingContext = 0;
  #hasOutput = false;
  #endedWithNewline = true;
  #lastStatus?: BackgroundTaskStatus;
  #warnedLogTruncated = false;
  #warnedLogError?: string;

  constructor(write: (text: string) => void, options: TaskWatchRendererOptions) {
    this.#write = write;
    this.#workerId = options.workerId;
    if (options.contextLines !== undefined) {
      if (options.filter === undefined || options.filter.length === 0) {
        throw new Error("--context requires --filter");
      }
      if (
        !Number.isInteger(options.contextLines) ||
        options.contextLines < 0 ||
        options.contextLines > TASK_FILTER_MAX_CONTEXT_LINES
      ) {
        throw new Error(
          `Invalid --context "${options.contextLines}": expected integer 0..${TASK_FILTER_MAX_CONTEXT_LINES}`,
        );
      }
    }
    this.#matcher = options.filter === undefined ? undefined : buildTaskLineMatcher(options.filter);
    this.#contextLines = options.contextLines ?? 0;
  }

  onSnapshot(task: BackgroundTaskRecordPayload, output: OutputSlice): void {
    this.#lastStatus = task.status;
    this.#write(
      `Worker ${this.#workerId} task ${task.id} [${task.status}]${formatTaskStatusDetails(task)} — ${task.command}\n`,
    );
    this.#emitLogWarnings(task);
    if (output.truncated || output.fromByte > 0) {
      this.#write(
        `Bytes ${output.fromByte}..${output.endByte} of ${output.totalBytes}${output.truncated ? " (truncated)" : ""}\n`,
      );
    }
    if (output.text.length > 0) {
      this.#feedOutput(output.text);
    }
  }

  onChunk(text: string): void {
    if (text.length > 0) {
      this.#feedOutput(text);
    }
  }

  onStatus(task: BackgroundTaskRecordPayload): void {
    if (!isActiveTaskStatus(task.status)) {
      this.#flushPendingLine();
    }
    this.#ensureLineBreakBeforeMeta();
    const prev = this.#lastStatus;
    const details = formatTaskStatusDetails(task);
    if (prev !== undefined && prev !== task.status) {
      this.#write(`[status] ${prev} -> ${task.status}${details}\n`);
    } else {
      this.#write(`[status] ${task.status}${details}\n`);
    }
    this.#emitLogWarnings(task);
    this.#lastStatus = task.status;
  }

  onEnd(event: Extract<TaskStreamEvent, { readonly type: "end" }>): void {
    this.#flushPendingLine();
    this.#ensureLineBreakBeforeMeta();
    const suffix = event.message === undefined ? "" : `: ${event.message}`;
    this.#write(`[end] ${event.reason}${suffix}\n`);
  }

  #emitLogWarnings(task: BackgroundTaskRecordPayload): void {
    if (task.logTruncated && !this.#warnedLogTruncated) {
      this.#warnedLogTruncated = true;
      this.#ensureLineBreakBeforeMeta();
      this.#write("Warning: log truncated (output exceeded log size limit)\n");
    }
    if (task.logError !== undefined && task.logError !== this.#warnedLogError) {
      this.#warnedLogError = task.logError;
      this.#ensureLineBreakBeforeMeta();
      this.#write(`Warning: log error: ${task.logError}\n`);
    }
  }

  #ensureLineBreakBeforeMeta(): void {
    if (this.#hasOutput && !this.#endedWithNewline) {
      this.#write("\n");
      this.#endedWithNewline = true;
    }
  }

  #feedOutput(text: string): void {
    if (this.#matcher === undefined) {
      this.#write(text);
      this.#hasOutput = true;
      this.#endedWithNewline = text.endsWith("\n");
      return;
    }
    this.#pendingLine += text;
    let nl = this.#pendingLine.indexOf("\n");
    while (nl !== -1) {
      this.#processLine(this.#pendingLine.slice(0, nl));
      this.#pendingLine = this.#pendingLine.slice(nl + 1);
      nl = this.#pendingLine.indexOf("\n");
    }
  }

  #flushPendingLine(): void {
    if (this.#matcher !== undefined && this.#pendingLine.length > 0) {
      const remaining = this.#pendingLine;
      this.#pendingLine = "";
      this.#processLine(remaining);
    }
  }

  #processLine(rawLine: string): void {
    const matcher = this.#matcher;
    if (matcher === undefined) return;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    this.#lineNo += 1;

    if (matcher(line)) {
      for (const before of this.#beforeRing) {
        this.#emitFilteredEntry(before.lineNo, "-", before.text);
      }
      this.#emitFilteredEntry(this.#lineNo, ":", line);
      this.#trailingContext = this.#contextLines;
    } else if (this.#trailingContext > 0) {
      this.#emitFilteredEntry(this.#lineNo, "-", line);
      this.#trailingContext -= 1;
    }

    if (this.#contextLines > 0) {
      this.#beforeRing.push({ lineNo: this.#lineNo, text: line });
      if (this.#beforeRing.length > this.#contextLines) {
        this.#beforeRing.shift();
      }
    }
  }

  #emitFilteredEntry(num: number, sep: ":" | "-", text: string): void {
    if (num <= this.#lastEmittedLine) return;
    if (this.#contextLines > 0 && this.#lastEmittedLine > 0 && num > this.#lastEmittedLine + 1) {
      this.#write("--\n");
    }
    this.#write(`${num}${sep} ${text}\n`);
    this.#lastEmittedLine = num;
    this.#hasOutput = true;
    this.#endedWithNewline = true;
  }
}

export function formatProviders(response: ListProvidersResponse): string {
  if (response.providers.length === 0) return "No providers.";
  return response.providers
    .map((provider) => {
      const methods = [
        provider.authMethods.apiKey ? "api_key" : undefined,
        provider.authMethods.oauth ? "oauth" : undefined,
      ]
        .filter((value): value is string => value !== undefined)
        .join(", ");
      const status = provider.configured
        ? `configured (${provider.authType ?? "unknown"}${provider.authSource ? `: ${provider.authSource}` : ""})`
        : "unconfigured";
      return `${provider.id}\t${provider.name}\t${status}\tmethods=[${methods}]\tmodels=${provider.modelCount}`;
    })
    .join("\n");
}

export function formatModels(response: ListModelsResponse): string {
  if (response.models.length === 0) return "No models.";
  return response.models
    .map(
      (model) =>
        `${model.provider}/${model.id}\t${model.name}\t${model.api}\treasoning=${model.reasoning}\tctx=${model.contextWindow}\tavailable=${model.available}`,
    )
    .join("\n");
}

export function formatRefreshModels(response: RefreshModelsResponse): string {
  const entries = Object.entries(response.errors);
  if (entries.length === 0) return "Refreshed models.";
  return [
    "Refreshed models with errors:",
    ...entries.map(([providerId, message]) => `- ${providerId}: ${message}`),
  ].join("\n");
}

export function formatModelProfiles(doc: ModelProfilesDocument): string {
  const lines: string[] = [];
  if (doc.profiles.length === 0) {
    lines.push("No model profiles configured.");
  } else {
    for (const profile of doc.profiles) {
      const thinking =
        profile.model.thinkingLevel === undefined ? "" : ` (${profile.model.thinkingLevel})`;
      lines.push(
        `${profile.id}\t${profile.model.provider}/${profile.model.modelId}${thinking}\t${profile.description}`,
      );
    }
  }
  if (doc.notes !== undefined && doc.notes.trim().length > 0) {
    lines.push("", `Notes: ${doc.notes}`);
  }
  return lines.join("\n");
}

export function formatMcpStatus(status: readonly McpServerSnapshotPayload[]): string {
  if (status.length === 0) return "No MCP servers configured.";
  return status
    .map((server) => {
      const state = server.enabled ? server.status : `${server.status} (disabled)`;
      const err = server.error === undefined ? "" : `\terror=${server.error}`;
      return `${server.name}\t${state}\ttools=${server.toolCount}${err}`;
    })
    .join("\n");
}

export function formatMcpState(state: McpStateResponse): string {
  return formatMcpStatus(state.status);
}

export function formatSettings(settings: EngineSettings): string {
  return JSON.stringify(settings, null, 2);
}

export function formatProjectUsage(response: ProjectUsageResponse): string {
  const lines: string[] = [`Usage for project ${response.projectId}:`];
  const models = Object.entries(response.usage.models);
  const tools = Object.entries(response.usage.tools);
  if (models.length === 0 && tools.length === 0) {
    lines.push("No recorded usage yet.");
    return lines.join("\n");
  }
  if (models.length > 0) {
    lines.push("Models:");
    for (const [key, metric] of models) {
      lines.push(
        `- ${key}: totalTokens=${metric.totalTokens} (in=${metric.input}, out=${metric.output}, cacheRead=${metric.cacheRead}, cacheWrite=${metric.cacheWrite}) cost=$${metric.cost.total.toFixed(6)}`,
      );
    }
  }
  if (tools.length > 0) {
    lines.push("Tools:");
    for (const [key, metric] of tools) {
      lines.push(
        `- ${key}: totalTokens=${metric.totalTokens} cost=$${metric.cost.total.toFixed(6)}`,
      );
    }
  }
  return lines.join("\n");
}
