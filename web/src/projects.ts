import type { BoardView, ProjectSummary } from "../../src/api/contract.ts";
import type { RunSummary } from "../../src/contracts/index.ts";
import { effectiveStage, type VisualStage } from "./board.ts";
import { STAGE_LABEL } from "./labels.ts";
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
  const questionCount = board
    ? board.openQuestions.filter((q) => q.answer === undefined).length
    : 0;
  const runningTickets = openTickets.filter(
    (t) => t.stage === "working" || t.stage === "jobs",
  ).length;
  const jobCount = openTickets.reduce(
    (total, t) => total + t.jobs.filter((j) => j.status === "running").length,
    0,
  );
  const router = input.router ?? input.board?.router;
  const routerRunning = router?.running ?? false;
  const routerFailed = router?.failure;

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

export type PaletteIcon = "radio" | "book" | "chart" | "cpu" | "puzzle" | "plug" | "server";

export type PaletteItem =
  | {
      id: string;
      group: "跳转" | "工单" | "项目";
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
      group: "操作";
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

  if (pid) {
    items.push(
      {
        id: `nav:chat:${pid}`,
        group: "跳转",
        label: "Router 主对话",
        search: "Router 主对话 chat",
        kind: "route",
        route: { name: "chat", pid },
        icon: "radio",
      },
      {
        id: `nav:memory:${pid}`,
        group: "跳转",
        label: "记忆",
        search: "记忆 memory",
        kind: "route",
        route: { name: "memory", pid },
        icon: "book",
      },
      {
        id: `nav:usage:${pid}`,
        group: "跳转",
        label: "花费",
        search: "花费 usage cost",
        kind: "route",
        route: { name: "usage", pid },
        icon: "chart",
      },
    );
  }

  items.push(
    {
      id: "nav:settings:models",
      group: "跳转",
      label: "设置 · 模型",
      search: "设置 模型 settings models",
      kind: "route",
      route: { name: "settings", section: "models" },
      icon: "cpu",
    },
    {
      id: "nav:settings:roles",
      group: "跳转",
      label: "设置 · 角色能力",
      search: "设置 角色能力 settings roles",
      kind: "route",
      route: { name: "settings", section: "roles" },
      icon: "puzzle",
    },
    {
      id: "nav:settings:mcp",
      group: "跳转",
      label: "设置 · MCP 与扩展",
      search: "设置 MCP 扩展 settings mcp",
      kind: "route",
      route: { name: "settings", section: "mcp" },
      icon: "plug",
    },
    {
      id: "nav:settings:engine",
      group: "跳转",
      label: "设置 · Engine",
      search: "设置 Engine settings engine",
      kind: "route",
      route: { name: "settings", section: "engine" },
      icon: "server",
    },
  );

  if (pid) {
    const activeBoard = input.boards[pid]?.board;
    for (const view of activeBoard?.tickets ?? []) {
      const stage = effectiveStage(view);
      const meta = `${view.ticket.id} · ${STAGE_LABEL[stage]}`;
      items.push({
        id: `ticket:${pid}:${view.ticket.id}`,
        group: "工单",
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
    const meta = openCount > 0 ? `${openCount} 张未结` : undefined;
    items.push({
      id: `proj:${project.id}`,
      group: "项目",
      label: project.title,
      ...(meta ? { meta } : {}),
      search: `${project.title} ${project.id} ${project.workspace}`,
      kind: "route",
      route: { name: "chat", pid: project.id },
      projectTile: project.title.slice(0, 1) || "项",
    });
  }

  items.push(
    {
      id: "act:new-project",
      group: "操作",
      label: "新建项目",
      search: "新建项目 create project",
      kind: "action",
      action: "new-project",
      icon: "plus",
    },
    {
      id: "act:toggle-theme",
      group: "操作",
      label: "切换浅色 / 深色",
      search: "切换浅色 深色 主题 theme dark light",
      kind: "action",
      action: "toggle-theme",
      icon: "moon",
    },
    {
      id: "act:toggle-side",
      group: "操作",
      label: "收起 / 展开侧栏",
      ...(input.sideShortcut ? { meta: input.sideShortcut } : {}),
      search: "收起 展开 侧栏 sidebar",
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
