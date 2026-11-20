import type { RunSummary } from "../../../src/domain/index.ts";
import type { BoardView, ProjectSummary, TicketView } from "../../../src/protocol/contract.ts";
import { countPendingQuestions, effectiveStage, groupTickets, type VisualStage } from "./board.ts";
import { t } from "./i18n.ts";
import { displayId } from "./ids.ts";
import { failureText, STAGE_LABEL } from "./labels.ts";
import type { Route } from "./router.ts";

export type ProjectRowState = {
  kind: "user" | "bad" | "run" | "rest";
  questionCount: number;
  proposalCount: number;
  openCount: number;
  runningTickets: number;
  jobCount: number;
  routerRunning: boolean;
  routerFailed?: string;
  activeAt?: number;
};

/**
 * Derive single-slot status badge state for a project row with priority:
 * unanswered questions > Router failure > running Worker/job/Router > idle.
 */
export function deriveProjectState(input: {
  board?: BoardView;
  router?: RunSummary;
  activeAt?: number;
}): ProjectRowState {
  const board = input.board;
  const openTickets = (board?.tickets ?? []).filter((t) => t.ticket.status === "open");
  const questionCount = countPendingQuestions(board);
  const proposalCount = board?.openProposals?.length ?? 0;
  const runningTickets = openTickets.filter(
    (t) => t.stage === "working" || t.stage === "jobs",
  ).length;
  const jobCount = openTickets.reduce(
    (total, t) => total + t.jobs.filter((j) => j.status === "running").length,
    0,
  );
  const router = input.router ?? input.board?.router;
  const routerRunning = router?.running ?? false;
  const routerFailed = router?.failure && failureText(router.failure);

  let kind: ProjectRowState["kind"] = "rest";
  if (questionCount + proposalCount > 0) kind = "user";
  else if (routerFailed !== undefined) kind = "bad";
  else if (runningTickets > 0 || routerRunning) kind = "run";

  return {
    kind,
    questionCount,
    proposalCount,
    openCount: openTickets.length,
    runningTickets,
    jobCount,
    routerRunning,
    ...(routerFailed === undefined ? {} : { routerFailed }),
    ...(input.activeAt === undefined ? {} : { activeAt: input.activeAt }),
  };
}

/** Open tickets ordered for the sidebar sub-tree: urgent items (answer/blocked) first. */
export function openSidebarTickets(board: BoardView | undefined): TicketView[] {
  if (!board) return [];
  const g = groupTickets(board.tickets);
  return [...g.answer, ...g.blocked, ...g.review, ...g.active];
}

export type SidebarProjectEntry = {
  project: ProjectSummary;
  tickets: TicketView[];
  /** Set when an inline filter matched specific tickets inside this project. */
  forceExpand: boolean;
};

/**
 * Filter projects and their tickets for the sidebar's inline search box.
 * An empty query returns every project with its open tickets; a query matches against project
 * title/id/workspace as well as ticket id/title/stage, auto-expanding projects with ticket hits.
 */
export function filterSidebarProjects(
  projects: readonly ProjectSummary[],
  boards: Record<string, { board?: BoardView } | undefined>,
  query: string,
): SidebarProjectEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return projects.map((project) => ({
      project,
      tickets: openSidebarTickets(boards[project.id]?.board),
      forceExpand: false,
    }));
  }

  const out: SidebarProjectEntry[] = [];
  for (const project of projects) {
    const board = boards[project.id]?.board;
    const projectHit =
      project.title.toLowerCase().includes(q) ||
      project.id.toLowerCase().includes(q) ||
      project.workspace.toLowerCase().includes(q);

    const g = groupTickets(board?.tickets ?? []);
    const ordered = [...g.answer, ...g.blocked, ...g.review, ...g.active, ...g.closed];
    const matchedTickets = ordered.filter((view) => {
      const stageLabel = STAGE_LABEL[effectiveStage(view)].toLowerCase();
      return (
        view.ticket.id.toLowerCase().includes(q) ||
        view.ticket.title.toLowerCase().includes(q) ||
        stageLabel.includes(q)
      );
    });

    if (matchedTickets.length > 0) {
      out.push({ project, tickets: matchedTickets, forceExpand: true });
    } else if (projectHit) {
      out.push({ project, tickets: openSidebarTickets(board), forceExpand: false });
    }
  }
  return out;
}

type PaletteIcon =
  | "home"
  | "folder"
  | "radio"
  | "book"
  | "chart"
  | "sliders"
  | "cpu"
  | "puzzle"
  | "plug"
  | "server";

