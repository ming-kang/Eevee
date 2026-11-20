import type { RunSummary } from "../../../src/domain/index.ts";
import type { BoardView, ProjectSummary } from "../../../src/protocol/contract.ts";
import { countPendingQuestions, effectiveStage, type VisualStage } from "./board.ts";
import { t } from "./i18n.ts";
import { displayId } from "./ids.ts";
import { failureText, STAGE_LABEL } from "./labels.ts";
import type { Route } from "./router.ts";

export type ProjectRowState = {
  kind: "user" | "bad" | "unread" | "run" | "rest";
  questionCount: number;
  proposalCount: number;
  reviewCount: number;
  blockedCount: number;
  unreadCount: number;
  openCount: number;
  runningTickets: number;
  jobCount: number;
  routerRunning: boolean;
  routerFailed?: string;
  activeAt?: number;
};

export function readProjectSeen(raw: string | null): Record<string, number> {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, at]) => typeof at === "number" && Number.isFinite(at) && at >= 0,
      ),
    );
  } catch {
    return {};
  }
}

export function deriveProjectState(input: {
  board?: BoardView;
  router?: RunSummary;
  activeAt?: number;
  lastSeenAt?: number;
}): ProjectRowState {
  const board = input.board;
  const openTickets = (board?.tickets ?? []).filter((t) => t.ticket.status === "open");
  const questionCount = countPendingQuestions(board);
  const proposalCount = board?.openProposals?.length ?? 0;
  const reviewCount = openTickets.filter((view) => view.stage === "review").length;
  const blockedCount = openTickets.filter((view) => view.stage === "blocked").length;
  const unansweredTickets = openTickets.some((view) => view.stage === "answer");
  const unreadCount = (board?.tickets ?? []).filter(
    (view) =>
      view.ticket.status === "done" && (view.ticket.closedAt ?? 0) > (input.lastSeenAt ?? 0),
  ).length;
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
  if (questionCount + proposalCount + reviewCount > 0 || unansweredTickets) kind = "user";
  else if (routerFailed !== undefined || blockedCount > 0) kind = "bad";
  else if (unreadCount > 0) kind = "unread";
  else if (runningTickets > 0 || routerRunning) kind = "run";

  return {
    kind,
    questionCount,
    proposalCount,
    reviewCount,
    blockedCount,
    unreadCount,
    openCount: openTickets.length,
    runningTickets,
    jobCount,
    routerRunning,
    ...(routerFailed === undefined ? {} : { routerFailed }),
    ...(input.activeAt === undefined ? {} : { activeAt: input.activeAt }),
  };
}

export function filterSidebarProjects(
  projects: readonly ProjectSummary[],
  query: string,
): ProjectSummary[] {
  const q = query.trim().toLowerCase();
  return projects.filter((project) =>
    [project.title, project.id, ...project.workspaces].some((value) =>
      value.toLowerCase().includes(q),
    ),
  );
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

  items.push(
    go("nav:overview", t("Overview"), "overview home now dashboard", { name: "overview" }, "home"),
  );

  if (pid) {
    items.push(
      go(`nav:chat:${pid}`, t("Router conversation"), "chat", { name: "chat", pid }, "radio"),
    );
  }

  items.push(
    go(
      "nav:control:memory",
      t("Memory"),
      "control memory",
      { name: "control", section: "memory" },
      "book",
    ),
    go(
      "nav:control:usage",
      t("Usage"),
      "control usage cost",
      { name: "control", section: "usage" },
      "chart",
    ),
    go(
      "nav:control:general",
      t("Control · General"),
      "settings general theme palette font size language",
      { name: "control", section: "general" },
      "sliders",
    ),
    go(
      "nav:control:models",
      t("Control · Models"),
      "settings models thinking",
      { name: "control", section: "models" },
      "cpu",
    ),
    go(
      "nav:control:roles",
      t("Control · Roles"),
      "settings roles",
      { name: "control", section: "roles" },
      "puzzle",
    ),
    go(
      "nav:control:mcp",
      t("Control · MCP & extensions"),
      "settings mcp extensions",
      { name: "control", section: "mcp" },
      "plug",
    ),
    go(
      "nav:control:engine",
      t("Control · Engine"),
      "settings engine",
      { name: "control", section: "engine" },
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
      search: `${project.title} ${project.id} ${project.workspaces.join(" ")}`,
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
