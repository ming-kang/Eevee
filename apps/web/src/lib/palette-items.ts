import type { BoardViewPayload, ProjectId, ProjectSummary, WorkerId } from "@eevee/protocol";
import type { PaletteItem } from "../components/CommandPalette.tsx";
import type { LocaleKey } from "./i18n.ts";
import type { ProjectSubView, SettingsSection } from "./router.ts";
import { modLabel } from "./shortcuts.ts";
import { deriveBoardSummary } from "./transcript.ts";

type TranslateFn = (key: LocaleKey, params?: Readonly<Record<string, string | number>>) => string;

export type BuildPaletteItemsInput = {
  readonly projects: readonly ProjectSummary[];
  readonly boards: Readonly<Record<string, BoardViewPayload>>;
  readonly activeProject: ProjectSummary | undefined;
  readonly themeLabel: string;
  readonly t: TranslateFn;
  readonly onOpenOverview: () => void;
  readonly onOpenProject: (pid: ProjectId, view?: ProjectSubView, workerId?: WorkerId) => void;
  readonly onNewProject: () => void;
  readonly onOpenControl: (section?: SettingsSection) => void;
  readonly onCycleTheme: () => void;
  readonly onOpenShortcuts: () => void;
  readonly onToggleSide: () => void;
  readonly onToggleRail: () => void;
};

export function buildPaletteItems({
  projects,
  boards,
  activeProject,
  themeLabel,
  t,
  onOpenOverview,
  onOpenProject,
  onNewProject,
  onOpenControl,
  onCycleTheme,
  onOpenShortcuts,
  onToggleSide,
  onToggleRail,
}: BuildPaletteItemsInput): PaletteItem[] {
  const mod = modLabel();
  const list: PaletteItem[] = [
    {
      id: "nav:overview",
      group: t("palette.group.nav"),
      label: t("palette.overview"),
      run: onOpenOverview,
    },
  ];

  if (activeProject) {
    list.push(
      {
        id: "nav:active-router",
        group: t("palette.group.nav"),
        label: `${activeProject.title} · ${t("sidebar.router")}`,
        run: () => onOpenProject(activeProject.id, "chat"),
      },
      {
        id: "nav:active-memory",
        group: t("palette.group.nav"),
        label: `${activeProject.title} · ${t("project.tab.memory")}`,
        run: () => onOpenProject(activeProject.id, "memory"),
      },
      {
        id: "nav:active-usage",
        group: t("palette.group.nav"),
        label: `${activeProject.title} · ${t("project.tab.usage")}`,
        run: () => onOpenProject(activeProject.id, "usage"),
      },
    );
  }

  list.push(
    {
      id: "act:new-project",
      group: t("palette.group.actions"),
      label: t("palette.newProject"),
      run: onNewProject,
    },
    {
      id: "act:settings",
      group: t("palette.group.actions"),
      label: t("palette.openSettings"),
      keys: [mod, ","],
      run: () => onOpenControl("general"),
    },
    {
      id: "act:theme",
      group: t("palette.group.actions"),
      label: t("palette.cycleTheme", { theme: themeLabel }),
      run: onCycleTheme,
    },
    {
      id: "act:shortcuts",
      group: t("palette.group.actions"),
      label: t("palette.openShortcuts"),
      keys: ["?"],
      run: onOpenShortcuts,
    },
    {
      id: "act:toggle-side",
      group: t("palette.group.actions"),
      label: t("palette.toggleSide"),
      keys: [mod, "B"],
      run: onToggleSide,
    },
  );

  if (activeProject) {
    list.push({
      id: "act:toggle-rail",
      group: t("palette.group.actions"),
      label: t("shortcuts.toggleRail"),
      keys: [mod, "Alt", "B"],
      run: onToggleRail,
    });
  }

  for (const p of projects) {
    const summary = deriveBoardSummary(boards[p.id]);
    list.push({
      id: `proj:${p.id}`,
      group: t("palette.group.projects"),
      label: p.title,
      meta: p.id,
      stage: summary.stage,
      run: () => onOpenProject(p.id, "chat"),
    });
    const b = boards[p.id];
    for (const w of b?.workers ?? []) {
      if (w.status === "closed") continue;
      list.push({
        id: `worker:${p.id}:${w.id}`,
        group: t("palette.group.workers"),
        label: `${w.id} · ${w.name}`,
        meta: p.title,
        stage: w.status === "running" ? "working" : w.status === "queued" ? "queued" : "idle",
        run: () => onOpenProject(p.id, "chat", w.id),
      });
    }
  }

  return list;
}
