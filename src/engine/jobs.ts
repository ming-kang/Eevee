import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
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

const TAIL_CHARS = 2000;

export type JobHostDeps = {
  logPath(id: JobId): string;
  delivery(): DeliveryContext;
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
  /** Bumped whenever the set of running jobs changes, so a cached board knows when to rebuild. */
  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

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
    this.#revision += 1;
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

  /** Kills one running background job and waits for its log & durable state to settle. */
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
    this.#revision += 1;
    if (this.#closing) return;

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
