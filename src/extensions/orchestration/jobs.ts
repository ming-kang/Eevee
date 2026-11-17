import type { Context } from "@earendil-works/chord/context";
import type { Tx } from "@earendil-works/pi-durable";
import { JobBoard, JobDoc } from "../../contracts/docs.ts";
import { type Job, jobId, type TicketId } from "../../contracts/index.ts";
import type { DocReader } from "./board.ts";

export async function registerJob(
  tx: Tx,
  input: Pick<Job, "ticketId" | "command" | "startedAt">,
): Promise<Job> {
  const board = await tx.doc(JobBoard);
  const job: Job = { ...input, id: jobId(board.nextJob), status: "running" };
  board.nextJob += 1;
  board.running.push(job.id);
  Object.assign(await tx.doc(JobDoc, job.id, job), job);
  return job;
}

export async function settleJob(
  tx: Tx,
  job: Job,
  outcome: Pick<Job, "status" | "exitCode" | "error" | "endedAt">,
): Promise<Job> {
  const board = await tx.doc(JobBoard);
  board.running = board.running.filter((j) => j !== job.id);
  const settled: Job = { ...job, ...outcome };
  Object.assign(await tx.doc(JobDoc, job.id, settled), settled);
  return settled;
}

export async function runningJobs(
  reader: DocReader,
  context: Context,
  ticketId?: TicketId,
): Promise<Job[]> {
  const ids = (await reader.snapshot(JobBoard, context))?.running ?? [];
  const jobs: Job[] = [];
  for (const id of ids) {
    const job = await reader.snapshot(JobDoc, id, context);
    if (job !== undefined && (ticketId === undefined || job.ticketId === ticketId)) jobs.push(job);
  }
  return jobs;
}
