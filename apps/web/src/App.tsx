import {
  LeftPanelCloseIcon,
  LeftPanelOpenIcon,
  RightPanelCloseIcon,
  RightPanelOpenIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, IconButton, Tooltip } from "@earendil-works/elanor-react";
import type { ProjectId, ProjectSummary, WorkerId } from "@eevee/protocol";
import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BrandLogo } from "./components/BrandLogo.tsx";
import { ChatPage } from "./components/ChatPage.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { EvTooltip } from "./components/EvTooltip.tsx";
import { LoginView } from "./components/LoginView.tsx";
import { MemoryPage } from "./components/MemoryPage.tsx";
import { OverviewPage } from "./components/OverviewPage.tsx";
import { ProjectModal } from "./components/ProjectModal.tsx";
import { RightRail } from "./components/RightRail.tsx";
import { Sash } from "./components/Sash.tsx";

const SettingsView = lazy(() =>
  import("./components/SettingsView.tsx").then((m) => ({ default: m.SettingsView })),
);
const EditProjectModal = lazy(() =>
  import("./components/ProjectDialogs.tsx").then((m) => ({ default: m.EditProjectModal })),
);
const DeleteProjectModal = lazy(() =>
  import("./components/ProjectDialogs.tsx").then((m) => ({ default: m.DeleteProjectModal })),
);

import { ShortcutSheet } from "./components/ShortcutSheet.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { ToastHost } from "./components/ToastHost.tsx";
import { UsagePage } from "./components/UsagePage.tsx";
import { useProjectBoards } from "./lib/hooks.ts";
import { useI18n } from "./lib/i18n.ts";
import { useShellLayout } from "./lib/layout.ts";
import { buildPaletteItems } from "./lib/palette-items.ts";
import {
  navigate,
  type ProjectSubView,
  parseRoute,
  type Route,
  type SettingsSection,
} from "./lib/router.ts";
import { SHORTCUT_PRIORITY, useShortcutLayer } from "./lib/shortcut-stack.ts";
import { modLabel } from "./lib/shortcuts.ts";
import { useTheme } from "./lib/theme.ts";
import { deriveBoardSummary } from "./lib/transcript.ts";
import { useAuthSession } from "./lib/useAuthSession.ts";
import { useProjectsStore } from "./lib/useProjectsStore.ts";

