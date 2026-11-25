import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { utf8ByteLength } from "@earendil-works/chord/output";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv, ShellSpillOptions } from "@earendil-works/pi-durable/env";
import type { BackgroundTaskRecord } from "./docs.ts";
import type { OutputReadOptions, OutputSlice } from "./output.ts";
import { readOutputFileSlice, sliceRetainedOutput, utf8Tail } from "./output.ts";

const RETAINED_OUTPUT_BYTES = 2 * 1024 * 1024;
const MEMORY_LOG_BYTES = 256 * 1024;

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
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutSeconds?: number;
  readonly spill?: ShellSpillOptions;
};

export type RunningCommand = {
  readonly command: string;
  readonly cwd?: string;
  readonly settled: boolean;
  /** Set only by an explicit kill request, never by a shutdown cancellation. */
  readonly killed: boolean;
  readonly done: Promise<CommandOutcome>;
  output(): CommandOutput;
  /** Listen to live chunks; earlier chunks are not replayed. Returns a detach. */
  onOutput(listener: (chunk: string) => void): () => void;
  kill(markKilled?: boolean): void;
};

/**
 * Start a command detached from any invocation: the process dies only on `kill()`,
 * so a background command survives the tool call and host turns that started it.
 */
export function startCommand(env: ExecutionEnv, options: StartCommandOptions): RunningCommand {
  const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
  let killed = false;
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
      let start = buffer.length - RETAINED_OUTPUT_BYTES;
      while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1;
      chunks = [buffer.subarray(start).toString("utf8")];
      retainedBytes = buffer.length - start;
    }
  };

  const done = env
    .exec(
      options.command,
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env ?? {},
        ...(options.timeoutSeconds === undefined ? {} : { timeout: options.timeoutSeconds }),
        ...(options.spill === undefined ? {} : { spill: options.spill }),
        onOutput: (text) => push(text),
      },
      context,
    )
    .then((result): CommandOutcome => {
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
    })
    .catch((error): CommandOutcome => {
      settled = true;
      return {
        kind: "error",
        code: "unknown",
        message: error instanceof Error ? error.message : String(error),
      };
    });

  return {
    command: options.command,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    get settled() {
      return settled;
    },
    get killed() {
      return killed;
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
    kill: (markKilled = true) => {
      if (markKilled) killed = true;
      cancel();
    },
  };
}

export type TaskManagerOptions = {
  readonly logPath?: (conversationId: ConversationId, taskId: string) => string;
};

type TaskKey = string;

type LogSink = {
  readonly stream: WriteStream;
  readonly detach: () => void;
};

export class TaskManager {
  readonly #logPath: TaskManagerOptions["logPath"];
  readonly #commands = new Map<TaskKey, RunningCommand>();
  readonly #sinks = new Map<TaskKey, LogSink>();
  readonly #memoryLogs = new Map<TaskKey, CommandOutput>();

  constructor(options: TaskManagerOptions = {}) {
    this.#logPath = options.logPath;
  }

  #key(conversationId: ConversationId, taskId: string): TaskKey {
    return `${conversationId}:${taskId}`;
  }

  logPathOf(conversationId: ConversationId, taskId: string): string | undefined {
    return this.#logPath?.(conversationId, taskId);
  }

  attach(conversationId: ConversationId, taskId: string, running: RunningCommand): void {
    this.#commands.set(this.#key(conversationId, taskId), running);
  }

  get(conversationId: ConversationId, taskId: string): RunningCommand | undefined {
    return this.#commands.get(this.#key(conversationId, taskId));
  }

  /** Detach the live command, keeping a bounded tail in the memory log unless `retain` is false. */
  delete(conversationId: ConversationId, taskId: string, retain = true): void {
    const key = this.#key(conversationId, taskId);
    const running = this.#commands.get(key);
    if (running === undefined) return;
    this.#commands.delete(key);
    if (!retain) return;
    const output = running.output();
    if (output.totalBytes === 0) return;
    const tail = utf8Tail(output.text, MEMORY_LOG_BYTES);
    this.#memoryLogs.set(key, {
      text: tail.text,
      totalBytes: output.totalBytes,
      droppedBytes: output.droppedBytes + tail.fromByte,
    });
  }

  kill(conversationId: ConversationId, taskId: string, markKilled = true): boolean {
    const running = this.#commands.get(this.#key(conversationId, taskId));
    if (running === undefined) return false;
    running.kill(markKilled);
    return true;
  }

  /**
   * Stream everything the command produced since byte 0 to the task's log file,
   * then keep appending live chunks until `finishLog()`.
   */
  async openLog(conversationId: ConversationId, taskId: string, running: RunningCommand) {
    const key = this.#key(conversationId, taskId);
    if (this.#sinks.has(key)) return;
    const path = this.#logPath?.(conversationId, taskId);
    if (path === undefined) return;
    await mkdir(dirname(path), { recursive: true });
    const stream = createWriteStream(path, { flags: "w" });
    stream.on("error", () => {});
    const snapshot = running.output();
    const detach = running.onOutput((chunk) => {
      if (!stream.destroyed) stream.write(chunk);
    });
    if (snapshot.droppedBytes > 0) {
      stream.write(`[${snapshot.droppedBytes} bytes of earlier output were dropped]\n`);
    }
    stream.write(snapshot.text);
    this.#sinks.set(key, { stream, detach });
  }

  async finishLog(conversationId: ConversationId, taskId: string, footer?: string): Promise<void> {
    const key = this.#key(conversationId, taskId);
    const sink = this.#sinks.get(key);
    if (sink === undefined) return;
    this.#sinks.delete(key);
    sink.detach();
    await new Promise<void>((resolve) => {
      const done = () => {
        sink.stream.off("error", done);
        sink.stream.off("finish", done);
        resolve();
      };
      sink.stream.once("error", done);
      sink.stream.once("finish", done);
      if (sink.stream.destroyed) {
        done();
        return;
      }
      if (footer !== undefined) sink.stream.write(footer);
      sink.stream.end();
    });
  }

  async readOutput(
    conversationId: ConversationId,
    taskId: string,
    record: BackgroundTaskRecord,
    options: OutputReadOptions = {},
  ): Promise<OutputSlice> {
    const key = this.#key(conversationId, taskId);
    const running = this.#commands.get(key);
    if (running !== undefined) {
      const output = running.output();
      return sliceRetainedOutput(
        Buffer.from(output.text, "utf8"),
        output.droppedBytes,
        output.totalBytes,
        options,
      );
    }
    if (record.logPath !== undefined) {
      const slice = await readOutputFileSlice(record.logPath, options).catch(() => undefined);
      if (slice !== undefined) return slice;
    }
    const log = this.#memoryLogs.get(key);
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
    for (const running of this.#commands.values()) running.kill(false);
    this.#commands.clear();
    for (const sink of this.#sinks.values()) {
      sink.detach();
      sink.stream.destroy();
    }
    this.#sinks.clear();
  }
}

export function createTaskManager(options: TaskManagerOptions = {}): TaskManager {
  return new TaskManager(options);
}
