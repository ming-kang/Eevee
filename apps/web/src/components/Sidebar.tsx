import {
  AddIcon,
  CheckIcon,
  DarkModeIcon,
  DeleteIcon,
  EditIcon,
  ExpandMoreIcon,
  GridViewIcon,
  HubIcon,
  KeyboardArrowDownIcon,
  KeyboardIcon,
  LightModeIcon,
  LogoutIcon,
  SettingsIcon,
  SubdirectoryArrowRightIcon,
} from "@earendil-works/elanor-icons-react";
import { IconButton, ProjectSwitcher } from "@earendil-works/elanor-react";
import type { BoardViewPayload, ProjectId, ProjectSummary, WorkerId } from "@eevee/protocol";
import { useMemo, useState } from "react";
import { useI18n } from "../lib/i18n.ts";
import type { Route } from "../lib/router.ts";
import { modLabel } from "../lib/shortcuts.ts";
import type { ThemePreference, ThemeScheme } from "../lib/theme.ts";
import { deriveBoardSummary } from "../lib/transcript.ts";
import {
  aggregateProjectsStage,
  openBoardQuestions,
  partitionSidebarWorkers,
  workerStage,
} from "../lib/workspace-nav.ts";
import { BrandLogo } from "./BrandLogo.tsx";
import { EvTooltip } from "./EvTooltip.tsx";

export type SidebarProps = {
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
  readonly onOpenQuestion: (pid: ProjectId) => void;
  readonly onNewProject: () => void;
  readonly onEditProject: (project: ProjectSummary) => void;
  readonly onDeleteProject: (project: ProjectSummary) => void;
  readonly onOpenPalette: () => void;
  readonly onOpenControl: () => void;
  readonly onOpenShortcuts: () => void;
  readonly onCycleTheme: () => void;
  readonly onLogout: () => void;
};

