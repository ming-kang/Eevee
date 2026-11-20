import type { Question } from "../../../src/domain/index.ts";
import type { BoardView, ProjectSummary, TicketView } from "../../../src/protocol/contract.ts";
import { effectiveStage, ticketActivityAt } from "./board.ts";
import { failureText } from "./labels.ts";
import type { Route } from "./router.ts";

export const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PendingRow =
  | { kind: "proposal"; pid: string; project: string; proposal: BoardView["openProposals"][number] }
  | {
      kind: "question";
      pid: string;
      project: string;
      question: Question;
      text: string;
      view?: TicketView;
    }
  | { kind: "ticket"; pid: string; project: string; view: TicketView; at: number }
  | { kind: "router"; pid: string; project: string; failure: string };

export type RunningRow =
  | {
      kind: "ticket";
      pid: string;
      project: string;
      view: TicketView;
      runningJobs: number;
      at: number;
    }
  | { kind: "router"; pid: string; project: string };

export type DoneRow = { pid: string; project: string; view: TicketView; closedAt: number };

export type OverviewBoard = {
  pending: PendingRow[];
  running: RunningRow[];
  done: DoneRow[];
  pendingCount: number;
  runningCount: number;
  doneCount: number;
};

export function pendingRoute(row: PendingRow): Route {
  if (row.kind === "proposal") return { name: "control", section: "memory", pid: row.pid };
  if (row.kind === "ticket") return { name: "worker", pid: row.pid, tid: row.view.ticket.id };
  if (row.kind === "question") {
    return row.question.ticketId
      ? { name: "worker", pid: row.pid, tid: row.question.ticketId }
      : { name: "chat", pid: row.pid, qid: row.question.id };
  }
  return { name: "chat", pid: row.pid };
}

export function overviewProjectId(
  projects: readonly ProjectSummary[],
  stored: string | null | undefined,
): string {
  return projects.some((project) => project.id === stored) ? (stored ?? "") : "";
}

export function buildOverviewBoard(input: {
  projects: readonly ProjectSummary[];
  boards: Record<string, { board?: BoardView } | undefined>;
  now: number;
  projectId?: string;
}): OverviewBoard {
  const selected = overviewProjectId(input.projects, input.projectId);
  const questions: Extract<PendingRow, { kind: "question" }>[] = [];
  const failures: PendingRow[] = [];
  const proposals: PendingRow[] = [];
  const pendingTickets: Extract<PendingRow, { kind: "ticket" }>[] = [];
  const tickets: Extract<RunningRow, { kind: "ticket" }>[] = [];
  const routers: RunningRow[] = [];
  const done: DoneRow[] = [];

  for (const project of input.projects) {
    if (selected && project.id !== selected) continue;
    const board = input.boards[project.id]?.board;
    if (!board) continue;
    for (const proposal of board.openProposals ?? [])
      proposals.push({ kind: "proposal", pid: project.id, project: project.title, proposal });

    const openQuestions = board.openQuestions.filter((question) => question.answer === undefined);
    for (const question of openQuestions) {
      questions.push({
        kind: "question",
        pid: project.id,
        project: project.title,
        question,
        text: (question.items[0]?.text ?? "").replace(/\s+/g, " ").trim(),
        view: board.tickets.find((view) => view.ticket.id === question.ticketId),
      });
    }

    const routerFailed = board.router.failure ? failureText(board.router.failure) : undefined;
    if (routerFailed !== undefined) {
      failures.push({
        kind: "router",
        pid: project.id,
        project: project.title,
        failure: routerFailed,
      });
    }

    for (const view of board.tickets) {
      if (view.ticket.status !== "open") {
        const closedAt = view.ticket.closedAt;
        if (closedAt !== undefined && input.now - closedAt <= DONE_WINDOW_MS) {
          done.push({ pid: project.id, project: project.title, view, closedAt });
        }
        continue;
      }
      const stage = effectiveStage(view);
      if (stage === "answer" || stage === "review" || stage === "blocked") {
        if (!openQuestions.some((question) => question.ticketId === view.ticket.id)) {
          pendingTickets.push({
            kind: "ticket",
            pid: project.id,
            project: project.title,
            view,
            at: ticketActivityAt(view),
          });
        }
        continue;
      }
      if (stage !== "working" && stage !== "jobs") continue;
      const runningJobs = view.jobs.filter((job) => job.status === "running");
      const at = Math.max(view.ticket.createdAt, ...runningJobs.map((job) => job.startedAt));
      tickets.push({
        kind: "ticket",
        pid: project.id,
        project: project.title,
        view,
        runningJobs: runningJobs.length,
        at,
      });
    }

    if (board.router.running) {
      routers.push({ kind: "router", pid: project.id, project: project.title });
    }
  }

  questions.sort((a, b) => b.question.askedAt - a.question.askedAt);
  pendingTickets.sort((a, b) => b.at - a.at);
  tickets.sort((a, b) => b.at - a.at);
  done.sort((a, b) => b.closedAt - a.closedAt);
  const pending = [...questions, ...proposals, ...pendingTickets, ...failures];

  return {
    pending,
    running: [...tickets, ...routers],
    done,
    pendingCount: pending.length,
    runningCount: tickets.length + routers.length,
    doneCount: done.length,
  };
}