export function App() {
  const { t } = useI18n();
  const theme = useTheme();
  const { auth, login, logout } = useAuthSession();
  const authenticated = auth.kind === "authenticated";
  const projectsStore = useProjectsStore(authenticated);
  const { projects } = projectsStore;
  const boards = useProjectBoards(authenticated);

  const [route, setRoute] = useState<Route>(() =>
    typeof window !== "undefined" ? parseRoute(window.location.hash) : { name: "overview" },
  );
  const bgRouteRef = useRef<Exclude<Route, { name: "control" }>>({ name: "overview" });

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [questionFocusNonce, setQuestionFocusNonce] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectSummary | undefined>(undefined);
  const [deletingProject, setDeletingProject] = useState<ProjectSummary | undefined>(undefined);

  useEffect(() => {
    const sync = () => {
      const next = parseRoute(window.location.hash);
      if (next.name !== "control") bgRouteRef.current = next;
      setRoute(next);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const surfaceRoute: Exclude<Route, { name: "control" }> =
    route.name === "control" ? bgRouteRef.current : route;

  const activeProject = useMemo(
    () =>
      surfaceRoute.name === "project" ? projects.find((p) => p.id === surfaceRoute.pid) : undefined,
    [projects, surfaceRoute],
  );

  const activeWorkerId = surfaceRoute.name === "project" ? surfaceRoute.workerId : undefined;
  const withRail = surfaceRoute.name === "project" && activeProject !== undefined;
  const layout = useShellLayout(withRail);

  const routeKey =
    surfaceRoute.name === "project"
      ? `${surfaceRoute.pid}:${surfaceRoute.view}:${surfaceRoute.workerId ?? "router"}`
      : "overview";
  useEffect(() => {
    void routeKey;
    setFindOpen(false);
  }, [routeKey]);

  const openOverview = useCallback(() => {
    layout.closeDrawer();
    navigate({ name: "overview" });
  }, [layout]);

  const openProject = useCallback(
    (pid: ProjectId, view: ProjectSubView = "chat", workerId?: WorkerId) => {
      layout.closeDrawer();
      navigate({ name: "project", pid, view, ...(workerId ? { workerId } : {}) });
    },
    [layout],
  );

  const openQuestion = useCallback(
    (pid: ProjectId) => {
      layout.closeDrawer();
      setQuestionFocusNonce((prev) => prev + 1);
      navigate({ name: "project", pid, view: "chat" });
    },
    [layout],
  );

  const openControl = useCallback(
    (section: SettingsSection = "general") => {
      layout.closeDrawer();
      navigate({ name: "control", section });
    },
    [layout],
  );

  const closeControl = useCallback(() => {
    navigate(bgRouteRef.current);
  }, []);

  const modalOpen =
    paletteOpen ||
    shortcutsOpen ||
    createOpen ||
    editingProject !== undefined ||
    deletingProject !== undefined;

  useShortcutLayer({
    id: "app-global-shortcuts",
    active:
      authenticated &&
      !shortcutsOpen &&
      !createOpen &&
      editingProject === undefined &&
      deletingProject === undefined,
    priority: SHORTCUT_PRIORITY.GLOBAL,
    onKeyDown: (event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
        return true;
      }
      if (mod && !event.altKey && event.key === ",") {
        event.preventDefault();
        setPaletteOpen(false);
        if (route.name === "control") closeControl();
        else openControl("general");
        return true;
      }
      return false;
    },
  });

  useShortcutLayer({
    id: "app-drawer-escape",
    active: authenticated && layout.drawer !== null && !modalOpen && route.name !== "control",
    priority: SHORTCUT_PRIORITY.OVERLAY,
    onKeyDown: (event) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      layout.closeDrawer();
      return true;
    },
  });

  useShortcutLayer({
    id: "app-modal-blocker",
    active: authenticated && modalOpen,
    priority: SHORTCUT_PRIORITY.MODAL,
    blocksLower: true,
  });

  useShortcutLayer({
    id: "app-background-nav",
    active: authenticated && route.name !== "control" && !modalOpen,
    priority: SHORTCUT_PRIORITY.BACKGROUND,
    onKeyDown: (event) => {
      const mod = event.metaKey || event.ctrlKey;
      const lower = event.key.toLowerCase();
      if (mod && !event.altKey && lower === "b") {
        event.preventDefault();
        layout.toggleSide();
        return true;
      }
      if (mod && event.altKey && lower === "b" && withRail) {
        event.preventDefault();
        layout.toggleRail();
        return true;
      }
      if (mod && lower === "f" && surfaceRoute.name === "project" && surfaceRoute.view === "chat") {
        event.preventDefault();
        setFindOpen(true);
        return true;
      }
      if (!mod && !event.altKey && event.key === "?") {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          target.closest("input, textarea, select, [contenteditable]")
        ) {
          return false;
        }
        event.preventDefault();
        setShortcutsOpen((prev) => !prev);
        return true;
      }
      return false;
    },
  });

  const themeLabel = t(`sidebar.theme.${theme.preference}` as const);

  const paletteItems = useMemo(
    () =>
      buildPaletteItems({
        projects,
        boards,
        activeProject,
        themeLabel,
        t,
        onOpenOverview: openOverview,
        onOpenProject: openProject,
        onNewProject: () => setCreateOpen(true),
        onOpenControl: openControl,
        onCycleTheme: theme.cycle,
        onOpenShortcuts: () => setShortcutsOpen(true),
        onToggleSide: layout.toggleSide,
        onToggleRail: layout.toggleRail,
      }),
    [
      projects,
      boards,
      activeProject,
      themeLabel,
      t,
      openOverview,
      openProject,
      openControl,
      theme.cycle,
      layout.toggleSide,
      layout.toggleRail,
    ],
  );

  if (auth.kind === "loading") {
    return (
      <div className="ev-login-page">
        <div className="ev-connecting">
          <div className="ev-landing-logo">
            <BrandLogo size={22} />
          </div>
          <span className="ev-inline-muted">{t("app.connecting")}</span>
        </div>
      </div>
    );
  }

  if (auth.kind === "login" || auth.kind === "error") {
    return (
      <LoginView
        initialError={auth.kind === "error" ? auth.error : undefined}
        onAuthenticated={() => void login()}
      />
    );
  }

  const activeBoard = activeProject ? boards[activeProject.id] : undefined;
  const activeSummary = deriveBoardSummary(activeBoard);
  const collapsedRailStage =
    activeSummary.runningTasks > 0
      ? ("working" as const)
      : activeSummary.openTickets > 0
        ? ("queued" as const)
        : undefined;

  const frameStyle = {
    "--ev-side-w": `${layout.effectiveSideWidth}px`,
    "--ev-rail-w": `${layout.effectiveRailWidth}px`,
  } as CSSProperties;

  return (
    <Tooltip.Provider delay={320} closeDelay={80}>
      <div className="ev-viewport">
        <div className="ev-side-trigger-anchor">
          <EvTooltip content={t("app.toggleSide", { shortcut: `${modLabel()} B` })} side="bottom">
            <IconButton
              aria-label={layout.sideVisible ? t("app.collapseSide") : t("app.expandSide")}
              onClick={layout.toggleSide}
            >
              {layout.sideVisible ? (
                <LeftPanelCloseIcon width={18} height={18} />
              ) : (
                <LeftPanelOpenIcon width={18} height={18} />
              )}
            </IconButton>
          </EvTooltip>
        </div>

        {withRail && (
          <div className="ev-rail-trigger-anchor">
            <div className="ev-rail-toggle-wrap">
              {!layout.railVisible && collapsedRailStage && (
                <span className="ev-dot" data-stage={collapsedRailStage} />
              )}
              <EvTooltip
                content={t("app.toggleRail", { shortcut: `${modLabel()} Alt B` })}
                side="bottom"
              >
                <IconButton
                  aria-label={layout.railVisible ? t("app.collapseRail") : t("app.expandRail")}
                  onClick={layout.toggleRail}
                >
                  {layout.railVisible ? (
                    <RightPanelCloseIcon width={18} height={18} />
                  ) : (
                    <RightPanelOpenIcon width={18} height={18} />
                  )}
                </IconButton>
              </EvTooltip>
            </div>
          </div>
        )}

        <div
          className={`ev-frame${withRail ? " with-rail" : ""}${layout.sideCollapsed ? " side-collapsed" : ""}${layout.railCollapsed ? " rail-collapsed" : ""}`}
          style={frameStyle}
        >
          <nav
            className={`ev-sidebar${layout.drawer === "side" ? " drawer-open" : ""}`}
            aria-label={t("app.mainNav")}
          >
            <div className="ev-sidebar-inner">
              <Sidebar
                projects={projects}
                boards={boards}
                activeProject={activeProject}
                route={surfaceRoute}
                themePreference={theme.preference}
                themeScheme={theme.scheme}
                onOpenOverview={openOverview}
                onOpenProject={(pid, view, wid) => openProject(pid, view, wid)}
                onOpenQuestion={openQuestion}
                onNewProject={() => setCreateOpen(true)}
                onEditProject={setEditingProject}
                onDeleteProject={setDeletingProject}
                onOpenPalette={() => setPaletteOpen(true)}
                onOpenControl={() => openControl("general")}
                onOpenShortcuts={() => setShortcutsOpen(true)}
                onCycleTheme={theme.cycle}
                onLogout={() => void logout()}
              />
            </div>
          </nav>

          <main className="ev-main">
            {surfaceRoute.name === "overview" || !activeProject ? (
              <OverviewPage
                projects={projects}
                boards={boards}
                projectsError={projectsStore.error}
                projectsLoading={projectsStore.loading}
                onRetryProjects={() => void projectsStore.reload()}
                onNewProject={() => setCreateOpen(true)}
                onOpenProject={(pid, wid) => openProject(pid, "chat", wid)}
                onOpenQuestion={openQuestion}
              />
            ) : surfaceRoute.view === "memory" ? (
              <MemoryPage
                project={activeProject}
                onSelectView={(v) => openProject(activeProject.id, v)}
                onEditProject={() => setEditingProject(activeProject)}
                onProjectUpdated={projectsStore.upsertProject}
              />
            ) : surfaceRoute.view === "usage" ? (
              <UsagePage
                project={activeProject}
                onSelectView={(v) => openProject(activeProject.id, v)}
                onEditProject={() => setEditingProject(activeProject)}
              />
            ) : (
              <ChatPage
                project={activeProject}
                board={activeBoard}
                activeWorkerId={activeWorkerId}
                questionFocusNonce={questionFocusNonce}
                findOpen={findOpen}
                onOpenFind={() => setFindOpen(true)}
                onCloseFind={() => setFindOpen(false)}
                onSelectView={(v) => openProject(activeProject.id, v)}
                onEditProject={() => setEditingProject(activeProject)}
                onOpenWorker={(wid) => openProject(activeProject.id, "chat", wid)}
                onOpenRouter={() => openProject(activeProject.id, "chat")}
                onOpenQuestion={() => openQuestion(activeProject.id)}
              />
            )}
            {projectsStore.error && surfaceRoute.name === "project" && activeProject && (
              <div className="ev-page-banner">
                <div className="ev-error-banner ev-error-row" role="alert">
                  <span className="ev-flex-1">
                    {t("app.projectsRefreshError", { error: projectsStore.error })}
                  </span>
                  <Button
                    type="button"
                    hierarchy="secondary"
                    density="compact"
                    pending={projectsStore.loading}
                    onClick={() => void projectsStore.reload()}
                  >
                    {t("common.retry")}
                  </Button>
                </div>
              </div>
            )}
          </main>

          {withRail && activeProject && (
            <aside
              className={`ev-rail${layout.drawer === "rail" ? " drawer-open" : ""}`}
              aria-label={t("app.railLabel")}
            >
              <div className="ev-rail-inner">
                <RightRail
                  projectId={activeProject.id}
                  board={activeBoard}
                  activeWorkerId={activeWorkerId}
                  onOpenWorker={(wid) => openProject(activeProject.id, "chat", wid)}
                />
              </div>
            </aside>
          )}

          {!layout.sideDrawerMode && !layout.sideCollapsed && (
            <Sash
              side="left"
              label={t("app.resizeSide")}
              min={210}
              max={400}
              now={layout.effectiveSideWidth}
              onResize={layout.setSideWidth}
              onReset={layout.resetSideWidth}
            />
          )}

          {withRail && !layout.railDrawerMode && !layout.railCollapsed && (
            <Sash
              side="right"
              label={t("app.resizeRail")}
              min={300}
              max={640}
              now={layout.effectiveRailWidth}
              onResize={layout.setRailWidth}
              onReset={layout.resetRailWidth}
            />
          )}
        </div>

        <div
          className={`ev-drawer-backdrop${layout.drawer !== null ? " on" : ""}`}
          aria-hidden="true"
          onClick={layout.closeDrawer}
        />

        {route.name === "control" && (
          <Suspense fallback={null}>
            <SettingsView
              section={route.section}
              onSelectSection={(sec) => openControl(sec)}
              onClose={closeControl}
            />
          </Suspense>
        )}

        <CommandPalette
          open={paletteOpen}
          items={paletteItems}
          onClose={() => setPaletteOpen(false)}
        />

        <ShortcutSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

        <ProjectModal
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(created) => {
            projectsStore.upsertProject(created);
            openProject(created.id, "chat");
          }}
        />

        {editingProject && (
          <Suspense fallback={null}>
            <EditProjectModal
              project={editingProject}
              onClose={() => setEditingProject(undefined)}
              onUpdated={projectsStore.upsertProject}
            />
          </Suspense>
        )}

        {deletingProject && (
          <Suspense fallback={null}>
            <DeleteProjectModal
              project={deletingProject}
              onClose={() => setDeletingProject(undefined)}
              onDeleted={(id) => {
                projectsStore.removeProject(id);
                if (surfaceRoute.name === "project" && surfaceRoute.pid === id) {
                  navigate({ name: "overview" });
                }
              }}
            />
          </Suspense>
        )}

        <ToastHost />
      </div>
    </Tooltip.Provider>
  );
}
