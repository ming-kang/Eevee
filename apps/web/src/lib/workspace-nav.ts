import type {
  BoardViewPayload,
  ProjectId,
  ProjectSummary,
  QuestionRecordPayload,
  TicketRecordPayload,
  WorkerBoardItemPayload,
  WorkerId,
} from "@eevee/protocol";
import { deriveBoardSummary, type VisualStage } from "./transcript.ts";

export function workerStage(worker: WorkerBoardItemPayload): VisualStage {
  if (worker.status === "running") return "working";
  if (worker.status === "queued") return "queued";
  if (worker.status === "closed") return "done";
  return "idle";
}

function workerUrgency(worker: WorkerBoardItemPayload): number {
  if (worker.status === "running") return 0;
  if (worker.status === "queued") return 1;
  if (worker.status === "idle") return 2;
  return 3;
}

export function partitionSidebarWorkers(workers: readonly WorkerBoardItemPayload[]): {
  readonly active: WorkerBoardItemPayload[];
  readonly closed: WorkerBoardItemPayload[];
} {
  const active: WorkerBoardItemPayload[] = [];
  const closed: WorkerBoardItemPayload[] = [];
  for (const worker of workers) {
    if (worker.status === "closed") closed.push(worker);
    else active.push(worker);
  }
  active.sort(
    (a, b) =>
      workerUrgency(a) - workerUrgency(b) ||
      b.activeTaskCount - a.activeTaskCount ||
      b.createdAt - a.createdAt,
  );
  closed.sort((a, b) => (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt));
  return { active, closed };
}

export function openBoardQuestions(board: BoardViewPayload | undefined): QuestionRecordPayload[] {
  if (!board) return [];
  return board.questions.filter(
    (question) => question.answeredAt === undefined && question.withdrawnAt === undefined,
  );
}

export function aggregateProjectsStage(
  projects: readonly ProjectSummary[],
  boards: Readonly<Record<string, BoardViewPayload>>,
  excludeProjectId?: ProjectId,
): VisualStage {
  let hasWorking = false;
  for (const project of projects) {
    if (excludeProjectId && project.id === excludeProjectId) continue;
    const summary = deriveBoardSummary(boards[project.id]);
    if (summary.stage === "answer") return "answer";
    if (summary.stage === "working") hasWorking = true;
  }
  return hasWorking ? "working" : "idle";
}

export function partitionBoardTickets(
  tickets: readonly TicketRecordPayload[],
  filterWorkerId?: WorkerId,
): {
  readonly open: TicketRecordPayload[];
  readonly ended: TicketRecordPayload[];
} {
  const scoped = filterWorkerId
    ? tickets.filter((ticket) => ticket.workerId === filterWorkerId)
    : tickets;
  const open: TicketRecordPayload[] = [];
  const ended: TicketRecordPayload[] = [];
  for (const ticket of scoped) {
    if (ticket.status === "open") open.push(ticket);
    else ended.push(ticket);
  }
  open.sort((a, b) => b.createdAt - a.createdAt);
  ended.sort((a, b) => (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt));
  return { open, ended };
}
