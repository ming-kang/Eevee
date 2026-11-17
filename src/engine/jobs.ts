import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { formatAddress, type Job, type JobId, type TicketId } from "../contracts/index.ts";
import {
  type DeliveryContext,
  deliver,
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

const TAIL_CHARS = 2000;

export type JobHostDeps = {
  logPath(id: JobId): string;
  delivery(): DeliveryContext;
  context: Context;
  now?: () => number;
};

type Tracked = { job: Job; command: RunningCommand; settled: Promise<void> };

export class JobHost implements BackgroundJobs {
  readonly #deps: JobHostDeps;
  readonly #running = new Map<JobId, Tracked>();
  readonly #killed = new Set<JobId>();
  #closing = false;

  constructor(deps: JobHostDeps) {
    this.#deps = deps;
  }

  async adopt(
    api: ToolExecutionApi,
    command: RunningCommand,
    context: Context,
  ): Promise<string | undefined> {
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
    return formatAddress({ kind: "job", id: job.id });
  }

  running(ticketId?: TicketId): Job[] {
    return [...this.#running.values()]
      .map((t) => t.job)
      .filter((job) => ticketId === undefined || job.ticketId === ticketId);
  }

  stop(ticketId: TicketId): void {
    for (const { job, command } of this.#running.values()) {
      if (job.ticketId !== ticketId) continue;
      this.#killed.add(job.id);
      command.kill();
    }
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
    const killed = this.#killed.delete(job.id);
    log.write(`\n[${describe(result, killed)}]\n`);
    await new Promise<void>((resolve) => log.end(resolve));
    this.#running.delete(job.id);
    if (this.#closing) return;

    const { context } = this.#deps;
    const host = this.#deps.delivery();
    const outcome = {
      status: killed ? ("killed" as const) : ("exited" as const),
      endedAt: this.#now(),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
    const ticket = await readTicket(host, job.ticketId, context);
    const deliveries =
      killed || ticket?.status !== "open"
        ? []
        : route({
            type: "job-finished",
            ticketId: job.ticketId,
            jobId: job.id,
            outcome: describe(result, false),
            tail: command.output().slice(-TAIL_CHARS),
          });
    await deliver(host, deliveries, context, async (tx) => {
      await settleJob(tx, job, outcome);
    });
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }
}

function describe(result: CommandResult, killed: boolean): string {
  if (killed) return "已终止";
  if (result.error === "timeout") return "超时终止";
  if (result.error !== undefined) return `出错：${result.error}`;
  return `退出码 ${result.exitCode}`;
}

async function openLog(path: string): Promise<WriteStream> {
  await mkdir(dirname(path), { recursive: true });
  return createWriteStream(path, { flags: "a" });
}