export type PaletteItem =
  | {
      id: string;
      group: string;
      label: string;
      meta?: string;
      search: string;
      kind: "route";
      route: Route;
      icon?: PaletteIcon;
      stage?: VisualStage;
      projectId?: string;
    }
  | {
      id: string;
      group: string;
      label: string;
      meta?: string;
      search: string;
      kind: "action";
      action: "new-project" | "toggle-theme" | "toggle-side" | "toggle-rail";
      icon: "plus" | "moon" | "panel";
    };

export function buildPaletteItems(input: {
  projects: readonly ProjectSummary[];
  boards: Record<string, { board?: BoardView } | undefined>;
  activeProjectId?: string;
  sideShortcut?: string;
  railShortcut?: string;
}): PaletteItem[] {
  const items: PaletteItem[] = [];
  const pid = input.activeProjectId;
  const go = (id: string, label: string, keywords: string, route: Route, icon: PaletteIcon) =>
    ({
      id,
      group: t("Go to"),
      label,
      search: `${label} ${keywords}`,
      kind: "route",
      route,
      icon,
    }) as const;

  items.push(go("nav:home", t("Home"), "home now dashboard", { name: "home" }, "home"));

  if (pid) {
    items.push(
      go(`nav:chat:${pid}`, t("Router conversation"), "chat", { name: "chat", pid }, "radio"),
      go(`nav:memory:${pid}`, t("Memory"), "memory", { name: "memory", pid }, "book"),
      go(`nav:usage:${pid}`, t("Usage"), "usage cost", { name: "usage", pid }, "chart"),
    );
  }

  items.push(
    go(
      "nav:settings:general",
      t("Settings · General"),
      "settings general theme palette font size language",
      { name: "settings", section: "general" },
      "sliders",
    ),
    go(
      "nav:settings:models",
      t("Settings · Models"),
      "settings models thinking",
      { name: "settings", section: "models" },
      "cpu",
    ),
    go(
      "nav:settings:roles",
      t("Settings · Roles"),
      "settings roles",
      { name: "settings", section: "roles" },
      "puzzle",
    ),
    go(
      "nav:settings:mcp",
      t("Settings · MCP & extensions"),
      "settings mcp extensions",
      { name: "settings", section: "mcp" },
      "plug",
    ),
    go(
      "nav:settings:engine",
      t("Settings · Engine"),
      "settings engine",
      { name: "settings", section: "engine" },
      "server",
    ),
  );

  if (pid) {
    const activeBoard = input.boards[pid]?.board;
    for (const view of activeBoard?.tickets ?? []) {
      const stage = effectiveStage(view);
      const meta = `${displayId(view.ticket.id)} · ${STAGE_LABEL[stage]}`;
      items.push({
        id: `ticket:${pid}:${view.ticket.id}`,
        group: t("Tickets"),
        label: view.ticket.title,
        meta,
        search: `${view.ticket.id} ${view.ticket.title} ${STAGE_LABEL[stage]}`,
        kind: "route",
        route: { name: "worker", pid, tid: view.ticket.id },
        stage,
      });
    }
  }

  for (const project of input.projects) {
    const openCount = (input.boards[project.id]?.board?.tickets ?? []).filter(
      (t) => t.ticket.status === "open",
    ).length;
    const meta = openCount > 0 ? t("{n} open", { n: openCount }) : undefined;
    items.push({
      id: `proj:${project.id}`,
      group: t("Projects"),
      label: project.title,
      ...(meta ? { meta } : {}),
      search: `${project.title} ${project.id} ${project.workspace}`,
      kind: "route",
      route: { name: "chat", pid: project.id },
      icon: "folder",
      projectId: project.id,
    });
  }

  items.push(
    {
      id: "act:new-project",
      group: t("Actions"),
      label: t("New project"),
      search: `${t("New project")} new create project`,
      kind: "action",
      action: "new-project",
      icon: "plus",
    },
    {
      id: "act:toggle-theme",
      group: t("Actions"),
      label: t("Toggle light / dark"),
      search: `${t("Toggle light / dark")} ${t("Theme")} theme dark light`,
      kind: "action",
      action: "toggle-theme",
      icon: "moon",
    },
    {
      id: "act:toggle-side",
      group: t("Actions"),
      label: t("Toggle sidebar"),
      ...(input.sideShortcut ? { meta: input.sideShortcut } : {}),
      search: `${t("Toggle sidebar")} sidebar`,
      kind: "action",
      action: "toggle-side",
      icon: "panel",
    },
    {
      id: "act:toggle-rail",
      group: t("Actions"),
      label: t("Toggle tickets panel"),
      ...(input.railShortcut ? { meta: input.railShortcut } : {}),
      search: `${t("Toggle tickets panel")} tickets panel rail`,
      kind: "action",
      action: "toggle-rail",
      icon: "panel",
    },
  );

  return items;
}

export function filterPaletteItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  return items.filter((item) => item.search.toLowerCase().includes(q));
}
