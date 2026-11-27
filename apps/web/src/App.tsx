import {
  LeftPanelCloseIcon,
  LeftPanelOpenIcon,
  RightPanelCloseIcon,
  RightPanelOpenIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, Heading, IconButton } from "@earendil-works/elanor-react";
import type { ProjectId, ProjectSummary, WorkerId } from "@eevee/protocol";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPage } from "./components/ChatPage.tsx";
import { CommandPalette, type PaletteItem } from "./components/CommandPalette.tsx";
import { LoginView } from "./components/LoginView.tsx";
import { MemoryPage } from "./components/MemoryPage.tsx";
import { OverviewPage } from "./components/OverviewPage.tsx";
import { DeleteProjectModal, EditProjectModal } from "./components/ProjectDialogs.tsx";
import { ProjectModal } from "./components/ProjectModal.tsx";
import { RightRail } from "./components/RightRail.tsx";
import { Sash } from "./components/Sash.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { ShortcutSheet } from "./components/ShortcutSheet.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { ToastHost } from "./components/ToastHost.tsx";
import { UsagePage } from "./components/UsagePage.tsx";
import { useProjectBoards } from "./lib/hooks.ts";
import { useShellLayout } from "./lib/layout.ts";
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
  const [createOpen, setCreateOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectSummary | undefined>(undefined);
  const [deletingProject, setDeletingProject] = useState<ProjectSummary | undefined>(undefined);

  // Hash routing sync + preserve background route behind Control overlay.
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
  const layout = useShellLayout(activeWorkerId !== undefined);

  // Close find bar when switching projects or views.
  const routeKey =
    surfaceRoute.name === "project" ? `${surfaceRoute.pid}:${surfaceRoute.view}` : "overview";
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
      if (workerId) layout.openRail();
    },
    [layout],
  );

  const openControl = useCallback(
    (section: SettingsSection = "providers") => {
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
    id: "app-command-palette-toggle",
    active:
      authenticated &&
      !shortcutsOpen &&
      !createOpen &&
      editingProject === undefined &&
      deletingProject === undefined,
    priority: SHORTCUT_PRIORITY.GLOBAL,
    onKeyDown: (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
        return true;
      }
      return false;
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

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const mod = modLabel();
    const list: PaletteItem[] = [
      {
        id: "nav:overview",
        group: "导航",
        label: "概览（全局分诊看板）",
        run: openOverview,
      },
      {
        id: "act:new-project",
        group: "操作",
        label: "新建项目",
        run: () => setCreateOpen(true),
      },
      {
        id: "act:settings",
        group: "操作",
        label: "打开 Engine 设置",
        run: () => openControl("providers"),
      },
      {
        id: "act:theme",
        group: "操作",
        label: `切换主题（当前：${theme.preference}）`,
        run: theme.cycle,
      },
      {
        id: "act:shortcuts",
        group: "操作",
        label: "查看快捷键",
        keys: ["?"],
        run: () => setShortcutsOpen(true),
      },
      {
        id: "act:toggle-side",
        group: "操作",
        label: "折叠 / 展开左侧栏",
        keys: [mod, "B"],
        run: layout.toggleSide,
      },
    ];

    for (const p of projects) {
      const summary = deriveBoardSummary(boards[p.id]);
      list.push({
        id: `proj:${p.id}`,
        group: "项目",
        label: p.title,
        meta: p.id,
        stage: summary.stage,
        run: () => openProject(p.id, "chat"),
      });
      const b = boards[p.id];
      for (const w of b?.workers ?? []) {
        if (w.status === "closed") continue;
        list.push({
          id: `worker:${p.id}:${w.id}`,
          group: "Workers",
          label: `${w.id} · ${w.name}`,
          meta: p.title,
          stage: w.status === "running" ? "working" : w.status === "queued" ? "queued" : "idle",
          run: () => openProject(p.id, "chat", w.id),
        });
      }
    }
    return list;
  }, [projects, boards, openOverview, openControl, openProject, theme, layout]);

  if (auth.kind === "loading") {
    return (
      <div className="ev-login-page">
        <Heading level={2} size={5}>
          正在连接本机 Eevee Engine…
        </Heading>
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
  const railPills: { key: string; tone: "warning" | "accent"; count: number; label: string }[] = [];
  if (activeSummary.pendingQuestions > 0) {
    railPills.push({
      key: "q",
      tone: "warning",
      count: activeSummary.pendingQuestions,
      label: `${activeSummary.pendingQuestions} 待回答`,
    });
  }
  if (activeSummary.activeWorkers > 0) {
    railPills.push({
      key: "w",
      tone: "accent",
      count: activeSummary.activeWorkers,
      label: `${activeSummary.activeWorkers} 活跃 Worker`,
    });
  }

  const frameStyle = {
    "--ev-side-w": `${layout.sideWidth}px`,
    "--ev-rail-w": `${layout.railWidth}px`,
    "--ev-rail-pills": String(layout.railCollapsed ? railPills.length : 0),
  } as CSSProperties;

  return (
    <div className="ev-viewport">
      <div className="ev-side-trigger-anchor">
        <IconButton
          aria-label={layout.sideCollapsed ? "展开左侧栏" : "折叠左侧栏"}
          title={`左侧栏（${modLabel()} B）`}
          onClick={layout.toggleSide}
        >
          {layout.sideCollapsed ? (
            <LeftPanelOpenIcon width={17} height={17} />
          ) : (
            <LeftPanelCloseIcon width={17} height={17} />
          )}
        </IconButton>
      </div>

      {withRail && (
        <div className="ev-rail-trigger-anchor">
          <div className="ev-rail-toggle-wrap">
            {layout.railCollapsed && railPills.length > 0 && (
              <div className="ev-rail-pills">
                {railPills.map((pill) => (
                  <button
                    key={pill.key}
                    type="button"
                    className="ev-rail-pill"
                    data-tone={pill.tone}
                    title={pill.label}
                    onClick={layout.openRail}
                  >
                    <span
                      className="ev-dot"
                      data-stage={pill.tone === "warning" ? "answer" : "working"}
                    />
                    <span>{pill.count}</span>
                  </button>
                ))}
              </div>
            )}
            <IconButton
              aria-label={layout.railCollapsed ? "展开右侧面板" : "折叠右侧面板"}
              title={`Workers 面板（${modLabel()} Alt B）`}
              onClick={layout.toggleRail}
            >
              {layout.railCollapsed ? (
                <RightPanelOpenIcon width={17} height={17} />
              ) : (
                <RightPanelCloseIcon width={17} height={17} />
              )}
            </IconButton>
          </div>
        </div>
      )}

      <div
        className={`ev-frame${withRail ? " with-rail" : ""}${layout.sideCollapsed ? " side-collapsed" : ""}${layout.railCollapsed ? " rail-collapsed" : ""}${layout.railMaximized ? " rail-maximized" : ""}`}
        style={frameStyle}
      >
        <nav
          className={`ev-sidebar${layout.drawer === "side" ? " drawer-open" : ""}`}
          aria-label="主导航"
        >
          <div className="ev-sidebar-inner">
            <Sidebar
              projects={projects}
              boards={boards}
              route={route}
              themePreference={theme.preference}
              themeScheme={theme.scheme}
              onOpenOverview={openOverview}
              onOpenProject={(pid, view) => openProject(pid, view)}
              onNewProject={() => setCreateOpen(true)}
              onRenameProject={setEditingProject}
              onDeleteProject={setDeletingProject}
              onOpenPalette={() => setPaletteOpen(true)}
              onOpenControl={() => openControl("providers")}
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
              findOpen={findOpen}
              onOpenFind={() => setFindOpen(true)}
              onCloseFind={() => setFindOpen(false)}
              onSelectView={(v) => openProject(activeProject.id, v)}
              onEditProject={() => setEditingProject(activeProject)}
              onOpenWorker={(wid) => openProject(activeProject.id, "chat", wid)}
            />
          )}
          {projectsStore.error && surfaceRoute.name === "project" && activeProject && (
            <div style={{ padding: "8px 20px 12px" }}>
              <div
                className="ev-error-banner"
                role="alert"
                style={{ display: "flex", alignItems: "center", gap: 10 }}
              >
                <span style={{ flex: 1 }}>刷新项目列表失败：{projectsStore.error}</span>
                <Button
                  type="button"
                  hierarchy="secondary"
                  density="compact"
                  pending={projectsStore.loading}
                  onClick={() => void projectsStore.reload()}
                >
                  重试
                </Button>
              </div>
            </div>
          )}
        </main>

        {withRail && activeProject && (
          <aside
            className={`ev-rail${layout.drawer === "rail" ? " drawer-open" : ""}`}
            aria-label="Workers 与后台任务"
          >
            <div className="ev-rail-inner">
              <RightRail
                projectId={activeProject.id}
                board={activeBoard}
                activeWorkerId={activeWorkerId}
                maximized={layout.railMaximized}
                onOpenWorker={(wid) => openProject(activeProject.id, "chat", wid)}
                onCloseWorker={() => openProject(activeProject.id, "chat")}
                onToggleMaximize={layout.toggleRailMaximize}
              />
            </div>
          </aside>
        )}

        {!layout.sideCollapsed && (
          <Sash
            side="left"
            label="调整左侧栏宽度"
            min={200}
            max={400}
            now={layout.sideWidth}
            onResize={layout.setSideWidth}
            onReset={layout.resetSideWidth}
          />
        )}

        {withRail && !layout.railCollapsed && !layout.railMaximized && (
          <Sash
            side="right"
            label="调整右侧 Workers 面板宽度"
            min={320}
            max={820}
            now={layout.railWidth}
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
        <SettingsView
          section={route.section}
          onSelectSection={(sec) => openControl(sec)}
          onClose={closeControl}
        />
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

      <EditProjectModal
        project={editingProject}
        onClose={() => setEditingProject(undefined)}
        onUpdated={projectsStore.upsertProject}
      />

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

      <ToastHost />
    </div>
  );
}