export function Sidebar({
  projects,
  boards,
  activeProject,
  route,
  themePreference,
  themeScheme,
  onOpenOverview,
  onOpenProject,
  onOpenQuestion,
  onNewProject,
  onEditProject,
  onDeleteProject,
  onOpenPalette,
  onOpenControl,
  onOpenShortcuts,
  onCycleTheme,
  onLogout,
}: SidebarProps) {
  const { t } = useI18n();
  const [showClosed, setShowClosed] = useState(false);
  const themeLabel = t(`sidebar.theme.${themePreference}` as const);

  const activeBoard = activeProject ? boards[activeProject.id] : undefined;
  const openQuestions = useMemo(() => openBoardQuestions(activeBoard), [activeBoard]);
  const { active: activeWorkers, closed: closedWorkers } = useMemo(
    () => partitionSidebarWorkers(activeBoard?.workers ?? []),
    [activeBoard],
  );
  const ticketById = useMemo(
    () => new Map((activeBoard?.tickets ?? []).map((ticket) => [ticket.id, ticket])),
    [activeBoard],
  );

  const allProjectsStage = useMemo(
    () => aggregateProjectsStage(projects, boards),
    [projects, boards],
  );
  const switcherAttentionStage = useMemo(
    () => aggregateProjectsStage(projects, boards, activeProject?.id),
    [projects, boards, activeProject?.id],
  );

  const isProjectChat =
    route.name === "project" && activeProject !== undefined && route.view === "chat";
  const activeWorkerId = route.name === "project" ? route.workerId : undefined;
  const isRouterActive = isProjectChat && activeWorkerId === undefined;
  const closedExpanded =
    showClosed || (isProjectChat && closedWorkers.some((w) => w.id === activeWorkerId));
  const firstQuestionText = openQuestions[0]?.items[0]?.question?.trim();

  const switcherLabel = activeProject
    ? activeProject.title
    : projects.length > 0
      ? t("sidebar.overview")
      : t("sidebar.selectProject");

  return (
    <>
      <div className="ev-side-head">
        <button type="button" className="ev-brand" onClick={onOpenOverview}>
          <BrandLogo size={20} />
          <span>Eevee</span>
        </button>
        <span className="ev-flex-1" />
        <EvTooltip content={`${t("shortcuts.palette")} (${modLabel()} K)`} side="bottom">
          <button type="button" className="ev-kbd-pill" onClick={onOpenPalette}>
            {modLabel()} K
          </button>
        </EvTooltip>
      </div>

      <div className="ev-project-switcher-wrap">
        <ProjectSwitcher.Root>
          <EvTooltip content={activeProject?.workspaces.join(" · ") ?? switcherLabel} side="right">
            <ProjectSwitcher.Trigger
              className="ev-project-switcher-btn"
              aria-label={t("sidebar.switchProject")}
              indicator={
                <span className="ev-project-switcher-end">
                  {switcherAttentionStage !== "idle" && (
                    <span className="ev-dot" data-stage={switcherAttentionStage} />
                  )}
                  <KeyboardArrowDownIcon
                    width={16}
                    height={16}
                    className="ev-project-switcher-chev"
                  />
                </span>
              }
            >
              <span className="ev-truncate ev-project-switcher-label">{switcherLabel}</span>
            </ProjectSwitcher.Trigger>
          </EvTooltip>
          <ProjectSwitcher.Portal>
            <ProjectSwitcher.Positioner align="start" sideOffset={4}>
              <ProjectSwitcher.Popup className="ev-project-menu">
                <ProjectSwitcher.Item
                  icon={
                    !activeProject ? (
                      <CheckIcon width={14} height={14} />
                    ) : (
                      <GridViewIcon width={14} height={14} />
                    )
                  }
                  endAdornment={
                    allProjectsStage !== "idle" ? (
                      <span className="ev-dot" data-stage={allProjectsStage} />
                    ) : undefined
                  }
                  onClick={onOpenOverview}
                >
                  {t("sidebar.overview")}
                </ProjectSwitcher.Item>

                {projects.length > 0 && <ProjectSwitcher.Separator />}

                {projects.length > 0 && (
                  <div className="ev-project-menu-list">
                    {projects.map((project) => {
                      const summary = deriveBoardSummary(boards[project.id]);
                      const selected = activeProject?.id === project.id;
                      return (
                        <ProjectSwitcher.Item
                          key={project.id}
                          icon={
                            selected ? (
                              <CheckIcon width={14} height={14} />
                            ) : (
                              <span className="ev-project-menu-spacer" aria-hidden="true" />
                            )
                          }
                          endAdornment={
                            summary.stage !== "idle" ? (
                              <span className="ev-dot" data-stage={summary.stage} />
                            ) : undefined
                          }
                          onClick={() => onOpenProject(project.id, "chat")}
                        >
                          {project.title}
                        </ProjectSwitcher.Item>
                      );
                    })}
                  </div>
                )}

                <ProjectSwitcher.Separator />

                <ProjectSwitcher.Item
                  icon={<AddIcon width={14} height={14} />}
                  onClick={onNewProject}
                >
                  {t("sidebar.newProject")}
                </ProjectSwitcher.Item>

                {activeProject && (
                  <>
                    <ProjectSwitcher.Item
                      icon={<EditIcon width={14} height={14} />}
                      onClick={() => onEditProject(activeProject)}
                    >
                      {t("sidebar.editProject")}
                    </ProjectSwitcher.Item>
                    <ProjectSwitcher.Item
                      className="ev-project-menu-danger"
                      icon={<DeleteIcon width={14} height={14} />}
                      onClick={() => onDeleteProject(activeProject)}
                    >
                      {t("sidebar.deleteProject")}
                    </ProjectSwitcher.Item>
                  </>
                )}
              </ProjectSwitcher.Popup>
            </ProjectSwitcher.Positioner>
          </ProjectSwitcher.Portal>
        </ProjectSwitcher.Root>
      </div>

      {activeProject ? (
        <>
          <div className="ev-side-router-block">
            <div className="ev-nav-row" data-active={isRouterActive}>
              <button
                type="button"
                className="ev-nav-row-btn"
                onClick={() => onOpenProject(activeProject.id, "chat")}
              >
                <HubIcon width={15} height={15} className="ev-nav-row-icon" />
                <span className="ev-truncate ev-flex-1">{t("sidebar.router")}</span>
              </button>
            </div>

            {openQuestions.length > 0 && (
              <EvTooltip content={firstQuestionText ?? t("sidebar.questionRow")} side="right">
                <button
                  type="button"
                  className="ev-side-question-row"
                  data-active={isRouterActive}
                  onClick={() => onOpenQuestion(activeProject.id)}
                >
                  <SubdirectoryArrowRightIcon
                    width={13}
                    height={13}
                    className="ev-side-question-icon"
                  />
                  <span className="ev-truncate ev-side-question-text">
                    {firstQuestionText || t("sidebar.questionRow")}
                  </span>
                  <span className="ev-dot" data-stage="answer" />
                </button>
              </EvTooltip>
            )}
          </div>

          <hr className="ev-side-divider" />

          <div className="ev-side-section">
            <span>{t("sidebar.workers")}</span>
          </div>

          <div className="ev-side-list">
            {activeWorkers.length === 0 && closedWorkers.length === 0 ? (
              <div className="ev-side-empty">{t("sidebar.noWorkers")}</div>
            ) : (
              <>
                {activeWorkers.map((worker) => {
                  const ticket = worker.activeTicketId
                    ? ticketById.get(worker.activeTicketId)
                    : undefined;
                  const active = isProjectChat && activeWorkerId === worker.id;
                  return (
                    <div key={worker.id} className="ev-nav-row ev-worker-row" data-active={active}>
                      <EvTooltip
                        content={
                          ticket
                            ? `${ticket.title} (${worker.id})`
                            : `${worker.name} (${worker.id})`
                        }
                        side="right"
                      >
                        <button
                          type="button"
                          className="ev-nav-row-btn ev-worker-row-btn"
                          onClick={() => onOpenProject(activeProject.id, "chat", worker.id)}
                        >
                          {ticket ? (
                            <div className="ev-worker-row-main">
                              <span className="ev-truncate ev-worker-row-title">
                                {ticket.title}
                              </span>
                              <span className="ev-truncate ev-worker-row-sub">
                                <span className="ev-mono">{worker.id}</span>
                                {" · "}
                                {worker.name}
                              </span>
                            </div>
                          ) : (
                            <>
                              <span className="ev-truncate ev-worker-row-title ev-flex-1">
                                {worker.name}
                              </span>
                              <span className="ev-mono ev-worker-row-id">{worker.id}</span>
                            </>
                          )}
                          <span className="ev-dot" data-stage={workerStage(worker)} />
                        </button>
                      </EvTooltip>
                    </div>
                  );
                })}

                {closedWorkers.length > 0 && (
                  <div className="ev-side-closed-group">
                    <button
                      type="button"
                      className="ev-side-group-btn"
                      aria-expanded={closedExpanded}
                      onClick={() => setShowClosed((prev) => !prev)}
                    >
                      <span>{t("sidebar.closedWorkers")}</span>
                      <ExpandMoreIcon
                        width={15}
                        height={15}
                        className={`ev-rail-chev${closedExpanded ? "" : " collapsed"}`}
                      />
                    </button>
                    {closedExpanded &&
                      closedWorkers.map((worker) => {
                        const active = isProjectChat && activeWorkerId === worker.id;
                        return (
                          <div
                            key={worker.id}
                            className="ev-nav-row ev-worker-row muted"
                            data-active={active}
                          >
                            <EvTooltip content={`${worker.name} (${worker.id})`} side="right">
                              <button
                                type="button"
                                className="ev-nav-row-btn ev-worker-row-btn"
                                onClick={() => onOpenProject(activeProject.id, "chat", worker.id)}
                              >
                                <span className="ev-truncate ev-worker-row-title ev-flex-1">
                                  {worker.name}
                                </span>
                                <span className="ev-mono ev-worker-row-id">{worker.id}</span>
                              </button>
                            </EvTooltip>
                          </div>
                        );
                      })}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="ev-side-section">
            <span>{t("sidebar.projects")}</span>
            <EvTooltip content={t("sidebar.newProject")} side="right">
              <IconButton aria-label={t("sidebar.newProject")} onClick={onNewProject}>
                <AddIcon width={16} height={16} />
              </IconButton>
            </EvTooltip>
          </div>

          <div className="ev-side-list">
            {projects.length === 0 ? (
              <div className="ev-side-empty">{t("sidebar.noProjects")}</div>
            ) : (
              projects.map((project) => {
                const summary = deriveBoardSummary(boards[project.id]);
                return (
                  <div key={project.id} className="ev-nav-row">
                    <EvTooltip content={project.workspaces.join(" · ")} side="right">
                      <button
                        type="button"
                        className="ev-nav-row-btn"
                        onClick={() => onOpenProject(project.id, "chat")}
                      >
                        <span className="ev-truncate ev-flex-1">{project.title}</span>
                        {summary.stage !== "idle" && (
                          <span className="ev-dot" data-stage={summary.stage} />
                        )}
                      </button>
                    </EvTooltip>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      <div className="ev-side-footer">
        <EvTooltip content={`${t("sidebar.settings")} (${modLabel()} ,)`} side="top">
          <button
            type="button"
            className="ev-nav-row-btn ev-side-footer-settings"
            onClick={onOpenControl}
          >
            <SettingsIcon width={15} height={15} className="ev-nav-row-icon" />
            <span className="ev-truncate">{t("sidebar.settings")}</span>
          </button>
        </EvTooltip>
        <EvTooltip content={`${t("sidebar.shortcuts")} (?)`} side="top">
          <IconButton aria-label={t("sidebar.shortcuts")} onClick={onOpenShortcuts}>
            <KeyboardIcon width={16} height={16} />
          </IconButton>
        </EvTooltip>
        <EvTooltip content={t("sidebar.theme", { theme: themeLabel })} side="top">
          <IconButton aria-label={t("sidebar.theme", { theme: themeLabel })} onClick={onCycleTheme}>
            {themeScheme === "dark" ? (
              <LightModeIcon width={16} height={16} />
            ) : (
              <DarkModeIcon width={16} height={16} />
            )}
          </IconButton>
        </EvTooltip>
        <EvTooltip content={t("sidebar.logout")} side="top">
          <IconButton aria-label={t("sidebar.logout")} onClick={onLogout}>
            <LogoutIcon width={16} height={16} />
          </IconButton>
        </EvTooltip>
      </div>
    </>
  );
}
