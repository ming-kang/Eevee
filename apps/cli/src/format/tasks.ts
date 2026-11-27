import {
  type BackgroundTaskRecordPayload,
  type BackgroundTaskStatus,
  isActiveTaskStatus,
  type OutputSlice,
  type ReadWorkerTaskResponse,
  type TaskStreamEvent,
} from "@eevee/protocol";
import { validateTaskFilterOptions } from "../args.ts";
import { tabular } from "./settings.ts";

export type TaskListItem = BackgroundTaskRecordPayload & {
  readonly workerId?: string;
};

function formatTaskStatusDetails(task: BackgroundTaskRecordPayload): string {
  const details: string[] = [];
  if (task.exitCode !== undefined) details.push(`exit ${task.exitCode}`);
  if (task.cancelReason !== undefined) details.push(`reason ${task.cancelReason}`);
  if (task.error !== undefined) details.push(task.error);
  return details.length === 0 ? "" : ` (${details.join(", ")})`;
}

export function formatTaskList(
  tasks: readonly TaskListItem[],
  options?: { readonly showWorker?: boolean },
): string {
  if (tasks.length === 0) return "No tasks.";
  const showWorker = options?.showWorker ?? tasks.some((task) => task.workerId !== undefined);
  return tabular(
    tasks.map((task) => {
      const command = task.command.replace(/\r?\n/g, " ");
      const statusText = `${task.status}${formatTaskStatusDetails(task)}`;
      return showWorker
        ? [task.workerId ?? "-", task.id, statusText, command]
        : [task.id, statusText, command];
    }),
  );
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
    this.#matcher = validateTaskFilterOptions(options);
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
