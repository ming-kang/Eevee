import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { utf8ByteLength } from "@earendil-works/chord/output";
import type { ConversationId } from "@earendil-works/pi-durable";
import type {
  ExecutionEnv,
  ExecutionError,
  Result,
  ShellExecOptions,
  ShellExecResult,
  ShellSpillOptions,
} from "@earendil-works/pi-durable/env";
import { errorMessage } from "../../shared/guards.ts";
import { alignUtf8Start, formatSize, utf8HeadBytes } from "../../shared/truncate.ts";
import { type ResolvedPowerShell, resolvePowerShell } from "../../shell/discovery.ts";
import { normalizeCommandForEnv } from "../../shell/env.ts";
import type { BackgroundTaskRecord } from "./docs.ts";
import {
  clampReadBytes,
  type OutputReadOptions,
  type OutputSlice,
  readOutputFileSlice,
  sliceRetainedOutput,
  utf8Tail,
  validateOutputReadOptions,
} from "./output.ts";

const RETAINED_OUTPUT_BYTES = 2 * 1024 * 1024;
const MEMORY_LOG_BYTES = 256 * 1024;

export const DEFAULT_MAX_LOG_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_ACTIVE_PER_CONVERSATION = 4;
export const DEFAULT_MAX_ACTIVE_TOTAL = 8;
export const DEFAULT_MAX_FINISHED_PER_CONVERSATION = 32;

export type TaskShell = "bash" | "powershell";
export type TaskKillReason = "user" | "tool" | "abort";
export type LogOverflowPolicy = "truncate" | "fail";

export type CommandOutcome =
  | { readonly kind: "exit"; readonly exitCode: number; readonly spillPath?: string }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
      readonly spillPath?: string;
    };

export type CommandOutput = {
  readonly text: string;
  readonly totalBytes: number;
  readonly droppedBytes: number;
};

export type StartCommandOptions = {
  readonly shell?: TaskShell;
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly inheritEnv?: boolean;
  readonly timeoutSeconds?: number;
  readonly spill?: ShellSpillOptions;
  readonly platform?: NodeJS.Platform;
  readonly powerShell?: ResolvedPowerShell;
  readonly resolvePowerShell?: () => Promise<ResolvedPowerShell | undefined>;
};

export type RunningCommand = {
  readonly shell: TaskShell;
  readonly command: string;
  readonly cwd?: string;
  readonly rewrittenNul: boolean;
  readonly settled: boolean;
  readonly ready: Promise<void>;
  /** Set only by an explicit kill request, never by a shutdown cancellation. */
  readonly killed: boolean;
  readonly killReason?: TaskKillReason;
  readonly done: Promise<CommandOutcome>;
  output(): CommandOutput;
  /** Listen to live chunks; earlier chunks are not replayed. Returns a detach. */
  onOutput(listener: (chunk: string) => void): () => void;
  kill(reason: TaskKillReason): void;
  detachCancel(): void;
};

/**
 * Start a command detached from any invocation: the process dies only on `kill()`,
 * so a background command survives the tool call and host turns that started it.
 */
