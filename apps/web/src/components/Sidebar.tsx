import {
  AddIcon,
  CloseIcon,
  DarkModeIcon,
  KeyboardIcon,
  LightModeIcon,
  LogoutIcon,
  MoreHorizIcon,
  SearchIcon,
} from "@earendil-works/elanor-icons-react";
import { IconButton, Menu } from "@earendil-works/elanor-react";
import type { BoardViewPayload, ProjectId, ProjectSummary } from "@eevee/protocol";
import { useMemo, useRef, useState } from "react";
import { useI18n } from "../lib/i18n.ts";
import type { Route } from "../lib/router.ts";
import { modLabel } from "../lib/shortcuts.ts";
import type { ThemePreference, ThemeScheme } from "../lib/theme.ts";
import { deriveBoardSummary } from "../lib/transcript.ts";
import { BrandLogo } from "./BrandLogo.tsx";

export type SidebarProps = {
  readonly projects: readonly ProjectSummary[];
  readonly boards: Readonly<Record<string, BoardViewPayload>>;
  readonly route: Route;
  readonly themePreference: ThemePreference;
  readonly themeScheme: ThemeScheme;
  readonly onOpenOverview: () => void;
  readonly onOpenProject: (pid: ProjectId, view?: "chat" | "memory" | "usage") => void;
  readonly onNewProject: () => void;
  readonly onRenameProject: (project: ProjectSummary) => void;
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
  route,
  themePreference,
  themeScheme,
  onOpenOverview,
  onOpenProject,
  onNewProject,
  onRenameProject,
  onDeleteProject,
  onOpenPalette,
  onOpenControl,
  onOpenShortcuts,
  onCycleTheme,
  onLogout,
}: SidebarProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  const themeLabel = t(`sidebar.theme.${themePreference}` as const);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => `${p.title} ${p.id}`.toLowerCase().includes(q));
  }, [projects, filter]);

  const totalPending = useMemo(
    () => projects.reduce((sum, p) => sum + deriveBoardSummary(boards[p.id]).pendingQuestions, 0),
    [projects, boards],
  );

  const currentPid = route.name === "project" ? route.pid : undefined;

  return (
    <>
      <div className="ev-side-head">
        <button type="button" className="ev-brand" onClick={onOpenOverview}>
          <BrandLogo size={20} />
          <span>Eevee</span>
        </button>
      </div>

      <div className="ev-side-search-wrap">
        <div className="ev-side-search">
          <SearchIcon width={14} height={14} />
          <input
            ref={inputRef}
            className="ev-raw-input"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filter) {
                event.preventDefault();
                setFilter("");
              }
            }}
            placeholder={t("sidebar.searchProjects")}
            aria-label={t("sidebar.searchProjects")}
          />
          {filter ? (
            <button
              type="button"
              style={{
                border: 0,
                background: "transparent",
                color: "var(--ev-fg-subtle)",
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
                width: 20,
                height: 20,
              }}
              aria-label={t("sidebar.clearFilter")}
              onClick={() => {
                setFilter("");
                inputRef.current?.focus();
              }}
            >
              <CloseIcon width={13} height={13} />
            </button>
          ) : (
            <button
              type="button"
              className="ev-kbd-pill"
              title={`${t("shortcuts.palette")} (${modLabel()} K)`}
              onClick={onOpenPalette}
            >
              {modLabel()} K
            </button>
          )}
        </div>

        {filter.trim() === "" && (
          <div className="ev-nav-row" data-active={route.name === "overview"}>
            <button type="button" className="ev-nav-row-btn" onClick={onOpenOverview}>
              <span className="ev-truncate" style={{ flex: 1 }}>
                {t("sidebar.overview")}
              </span>
              {totalPending > 0 && (
                <span className="ev-count-badge" data-tone="warning">
                  {totalPending > 99 ? "99+" : totalPending}
                </span>
              )}
            </button>
          </div>
        )}
      </div>

      <div className="ev-side-section">
        <span>
          {t("sidebar.projects")} ({projects.length})
        </span>
        <IconButton
          aria-label={t("sidebar.newProject")}
          title={t("sidebar.newProject")}
          onClick={onNewProject}
        >
          <AddIcon width={16} height={16} />
        </IconButton>
      </div>

      <div className="ev-side-list">
        {filtered.map((project) => {
          const summary = deriveBoardSummary(boards[project.id]);
          const pending = summary.pendingQuestions;
          const active = currentPid === project.id;
          return (
            <div key={project.id} className="ev-nav-row" data-active={active}>
              <button
                type="button"
                className="ev-nav-row-btn"
                title={project.workspaces.join(" · ")}
                onClick={() => onOpenProject(project.id, "chat")}
              >
                <span className="ev-dot" data-stage={summary.stage} />
                <span className="ev-truncate" style={{ flex: 1 }}>
                  {project.title}
                </span>
              </button>

              <div className="ev-nav-row-end">
                {pending > 0 && (
                  <span
                    className="ev-count-badge ev-row-badge-hide"
                    data-tone="warning"
                    style={{ position: "absolute", pointerEvents: "none" }}
                  >
                    {pending > 99 ? "99+" : pending}
                  </span>
                )}
                <Menu.Root>
                  <Menu.Trigger
                    render={
                      <IconButton
                        className="ev-row-menu-btn"
                        aria-label={`${project.title} ${t("sidebar.projectActions")}`}
                        title={t("sidebar.projectActions")}
                      >
                        <MoreHorizIcon width={16} height={16} />
                      </IconButton>
                    }
                  />
                  <Menu.Portal>
                    <Menu.Positioner align="end" sideOffset={4}>
                      <Menu.Popup>
                        <Menu.Item onClick={() => onOpenProject(project.id, "memory")}>
                          {t("sidebar.memory")}
                        </Menu.Item>
                        <Menu.Item onClick={() => onOpenProject(project.id, "usage")}>
                          {t("sidebar.usage")}
                        </Menu.Item>
                        <Menu.Separator />
                        <Menu.Item onClick={() => onRenameProject(project)}>
                          {t("sidebar.editProject")}
                        </Menu.Item>
                        <Menu.Item onClick={() => onDeleteProject(project)}>
                          {t("sidebar.deleteProject")}
                        </Menu.Item>
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.Root>
              </div>
            </div>
          );
        })}

        {projects.length > 0 && filtered.length === 0 && (
          <div
            style={{ padding: "8px 10px", fontSize: "0.78125rem", color: "var(--ev-fg-subtle)" }}
          >
            {t("sidebar.noMatchingProjects")}
          </div>
        )}
      </div>

      <div className="ev-side-footer">
        <button
          type="button"
          className="ev-nav-row-btn"
          style={{ padding: "6px 10px", fontSize: "0.84375rem", color: "var(--ev-fg-muted)" }}
          onClick={onOpenControl}
        >
          {t("sidebar.settings")}
        </button>
        <IconButton
          aria-label={t("sidebar.shortcuts")}
          title={`${t("sidebar.shortcuts")} (?)`}
          onClick={onOpenShortcuts}
        >
          <KeyboardIcon width={16} height={16} />
        </IconButton>
        <IconButton
          aria-label={t("sidebar.theme", { theme: themeLabel })}
          title={t("sidebar.theme", { theme: themeLabel })}
          onClick={onCycleTheme}
        >
          {themeScheme === "dark" ? (
            <LightModeIcon width={16} height={16} />
          ) : (
            <DarkModeIcon width={16} height={16} />
          )}
        </IconButton>
        <IconButton aria-label={t("sidebar.logout")} title={t("sidebar.logout")} onClick={onLogout}>
          <LogoutIcon width={16} height={16} />
        </IconButton>
      </div>
    </>
  );
}
