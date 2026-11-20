import { createWriteStream, type WriteStream } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Job, JobId, JobOutcome, TicketId } from "../contracts/index.ts";
import {
  type DeliveryContext,
  deliver,
  describeJobOutcome,
  readBinding,
  readTicket,
  registerJob,
  route,
  runningJobs,
  settleJob,
} from "../extensions/orchestration/index.ts";
import type {
  BackgroundJobs,
  CommandResult,
  RunningCommand,
} from "../extensions/workspace/index.ts";
import { isNotFound } from "../shared/fs.ts";

const TAIL_CHARS = 2000;
const JOB_LOG_MAX_BYTES = 64 * 1024;
/** A job log view without a `maxLines` carries this many lines from the log's end. */
export const JOB_LOG_DEFAULT_LINES = 200;

export type JobHostDeps = {
  logPath(id: JobId): string;
  delivery(): DeliveryContext;
  onChange(): void;
  context: Context;
  now?: () => number;
};

type Tracked = { job: Job; command: RunningCommand; settled: Promise<void>; settling?: boolean };

export class JobHost implements BackgroundJobs {
  readonly #deps: JobHostDeps;
  readonly #running = new Map<JobId, Tracked>();
  /** Why a job was killed: its ticket closed (nobody to tell), or someone stopped it (its Worker hears). */
  readonly #killed = new Map<JobId, "closed" | "stopped">();
  #closing = false;

  constructor(deps: JobHostDeps) {
    this.#deps = deps;
  }

  async adopt(
    api: ToolExecutionApi,
    command: RunningCommand,
    context: Context,
  ): Promise<JobId | undefined> {
    const initial = command.output();
    const pending: string[] = [];
    let write = (chunk: string) => {
      pending.push(chunk);
    };
    command.onOutput((chunk) => write(chunk));

    const ticketId = await readBinding(api, api.conversationId, context);
    if (ticketId === undefined) {
      write = () => {};
      return undefined;
    }
    const job = await api.commit(
      (tx) => registerJob(tx, { ticketId, command: command.command, startedAt: api.now() }),
      context,
    );
    const log = await openLog(this.#deps.logPath(job.id));
    log.write(`$ ${command.command}\n${initial}${pending.join("")}`);
    write = (chunk) => {
      log.write(chunk);
    };
    const settled = command.done.then((result) => this.#settle(job, command, result, log));
    this.#running.set(job.id, { job, command, settled });
    this.#deps.onChange();
    return job.id;
  }

  running(ticketId?: TicketId): Job[] {
    return [...this.#running.values()]
      .map((t) => t.job)
      .filter((job) => ticketId === undefined || job.ticketId === ticketId);
  }

  stop(ticketId: TicketId): void {
    for (const tracked of this.#running.values()) {
      if (tracked.job.ticketId !== ticketId || tracked.settling) continue;
      this.#killed.set(tracked.job.id, "closed");
      tracked.command.kill();
    }
  }

  async kill(id: JobId): Promise<boolean> {
    const tracked = this.#running.get(id);
    if (tracked === undefined || tracked.settling) return false;
    this.#killed.set(id, "stopped");
    tracked.command.kill();
    await tracked.settled;
    return true;
  }

  async close(): Promise<void> {
    this.#closing = true;
    const tracked = [...this.#running.values()];
    for (const { command } of tracked) command.kill();
    await Promise.allSettled(tracked.map((t) => t.settled));
  }

  async recover(): Promise<void> {
    const { context } = this.#deps;
    const host = this.#deps.delivery();
    const orphans = await runningJobs(host, context);
    const byTicket = new Map<TicketId, Job[]>();
    for (const job of orphans)
      byTicket.set(job.ticketId, [...(byTicket.get(job.ticketId) ?? []), job]);
    for (const [ticketId, jobs] of byTicket) {
      const ticket = await readTicket(host, ticketId, context);
      const deliveries =
        ticket?.status === "open"
          ? route({ type: "jobs-interrupted", ticketId, jobIds: jobs.map((j) => j.id) })
          : [];
      await deliver(host, deliveries, context, async (tx) => {
        for (const job of jobs) {
          await settleJob(tx, job, { status: "interrupted", endedAt: this.#now() });
        }
      });
    }
  }

  async #settle(
    job: Job,
    command: RunningCommand,
    result: CommandResult,
    log: WriteStream,
  ): Promise<void> {
    const tracked = this.#running.get(job.id);
    if (tracked !== undefined) tracked.settling = true;
    const killedFor = this.#killed.get(job.id);
    this.#killed.delete(job.id);
    const outcome: JobOutcome = {
      status: killedFor === undefined ? "exited" : "killed",
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
    log.write(`\n[${describeJobOutcome(outcome)}]\n`);
    await new Promise<void>((resolve) => log.end(resolve));
    this.#running.delete(job.id);
    if (this.#closing) return;
    this.#deps.onChange();

    const { context } = this.#deps;
    const host = this.#deps.delivery();
    const ticket = await readTicket(host, job.ticketId, context);
    const deliveries =
      killedFor === "closed" || ticket?.status !== "open"
        ? []
        : route({
            type: "job-finished",
            ticketId: job.ticketId,
            jobId: job.id,
            outcome,
            tail: command.output().slice(-TAIL_CHARS),
          });
    await deliver(host, deliveries, context, async (tx) => {
      await settleJob(tx, job, { ...outcome, endedAt: this.#now() });
    });
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }
}

async function openLog(path: string): Promise<WriteStream> {
  await mkdir(dirname(path), { recursive: true });
  return createWriteStream(path, { flags: "a" });
}

/**
 * The last `maxLines` lines of a job's log, within the last `JOB_LOG_MAX_BYTES`; a missing or empty log is an
 * empty, untruncated view.
 */
export async function readLogTail(
  path: string,
  maxLines: number,
): Promise<{ content: string; truncated: boolean }> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isNotFound(error)) return { content: "", truncated: false };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return { content: "", truncated: false };
    const readBytes = Math.min(size, JOB_LOG_MAX_BYTES);
    const offset = size - readBytes;
    const buf = Buffer.allocUnsafe(readBytes);
    let totalRead = 0;
    while (totalRead < readBytes) {
      const { bytesRead } = await handle.read(
        buf,
        totalRead,
        readBytes - totalRead,
        offset + totalRead,
      );
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    let text = buf.subarray(0, totalRead).toString("utf8");
    const truncatedByBytes = offset > 0;
    if (truncatedByBytes) {
      const nl = text.indexOf("\n");
      if (nl >= 0) {
        text = text.slice(nl + 1);
      } else if (text.startsWith("�")) {
        text = text.replace(/^�+/, "");
      }
    }
    const lines = text.split(/\r?\n/);
    const hasTrailingNewline = lines.length > 1 && lines.at(-1) === "";
    const bodyLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
    const truncatedByLines = bodyLines.length > maxLines;
    const tailLines = truncatedByLines ? bodyLines.slice(-maxLines) : bodyLines;
    return {
      content: tailLines.join("\n") + (hasTrailingNewline && tailLines.length > 0 ? "\n" : ""),
      truncated: truncatedByBytes || truncatedByLines,
    };
  } finally {
    await handle.close();
  }
}
