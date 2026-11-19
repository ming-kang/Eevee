import type { BoardView, ProjectSummary } from "../../src/api/contract.ts";
import type { RunSummary } from "../../src/contracts/index.ts";
import { countPendingQuestions, effectiveStage, type VisualStage } from "./board.ts";
import { t } from "./i18n.ts";
import { failureText, STAGE_LABEL } from "./labels.ts";
import type { Route } from "./router.ts";

export type ProjectRowState = {
  kind: "user" | "bad" | "run" | "rest";
  questionCount: number;
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
  if (questionCount > 0) kind = "user";
  else if (routerFailed !== undefined) kind = "bad";
  else if (runningTickets > 0 || routerRunning) kind = "run";

  return {
    kind,
    questionCount,
    openCount: openTickets.length,
    runningTickets,
    jobCount,
    routerRunning,
    ...(routerFailed === undefined ? {} : { routerFailed }),
    ...(input.activeAt === undefined ? {} : { activeAt: input.activeAt }),
  };
}

type PaletteIcon = "radio" | "book" | "chart" | "sliders" | "cpu" | "puzzle" | "plug" | "server";

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
      projectTile?: string;
    }
  | {
      id: string;
      group: string;
      label: string;
      meta?: string;
      search: string;
      kind: "action";
      action: "new-project" | "toggle-theme" | "toggle-side";
      icon: "plus" | "moon" | "panel";
    };

export function buildPaletteItems(input: {
  projects: readonly ProjectSummary[];
  boards: Record<string, { board?: BoardView } | undefined>;
  activeProjectId?: string;
  sideShortcut?: string;
}): PaletteItem[] {
  const items: PaletteItem[] = [];
  const pid = input.activeProjectId;
  // A page to go to: found by its label in the reader's language and by English keywords.
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
      "settings general theme font size language",
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
      const meta = `${view.ticket.id} · ${STAGE_LABEL[stage]}`;
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
      projectTile: project.title.slice(0, 1) || t("P"),
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
  );

  return items;
}

export function filterPaletteItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  return items.filter((item) => item.search.toLowerCase().includes(q));
}
