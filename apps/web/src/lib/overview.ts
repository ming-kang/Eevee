import type { BoardViewPayload, ProjectId, ProjectSummary, WorkerId } from "@eevee/protocol";
import type { VisualStage } from "./transcript.ts";

export type OverviewLane = "pending" | "running" | "done";

export type OverviewItem = {
  readonly key: string;
  readonly lane: OverviewLane;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly chip: string;
  readonly title: string;
  readonly note?: string;
  readonly stage: VisualStage;
  readonly activeTaskCount?: number;
  readonly queued?: boolean;
  readonly at?: number;
  readonly workerId?: WorkerId;
};

export function buildOverviewItems(
  projects: readonly ProjectSummary[],
  boards: Readonly<Record<string, BoardViewPayload>>,
  projectFilter: string,
  questionFallback: string,
): OverviewItem[] {
  const out: OverviewItem[] = [];
  const targetProjects = projectFilter ? projects.filter((p) => p.id === projectFilter) : projects;

  for (const project of targetProjects) {
    const board = boards[project.id];
    if (!board) continue;
    const ticketsById = new Map(board.tickets.map((ticket) => [ticket.id, ticket]));

    for (const q of board.questions) {
      if (q.answeredAt !== undefined || q.withdrawnAt !== undefined) continue;
      const questionText = q.items[0]?.question?.trim();
      out.push({
        key: `${project.id}:q:${q.id}`,
        lane: "pending",
        projectId: project.id,
        projectTitle: project.title,
        chip: q.id,
        title: questionText || questionFallback,
        stage: "answer",
        at: q.askedAt,
      });
    }

    for (const worker of board.workers) {
      if (worker.status !== "running" && worker.status !== "queued") continue;
      const ticket = worker.activeTicketId ? ticketsById.get(worker.activeTicketId) : undefined;
      out.push({
        key: `${project.id}:w:${worker.id}`,
        lane: "running",
        projectId: project.id,
        projectTitle: project.title,
        chip: ticket?.id ?? worker.id,
        title: ticket?.title ?? worker.name,
        ...(ticket ? { note: `${worker.id} · ${worker.name}` } : {}),
        stage: worker.status === "queued" ? "queued" : "working",
        ...(worker.status === "queued" ? { queued: true } : {}),
        ...(worker.activeTaskCount > 0 ? { activeTaskCount: worker.activeTaskCount } : {}),
        at: worker.createdAt,
        workerId: worker.id,
      });
    }

    for (const ticket of board.tickets) {
      if (ticket.status !== "done") continue;
      out.push({
        key: `${project.id}:t:${ticket.id}`,
        lane: "done",
        projectId: project.id,
        projectTitle: project.title,
        chip: ticket.id,
        title: ticket.title,
        ...(ticket.note ? { note: ticket.note } : {}),
        stage: "done",
        at: ticket.closedAt ?? ticket.createdAt,
        workerId: ticket.workerId,
      });
    }
  }

  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export function filterOverviewItems(
  items: readonly OverviewItem[],
  query: string,
): {
  readonly pending: OverviewItem[];
  readonly running: OverviewItem[];
  readonly done: OverviewItem[];
} {
  const q = query.trim().toLowerCase();
  const pending: OverviewItem[] = [];
  const running: OverviewItem[] = [];
  const done: OverviewItem[] = [];

  for (const item of items) {
    if (q) {
      const haystack =
        `${item.title} ${item.projectTitle} ${item.chip} ${item.note ?? ""}`.toLowerCase();
      if (!haystack.includes(q)) continue;
    }
    if (item.lane === "pending") pending.push(item);
    else if (item.lane === "running") running.push(item);
    else done.push(item);
  }

  return { pending, running, done };
}
