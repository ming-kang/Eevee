import type { BoardView, ProjectSummary, TicketView } from "../../src/api/contract.ts";
import type { Question } from "../../src/contracts/index.ts";
import { effectiveStage } from "./board.ts";
import { failureText } from "./labels.ts";

/** "Recently done" looks back one day and shows the newest few. */
export const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DONE_LIMIT = 8;

export type NeedsYouRow =
  | { kind: "question"; pid: string; project: string; question: Question; text: string }
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

export type HomeBoard = {
  needsYou: NeedsYouRow[];
  running: RunningRow[];
  /** Closed inside `DONE_WINDOW_MS`, newest first, capped at `DONE_LIMIT`. */
  done: DoneRow[];
  runningCount: number;
  /** Every ticket closed inside the window; the section itself shows `done` only. */
  doneCount: number;
};

/**
 * The Now page's cross-project view of every board: what needs the user, what is in flight, and
 * what finished lately. Questions outrank Router failures, which matches `deriveProjectState`'s
 * ordering; a running Router trails the tickets it drives, newest work first.
 */
export function buildHomeBoard(input: {
  projects: readonly ProjectSummary[];
  boards: Record<string, { board?: BoardView } | undefined>;
  now: number;
}): HomeBoard {
  const questions: Extract<NeedsYouRow, { kind: "question" }>[] = [];
  const failures: NeedsYouRow[] = [];
  const tickets: Extract<RunningRow, { kind: "ticket" }>[] = [];
  const routers: RunningRow[] = [];
  const done: DoneRow[] = [];

  for (const project of input.projects) {
    const board = input.boards[project.id]?.board;
    if (!board) continue;

    for (const question of board.openQuestions) {
      if (question.answer !== undefined) continue;
      questions.push({
        kind: "question",
        pid: project.id,
        project: project.title,
        question,
        text: (question.items[0]?.text ?? "").replace(/\s+/g, " ").trim(),
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
      if (stage !== "working" && stage !== "jobs") continue;
      const runningJobs = view.jobs.filter((j) => j.status === "running");
      const at = Math.max(view.ticket.createdAt, ...runningJobs.map((j) => j.startedAt));
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
  tickets.sort((a, b) => b.at - a.at);
  done.sort((a, b) => b.closedAt - a.closedAt);

  return {
    needsYou: [...questions, ...failures],
    running: [...tickets, ...routers],
    done: done.slice(0, DONE_LIMIT),
    runningCount: tickets.length + routers.length,
    doneCount: done.length,
  };
}
