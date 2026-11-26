import {
  LeftPanelCloseIcon,
  LeftPanelOpenIcon,
  RightPanelCloseIcon,
  RightPanelOpenIcon,
} from "@earendil-works/elanor-icons-react";
import { Heading, IconButton } from "@earendil-works/elanor-react";
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
import { api, consumeTicketFromHash } from "./lib/api.ts";
import { useProjectBoards } from "./lib/hooks.ts";
import { useShellLayout } from "./lib/layout.ts";
import {
  navigate,
  type ProjectSubView,
  parseRoute,
  type Route,
  type SettingsSection,
} from "./lib/router.ts";
import { modLabel } from "./lib/shortcuts.ts";
import { useTheme } from "./lib/theme.ts";
import { deriveBoardSummary } from "./lib/transcript.ts";

type AuthState =
  | { readonly kind: "checking" }
  | { readonly kind: "unauthenticated"; readonly error?: string }
  | { readonly kind: "authenticated" };

export function App() {
  const theme = useTheme();
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
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

  useEffect(() => {
    let active = true;
    const initAuth = async () => {
      const ticket = consumeTicketFromHash();
      if (ticket) {
        try {
          await api.createWebSession({ ticket });
          if (active) setAuth({ kind: "authenticated" });
          return;
        } catch (err) {
          if (active) {
            setAuth({
              kind: "unauthenticated",
              error: `登录链接已失效或已使用：${err instanceof Error ? err.message : String(err)}`,
            });
          }
          return;
        }
      }
      try {
        const session = await api.getWebSession();
        if (active) {
          setAuth(session.authenticated ? { kind: "authenticated" } : { kind: "unauthenticated" });
        }
      } catch (err) {
        if (active) {
          setAuth({
            kind: "unauthenticated",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
    void initAuth();
    return () => {
      active = false;
    };
  }, []);

  const loadProjects = useCallback(async () => {
    const res = await api.listProjects();
    setProjects(res.projects);
  }, []);

  useEffect(() => {
    if (auth.kind !== "authenticated") return;
    void loadProjects();
  }, [auth.kind, loadProjects]);

  const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);
  const boards = useProjectBoards(projectIds, auth.kind === "authenticated");

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

  // Global keyboard shortcuts.
  useEffect(() => {
    if (auth.kind !== "authenticated") return;
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const lower = event.key.toLowerCase();
      if (mod && lower === "k") {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
        return;
      }
      if (mod && !event.altKey && lower === "b") {
        event.preventDefault();
        layout.toggleSide();
        return;
      }
      if (mod && event.altKey && lower === "b" && withRail) {
        event.preventDefault();
        layout.toggleRail();
        return;
      }
      if (mod && lower === "f" && surfaceRoute.name === "project" && surfaceRoute.view === "chat") {
        event.preventDefault();
        setFindOpen(true);
        return;
      }
      if (!mod && !event.altKey && event.key === "?") {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          target.closest("input, textarea, select, [contenteditable]")
        ) {
          return;
        }
        event.preventDefault();
        setShortcutsOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [auth.kind, layout, withRail, surfaceRoute]);

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

  const handleLogout = async () => {
    await api.logoutWebSession().catch(() => undefined);
    setProjects([]);
    setAuth({ kind: "unauthenticated" });
  };

  if (auth.kind === "checking") {
    return (
      <div className="ev-login-page">
        <Heading level={2} size={5}>
          正在连接本机 Eevee Engine…
        </Heading>
      </div>
    );
  }

  if (auth.kind === "unauthenticated") {
    return (
      <LoginView
        initialError={auth.error}
        onAuthenticated={() => setAuth({ kind: "authenticated" })}
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
              onLogout={() => void handleLogout()}
            />
          </div>
        </nav>

        <main className="ev-main">
          {surfaceRoute.name === "overview" || !activeProject ? (
            <OverviewPage
              projects={projects}
              boards={boards}
              onNewProject={() => setCreateOpen(true)}
              onOpenProject={(pid, wid) => openProject(pid, "chat", wid)}
            />
          ) : surfaceRoute.view === "memory" ? (
            <MemoryPage
              project={activeProject}
              onSelectView={(v) => openProject(activeProject.id, v)}
              onEditProject={() => setEditingProject(activeProject)}
              onProjectUpdated={(updated) =>
                setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
              }
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
          setProjects((prev) => [created, ...prev]);
          openProject(created.id, "chat");
        }}
      />

      <EditProjectModal
        project={editingProject}
        onClose={() => setEditingProject(undefined)}
        onUpdated={(updated) =>
          setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
        }
      />

      <DeleteProjectModal
        project={deletingProject}
        onClose={() => setDeletingProject(undefined)}
        onDeleted={(id) => {
          setProjects((prev) => prev.filter((p) => p.id !== id));
          if (surfaceRoute.name === "project" && surfaceRoute.pid === id) {
            navigate({ name: "overview" });
          }
        }}
      />

      <ToastHost />
    </div>
  );
}