export function startCommand(env: ExecutionEnv, options: StartCommandOptions): RunningCommand {
  const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
  const shell: TaskShell = options.shell ?? "bash";
  let killed = false;
  let killReason: TaskKillReason | undefined;
  let settled = false;
  let chunks: string[] = [];
  let retainedBytes = 0;
  let totalBytes = 0;
  const listeners = new Set<(chunk: string) => void>();

  const push = (chunk: string) => {
    totalBytes += utf8ByteLength(chunk);
    retainedBytes += utf8ByteLength(chunk);
    chunks.push(chunk);
    for (const listener of [...listeners]) {
      try {
        listener(chunk);
      } catch {
        // A listener must not break the command's own output callback.
      }
    }
    if (retainedBytes > RETAINED_OUTPUT_BYTES) {
      const buffer = Buffer.from(chunks.join(""), "utf8");
      const start = alignUtf8Start(buffer, buffer.length - RETAINED_OUTPUT_BYTES);
      chunks = [buffer.subarray(start).toString("utf8")];
      retainedBytes = buffer.length - start;
    }
  };

  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const normalized =
    shell === "bash"
      ? normalizeCommandForEnv(env, options.command, options.platform)
      : { command: options.command, rewrittenNul: false };

  const execOptions: ShellExecOptions = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ?? {},
    ...(options.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
    ...(options.timeoutSeconds === undefined ? {} : { timeout: options.timeoutSeconds }),
    ...(options.spill === undefined ? {} : { spill: options.spill }),
    onOutput: (text: string) => push(text),
  };

  const toOutcome = (
    result:
      | { readonly ok: true; readonly value: ShellExecResult }
      | {
          readonly ok: false;
          readonly error: { code: string; message: string; spillPath?: string };
        },
  ): CommandOutcome => {
    settled = true;
    if (result.ok) {
      return {
        kind: "exit",
        exitCode: result.value.exitCode,
        ...(result.value.spillPath === undefined ? {} : { spillPath: result.value.spillPath }),
      };
    }
    return {
      kind: "error",
      code: result.error.code,
      message: result.error.message,
      ...(result.error.spillPath === undefined ? {} : { spillPath: result.error.spillPath }),
    };
  };

  const runExec = (target: string | readonly string[]): Promise<CommandOutcome> => {
    let execPromise: Promise<Result<ShellExecResult, ExecutionError>>;
    try {
      execPromise = env.exec(target, execOptions, context);
    } catch (error) {
      settled = true;
      resolveReady();
      return Promise.resolve({
        kind: "error",
        code: "unknown",
        message: errorMessage(error),
      });
    }
    const outcomePromise = execPromise.then(
      (result) => {
        const outcome = toOutcome(result);
        resolveReady();
        return outcome;
      },
      (error) => {
        settled = true;
        resolveReady();
        return {
          kind: "error",
          code: "unknown",
          message: errorMessage(error),
        } satisfies CommandOutcome;
      },
    );
    void Promise.resolve().then(resolveReady);
    return outcomePromise;
  };

  const startExec = (): Promise<CommandOutcome> => {
    if (shell === "bash") {
      return runExec(normalized.command);
    }
    if (options.powerShell !== undefined) {
      return runExec([
        options.powerShell.executable,
        ...options.powerShell.buildArgs(options.command),
      ]);
    }
    const resolvePs =
      options.resolvePowerShell ??
      (() =>
        resolvePowerShell({
          ...(options.platform === undefined ? {} : { platform: options.platform }),
          ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
        }));
    return resolvePs().then((ps) => {
      if (context.abortSignal?.aborted) {
        settled = true;
        resolveReady();
        return { kind: "error", code: "aborted", message: "aborted" } satisfies CommandOutcome;
      }
      if (ps === undefined) {
        settled = true;
        resolveReady();
        return {
          kind: "error",
          code: "shell_unavailable",
          message: "PowerShell executable (pwsh or powershell) is unavailable on this system.",
        } satisfies CommandOutcome;
      }
      return runExec([ps.executable, ...ps.buildArgs(options.command)]);
    });
  };

  const done = startExec().catch((error): CommandOutcome => {
    settled = true;
    resolveReady();
    return {
      kind: "error",
      code: "unknown",
      message: errorMessage(error),
    };
  });

  return {
    shell,
    command: options.command,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    rewrittenNul: normalized.rewrittenNul,
    get settled() {
      return settled;
    },
    ready,
    get killed() {
      return killed;
    },
    get killReason() {
      return killReason;
    },
    done,
    output: () => ({
      text: chunks.join(""),
      totalBytes,
      droppedBytes: totalBytes - retainedBytes,
    }),
    onOutput: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    kill: (reason: TaskKillReason) => {
      killed = true;
      killReason ??= reason;
      cancel();
    },
    detachCancel: () => {
      killReason ??= "abort";
      cancel();
    },
  };
}

export async function cleanupLog(logPath: string): Promise<void> {
  await rm(logPath, { force: true }).catch(() => undefined);
}

export type TaskLogStatus = {
  readonly logTruncated: boolean;
  readonly logError?: string;
  readonly overflowFailed?: boolean;
};

export type ActiveTaskEntry = {
  readonly conversationId: ConversationId;
  readonly taskId: string;
  readonly command: RunningCommand;
};

export type TaskManagerOptions = {
  readonly logPath?: (conversationId: ConversationId, taskId: string) => string;
  readonly maxLogBytes?: number;
  readonly logOverflowPolicy?: LogOverflowPolicy;
  readonly maxActivePerConversation?: number;
  readonly maxActiveTotal?: number;
  readonly maxFinishedPerConversation?: number;
};

