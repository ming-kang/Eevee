import {
  AddIcon,
  DarkModeIcon,
  GridViewIcon,
  HubIcon,
  KeyboardIcon,
  LightModeIcon,
  SearchIcon,
  SettingsIcon,
} from "@earendil-works/elanor-icons-react";
import { SideNavigation } from "@earendil-works/elanor-react";
import type { BoardViewPayload, ProjectId, ProjectSummary, WorkerId } from "@eevee/protocol";
import { useMemo } from "react";
import { useI18n } from "../lib/i18n.ts";
import type { Route } from "../lib/router.ts";
import { modLabel } from "../lib/shortcuts.ts";
import type { ThemePreference, ThemeScheme } from "../lib/theme.ts";
import { deriveBoardSummary } from "../lib/transcript.ts";
import {
  aggregateProjectsStage,
  partitionSidebarWorkers,
  workerStage,
} from "../lib/workspace-nav.ts";
import { BrandLogo } from "./BrandLogo.tsx";
import { EvTooltip } from "./EvTooltip.tsx";

function projectInitials(title: string): string {
  const cleaned = title.trim();
  if (!cleaned) return "P";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

export function CompactSidebarRail({
  projects,
  boards,
  activeProject,
  route,
  themePreference,
  themeScheme,
  onOpenOverview,
  onOpenProject,
  onNewProject,
  onOpenPalette,
  onOpenControl,
  onOpenShortcuts,
  onCycleTheme,
  onExpandSide,
}: {
  readonly projects: readonly ProjectSummary[];
  readonly boards: Readonly<Record<string, BoardViewPayload>>;
  readonly activeProject: ProjectSummary | undefined;
  readonly route: Route;
  readonly themePreference: ThemePreference;
  readonly themeScheme: ThemeScheme;
  readonly onOpenOverview: () => void;
  readonly onOpenProject: (
    pid: ProjectId,
    view?: "chat" | "memory" | "usage",
    workerId?: WorkerId,
  ) => void;
  readonly onNewProject: () => void;
  readonly onOpenPalette: () => void;
  readonly onOpenControl: () => void;
  readonly onOpenShortcuts: () => void;
  readonly onCycleTheme: () => void;
  readonly onExpandSide: () => void;
}) {
  const { t } = useI18n();
  const themeLabel = t(`sidebar.theme.${themePreference}` as const);
  const allProjectsStage = useMemo(
    () => aggregateProjectsStage(projects, boards),
    [projects, boards],
  );
  const activeBoard = activeProject ? boards[activeProject.id] : undefined;
  const { active: activeWorkers } = useMemo(
    () => partitionSidebarWorkers(activeBoard?.workers ?? []),
    [activeBoard],
  );
  const activeWorkerId = route.name === "project" ? route.workerId : undefined;
  const isRouterActive =
    route.name === "project" && route.view === "chat" && activeWorkerId === undefined;

  return (
    <div className="ev-icon-rail">
      <div className="ev-icon-rail-top">
        <EvTooltip content={t("app.expandSide")} side="right">
          <button
            type="button"
            className="ev-icon-rail-brand"
            aria-label={t("app.expandSide")}
            onClick={onExpandSide}
          >
            <BrandLogo size={18} />
          </button>
        </EvTooltip>
      </div>

      <SideNavigation.Root
        variant="compact"
        className="ev-icon-rail-nav"
        aria-label={t("app.mainNav")}
      >
        <SideNavigation.List className="ev-icon-rail-list">
          <SideNavigation.Item>
            <EvTooltip content={t("sidebar.overview")} side="right">
              <SideNavigation.Link
                href="#overview"
                active={route.name === "overview"}
                iconStart={<GridViewIcon width={17} height={17} />}
                className="ev-icon-rail-btn"
                onClick={(event) => {
                  event.preventDefault();
                  onOpenOverview();
                }}
              >
                {t("sidebar.overview")}
              </SideNavigation.Link>
            </EvTooltip>
            {allProjectsStage !== "idle" && (
              <span className="ev-icon-rail-dot ev-dot" data-stage={allProjectsStage} />
            )}
          </SideNavigation.Item>

          <SideNavigation.Item>
            <EvTooltip content={`${t("shortcuts.palette")} (${modLabel()} K)`} side="right">
              <SideNavigation.Link
                href="#palette"
                iconStart={<SearchIcon width={17} height={17} />}
                className="ev-icon-rail-btn"
                onClick={(event) => {
                  event.preventDefault();
                  onOpenPalette();
                }}
              >
                {t("shortcuts.palette")}
              </SideNavigation.Link>
            </EvTooltip>
          </SideNavigation.Item>
        </SideNavigation.List>

        <hr className="ev-icon-rail-sep" />

        {activeProject ? (
          <SideNavigation.List className="ev-icon-rail-list ev-icon-rail-scroll">
            <SideNavigation.Item>
              <EvTooltip content={`${activeProject.title} · ${t("sidebar.router")}`} side="right">
                <SideNavigation.Link
                  href={`#project-${activeProject.id}`}
                  active={isRouterActive}
                  iconStart={<HubIcon width={17} height={17} />}
                  className="ev-icon-rail-btn"
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenProject(activeProject.id, "chat");
                  }}
                >
                  {t("sidebar.router")}
                </SideNavigation.Link>
              </EvTooltip>
            </SideNavigation.Item>

            {activeWorkers.slice(0, 8).map((worker) => {
              const stage = workerStage(worker);
              return (
                <SideNavigation.Item key={worker.id} className="ev-icon-rail-item">
                  <EvTooltip content={`${worker.name} (${worker.id})`} side="right">
                    <SideNavigation.Link
                      href={`#worker-${worker.id}`}
                      active={activeWorkerId === worker.id}
                      compactContent={<span className="ev-mono ev-icon-rail-tag">{worker.id}</span>}
                      className="ev-icon-rail-btn"
                      onClick={(event) => {
                        event.preventDefault();
                        onOpenProject(activeProject.id, "chat", worker.id);
                      }}
                    >
                      {worker.name}
                    </SideNavigation.Link>
                  </EvTooltip>
                  {stage !== "idle" && (
                    <span className="ev-icon-rail-dot ev-dot" data-stage={stage} />
                  )}
                </SideNavigation.Item>
              );
            })}
          </SideNavigation.List>
        ) : (
          <SideNavigation.List className="ev-icon-rail-list ev-icon-rail-scroll">
            {projects.slice(0, 8).map((project) => {
              const summary = deriveBoardSummary(boards[project.id]);
              return (
                <SideNavigation.Item key={project.id} className="ev-icon-rail-item">
                  <EvTooltip content={project.title} side="right">
                    <SideNavigation.Link
                      href={`#p-${project.id}`}
                      compactContent={
                        <span className="ev-icon-rail-tag">{projectInitials(project.title)}</span>
                      }
                      className="ev-icon-rail-btn"
                      onClick={(event) => {
                        event.preventDefault();
                        onOpenProject(project.id, "chat");
                      }}
                    >
                      {project.title}
                    </SideNavigation.Link>
                  </EvTooltip>
                  {summary.stage !== "idle" && (
                    <span className="ev-icon-rail-dot ev-dot" data-stage={summary.stage} />
                  )}
                </SideNavigation.Item>
              );
            })}
            <SideNavigation.Item>
              <EvTooltip content={t("sidebar.newProject")} side="right">
                <SideNavigation.Link
                  href="#new-project"
                  iconStart={<AddIcon width={17} height={17} />}
                  className="ev-icon-rail-btn"
                  onClick={(event) => {
                    event.preventDefault();
                    onNewProject();
                  }}
                >
                  {t("sidebar.newProject")}
                </SideNavigation.Link>
              </EvTooltip>
            </SideNavigation.Item>
          </SideNavigation.List>
        )}
      </SideNavigation.Root>

      <div className="ev-icon-rail-foot">
        <EvTooltip content={`${t("sidebar.settings")} (${modLabel()} ,)`} side="right">
          <button
            type="button"
            className="ev-icon-rail-foot-btn"
            aria-label={t("sidebar.settings")}
            onClick={onOpenControl}
          >
            <SettingsIcon width={17} height={17} />
          </button>
        </EvTooltip>
        <EvTooltip content={`${t("sidebar.shortcuts")} (?)`} side="right">
          <button
            type="button"
            className="ev-icon-rail-foot-btn"
            aria-label={t("sidebar.shortcuts")}
            onClick={onOpenShortcuts}
          >
            <KeyboardIcon width={16} height={16} />
          </button>
        </EvTooltip>
        <EvTooltip content={t("sidebar.theme", { theme: themeLabel })} side="right">
          <button
            type="button"
            className="ev-icon-rail-foot-btn"
            aria-label={t("sidebar.theme", { theme: themeLabel })}
            onClick={onCycleTheme}
          >
            {themeScheme === "dark" ? (
              <LightModeIcon width={16} height={16} />
            ) : (
              <DarkModeIcon width={16} height={16} />
            )}
          </button>
        </EvTooltip>
      </div>
    </div>
  );
}