type TaskKey = string;

type MutableLogState = {
  logTruncated: boolean;
  logError?: string;
  overflowFailed: boolean;
  writtenBytes: number;
  stopped: boolean;
};

type LogSink = {
  readonly stream: WriteStream;
  readonly detach: () => void;
  readonly state: MutableLogState;
};

type TaskEntry = {
  readonly conversationId: ConversationId;
  readonly taskId: string;
  running?: RunningCommand;
  sink?: LogSink;
  logState?: MutableLogState;
  memoryLog?: CommandOutput;
};

function clampPositiveInt(value: number | undefined, fallback: number, minimum = 1): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

function needsDiskFallback(output: CommandOutput, options: OutputReadOptions): boolean {
  if (output.droppedBytes <= 0) return false;
  if (options.filter !== undefined && options.filter !== "") return true;
  const mode = options.mode ?? "tail";
  const ceiling =
    options.endByte !== undefined && Number.isFinite(options.endByte)
      ? Math.min(output.totalBytes, Math.max(0, Math.floor(options.endByte)))
      : output.totalBytes;
  if (options.endByte !== undefined && ceiling <= output.droppedBytes) return true;
  const since =
    options.sinceBytes !== undefined && Number.isFinite(options.sinceBytes)
      ? Math.max(0, Math.floor(options.sinceBytes))
      : undefined;
  const effectiveSince = since === undefined || since > ceiling ? 0 : since;
  if (mode === "head") {
    return effectiveSince < output.droppedBytes;
  }
  return Math.max(effectiveSince, ceiling - clampReadBytes(options.bytes)) < output.droppedBytes;
}

export class TaskManager {
  readonly #logPath: TaskManagerOptions["logPath"];
  readonly maxLogBytes: number;
  readonly logOverflowPolicy: LogOverflowPolicy;
  readonly maxActivePerConversation: number;
  readonly maxActiveTotal: number;
  readonly maxFinishedPerConversation: number;
  readonly #entries = new Map<TaskKey, TaskEntry>();

  constructor(options: TaskManagerOptions = {}) {
    this.#logPath = options.logPath;
    this.maxLogBytes = clampPositiveInt(options.maxLogBytes, DEFAULT_MAX_LOG_BYTES);
    this.logOverflowPolicy = options.logOverflowPolicy ?? "truncate";
    this.maxActivePerConversation = clampPositiveInt(
      options.maxActivePerConversation,
      DEFAULT_MAX_ACTIVE_PER_CONVERSATION,
    );
    this.maxActiveTotal = clampPositiveInt(options.maxActiveTotal, DEFAULT_MAX_ACTIVE_TOTAL);
    this.maxFinishedPerConversation = clampPositiveInt(
      options.maxFinishedPerConversation,
      DEFAULT_MAX_FINISHED_PER_CONVERSATION,
      0,
    );
  }

  #key(conversationId: ConversationId, taskId: string): TaskKey {
    return `${conversationId}:${taskId}`;
  }

  #getOrCreateEntry(conversationId: ConversationId, taskId: string): TaskEntry {
    const key = this.#key(conversationId, taskId);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = { conversationId, taskId };
      this.#entries.set(key, entry);
    }
    return entry;
  }

  #pruneEntry(key: TaskKey): void {
    const entry = this.#entries.get(key);
    if (
      entry !== undefined &&
      entry.running === undefined &&
      entry.sink === undefined &&
      entry.logState === undefined &&
      entry.memoryLog === undefined
    ) {
      this.#entries.delete(key);
    }
  }

  logPathOf(conversationId: ConversationId, taskId: string): string | undefined {
    return this.#logPath?.(conversationId, taskId);
  }

  attach(conversationId: ConversationId, taskId: string, running: RunningCommand): void {
    const entry = this.#getOrCreateEntry(conversationId, taskId);
    entry.running = running;
  }

  get(conversationId: ConversationId, taskId: string): RunningCommand | undefined {
    return this.#entries.get(this.#key(conversationId, taskId))?.running;
  }

  activeCount(conversationId?: ConversationId): number {
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (entry.running === undefined || entry.running.settled) continue;
      if (conversationId === undefined || entry.conversationId === conversationId) {
        count += 1;
      }
    }
    return count;
  }

  listActive(conversationId?: ConversationId): ActiveTaskEntry[] {
    const active: ActiveTaskEntry[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.running === undefined || entry.running.settled) continue;
      if (conversationId === undefined || entry.conversationId === conversationId) {
        active.push({
          conversationId: entry.conversationId,
          taskId: entry.taskId,
          command: entry.running,
        });
      }
    }
    return active;
  }

  /** Detach the live command, keeping a bounded tail in the memory log unless `retain` is false. */
  delete(conversationId: ConversationId, taskId: string, retain = true): void {
    const key = this.#key(conversationId, taskId);
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.running === undefined) return;
    const running = entry.running;
    entry.running = undefined;
    if (!retain) {
      entry.logState = undefined;
      this.#pruneEntry(key);
      return;
    }
    const output = running.output();
    if (output.totalBytes === 0) {
      this.#pruneEntry(key);
      return;
    }
    const tail = utf8Tail(output.text, MEMORY_LOG_BYTES);
    entry.memoryLog = {
      text: tail.text,
      totalBytes: output.totalBytes,
      droppedBytes: output.droppedBytes + tail.fromByte,
    };
  }

  kill(conversationId: ConversationId, taskId: string, reason: TaskKillReason = "tool"): boolean {
    const running = this.#entries.get(this.#key(conversationId, taskId))?.running;
    if (running === undefined) return false;
    running.kill(reason);
    return true;
  }

  subscribeOutput(
    conversationId: ConversationId,
    taskId: string,
    listener: (chunk: string) => void,
  ): (() => void) | undefined {
    const running = this.get(conversationId, taskId);
    return running?.onOutput(listener);
  }

  logStatus(conversationId: ConversationId, taskId: string): TaskLogStatus {
    const state = this.#entries.get(this.#key(conversationId, taskId))?.logState;
    if (state === undefined) return { logTruncated: false };
    return {
      logTruncated: state.logTruncated,
      ...(state.logError === undefined ? {} : { logError: state.logError }),
      ...(state.overflowFailed ? { overflowFailed: true } : {}),
    };
  }

  /**
   * Stream everything the command produced since byte 0 to the task's log file,
   * then keep appending live chunks until `finishLog()`.
   */
  async openLog(conversationId: ConversationId, taskId: string, running: RunningCommand) {
    const key = this.#key(conversationId, taskId);
    if (this.#entries.get(key)?.sink !== undefined) return;
    const path = this.#logPath?.(conversationId, taskId);
    if (path === undefined) return;

    const state: MutableLogState = {
      logTruncated: false,
      overflowFailed: false,
      writtenBytes: 0,
      stopped: false,
    };
    const entry = this.#getOrCreateEntry(conversationId, taskId);
    entry.logState = state;

    let stream: WriteStream;
    try {
      await mkdir(dirname(path), { recursive: true });
      stream = createWriteStream(path, { flags: "w" });
    } catch (error) {
      state.logError = errorMessage(error);
      state.stopped = true;
      return;
    }

    stream.on("error", (error) => {
      state.logError ??= errorMessage(error);
      state.stopped = true;
    });

    const writeChunk = (chunk: string) => {
      if (state.stopped || chunk.length === 0) return;
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (state.writtenBytes + chunkBytes <= this.maxLogBytes) {
        state.writtenBytes += chunkBytes;
        if (!stream.destroyed) stream.write(chunk);
        return;
      }
      const remaining = Math.max(0, this.maxLogBytes - state.writtenBytes);
      if (remaining > 0) {
        const prefix = utf8HeadBytes(chunk, remaining);
        if (prefix.length > 0) {
          state.writtenBytes += prefix.length;
          if (!stream.destroyed) stream.write(prefix);
        }
      }
      state.stopped = true;
      if (this.logOverflowPolicy === "truncate") {
        state.logTruncated = true;
        if (!stream.destroyed) {
          stream.write(`\n[output truncated at ${formatSize(this.maxLogBytes)} limit]\n`);
        }
      } else {
        state.logError = "Output exceeded background log size limit";
        state.overflowFailed = true;
        running.kill("abort");
      }
    };

    const snapshot = running.output();
    const detach = running.onOutput(writeChunk);
    entry.sink = { stream, detach, state };
    if (snapshot.droppedBytes > 0) {
      writeChunk(`[${snapshot.droppedBytes} bytes of earlier output were dropped]\n`);
    }
    writeChunk(snapshot.text);
  }

  async #closeSink(
    key: TaskKey,
    options?: { readonly footer?: string; readonly timeoutMs?: number },
  ): Promise<void> {
    const entry = this.#entries.get(key);
    const sink = entry?.sink;
    if (entry === undefined || sink === undefined) return;
    entry.sink = undefined;
    this.#pruneEntry(key);
    sink.detach();
    if (sink.stream.destroyed) return;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        sink.stream.off("error", onError);
        sink.stream.off("finish", done);
        resolve();
      };
      const onError = (error: unknown) => {
        sink.state.logError ??= errorMessage(error);
        sink.state.stopped = true;
        done();
      };
      if (options?.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          sink.stream.destroy();
          done();
        }, options.timeoutMs);
        timer.unref?.();
      }
      sink.stream.once("error", onError);
      sink.stream.once("finish", done);
      if (options?.footer !== undefined && !sink.state.stopped) {
        sink.stream.write(options.footer);
      }
      sink.stream.end();
    });
  }

  async finishLog(conversationId: ConversationId, taskId: string, footer?: string): Promise<void> {
    await this.#closeSink(
      this.#key(conversationId, taskId),
      footer === undefined ? undefined : { footer },
    );
  }

  async cleanupLog(logPath: string): Promise<void> {
    await cleanupLog(logPath);
  }

  async evict(conversationId: ConversationId, taskId: string, logPath?: string): Promise<void> {
    const key = this.#key(conversationId, taskId);
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      entry.memoryLog = undefined;
      entry.logState = undefined;
      this.#pruneEntry(key);
    }
    if (logPath !== undefined) {
      await cleanupLog(logPath);
    }
  }

  async readOutput(
    conversationId: ConversationId,
    taskId: string,
    record: BackgroundTaskRecord,
    options: OutputReadOptions = {},
  ): Promise<OutputSlice> {
    validateOutputReadOptions(options);
    const entry = this.#entries.get(this.#key(conversationId, taskId));
    const running = entry?.running;
    if (running !== undefined) {
      const output = running.output();
      if (record.logPath !== undefined && needsDiskFallback(output, options)) {
        try {
          return await readOutputFileSlice(record.logPath, options);
        } catch {
          // Fall through to the retained in-memory slice if reading the disk log fails.
        }
      }
      return sliceRetainedOutput(
        Buffer.from(output.text, "utf8"),
        output.droppedBytes,
        output.totalBytes,
        options,
      );
    }
    if (record.logPath !== undefined) {
      try {
        return await readOutputFileSlice(record.logPath, options);
      } catch {
        // Fall through to retained memory log when the disk file is missing or unreadable.
      }
    }
    const log = entry?.memoryLog;
    if (log !== undefined) {
      return sliceRetainedOutput(
        Buffer.from(log.text, "utf8"),
        log.droppedBytes,
        log.totalBytes,
        options,
      );
    }
    return { text: "", totalBytes: 0, truncated: false, fromByte: 0, endByte: 0 };
  }

  killAll(): void {
    for (const entry of this.#entries.values()) {
      entry.running?.detachCancel();
      if (entry.sink !== undefined) {
        entry.sink.detach();
        entry.sink.stream.destroy();
      }
    }
    this.#entries.clear();
  }

  async close(graceMs = 3_000): Promise<void> {
    const running: RunningCommand[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.running === undefined) continue;
      entry.running.detachCancel();
      running.push(entry.running);
    }
    if (running.length > 0) {
      const waitDone = Promise.allSettled(running.map((command) => command.done));
      const bounded = Math.max(0, graceMs);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          waitDone,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, bounded);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    for (const [key, entry] of this.#entries) {
      entry.running = undefined;
      this.#pruneEntry(key);
    }

    const sinkKeys: TaskKey[] = [];
    for (const [key, entry] of this.#entries) {
      if (entry.sink !== undefined) sinkKeys.push(key);
    }
    await Promise.all(sinkKeys.map((key) => this.#closeSink(key, { timeoutMs: 500 })));
    this.#entries.clear();
  }
}

export function createTaskManager(options: TaskManagerOptions = {}): TaskManager {
  return new TaskManager(options);
}
