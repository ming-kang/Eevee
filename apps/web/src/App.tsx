import {
  AddIcon,
  ChevronLeftIcon,
  MenuIcon,
  RightPanelCloseIcon,
  RightPanelOpenIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, EmptyState, Heading, IconButton, Stack } from "@earendil-works/elanor-react";
import type { ConversationRef, ProjectSummary, WhenBusy, WorkerId } from "@eevee/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Composer } from "./components/Composer.tsx";
import { InspectorPanel } from "./components/InspectorPanel.tsx";
import { LoginView } from "./components/LoginView.tsx";
import { ProjectModal } from "./components/ProjectModal.tsx";
import { QuestionBanner } from "./components/QuestionBanner.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TranscriptView } from "./components/TranscriptView.tsx";
import { api, consumeTicketFromHash } from "./lib/api.ts";
import { shortPath, workerStatusLabel, workerStatusTone } from "./lib/format.ts";
import { useBoardStream, useConversationStream } from "./lib/hooks.ts";
import { useTheme } from "./lib/theme.ts";
import { parseAgentDoc, parseInbox, parseLiveDoc } from "./lib/transcript.ts";

type AuthState =
  | { readonly kind: "checking" }
  | { readonly kind: "unauthenticated"; readonly error?: string }
  | { readonly kind: "authenticated" };

const LAST_PROJECT_KEY = "eevee-last-project";

export function App() {
  const theme = useTheme();
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);
  const [activeView, setActiveView] = useState<"workspace" | "settings">("workspace");
  const [activeRef, setActiveRef] = useState<ConversationRef>("router");
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth > 900 : true,
  );
  const [inspectorOpen, setInspectorOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth > 1120 : true,
  );
  const [createModalOpen, setCreateModalOpen] = useState(false);

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
    setSelectedProjectId((prev) => {
      if (prev && res.projects.some((p) => p.id === prev)) return prev;
      let saved: string | null = null;
      try {
        saved = window.localStorage.getItem(LAST_PROJECT_KEY);
      } catch {
        // Ignore storage errors.
      }
      if (saved && res.projects.some((p) => p.id === saved)) return saved;
      return res.projects[0]?.id;
    });
  }, []);

  useEffect(() => {
    if (auth.kind !== "authenticated") return;
    void loadProjects();
  }, [auth.kind, loadProjects]);

  const selectProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    setActiveRef("router");
    setActiveView("workspace");
    try {
      window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
    } catch {
      // Ignore storage errors.
    }
  };

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId),
    [projects, selectedProjectId],
  );

  const boardStream = useBoardStream(auth.kind === "authenticated" ? selectedProjectId : undefined);
  const convStream = useConversationStream(
    auth.kind === "authenticated" && activeView === "workspace" ? selectedProjectId : undefined,
    activeRef,
  );

  const live = useMemo(() => parseLiveDoc(convStream.view), [convStream.view]);
  const inbox = useMemo(() => parseInbox(convStream.view), [convStream.view]);
  const agentInfo = useMemo(() => parseAgentDoc(convStream.view), [convStream.view]);

  const activeWorker = useMemo(
    () =>
      activeRef === "router"
        ? undefined
        : boardStream.board?.workers.find((w) => w.id === activeRef),
    [activeRef, boardStream.board],
  );

  const handleLogout = async () => {
    await api.logoutWebSession().catch(() => undefined);
    setProjects([]);
    setSelectedProjectId(undefined);
    setAuth({ kind: "unauthenticated" });
  };

  if (auth.kind === "checking") {
    return (
      <div className="eevee-login-page">
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

  const handleSelectWorker = (workerId: WorkerId) => {
    setActiveRef(workerId);
    setActiveView("workspace");
  };

  return (
    <div className="eevee-app" data-sidebar-open={sidebarOpen}>
      <Sidebar
        projects={projects}
        selectedProjectId={selectedProjectId}
        activeView={activeView}
        activeRef={activeRef}
        board={boardStream.board}
        themePreference={theme.preference}
        themeScheme={theme.scheme}
        onSelectProject={selectProject}
        onOpenCreateProject={() => setCreateModalOpen(true)}
        onSelectConversation={(ref) => {
          setActiveRef(ref);
          setActiveView("workspace");
          if (window.innerWidth <= 900) setSidebarOpen(false);
        }}
        onOpenSettings={() => {
          setActiveView("settings");
          if (window.innerWidth <= 900) setSidebarOpen(false);
        }}
        onCycleTheme={theme.cycle}
        onLogout={() => void handleLogout()}
      />

      {activeView === "settings" ? (
        <SettingsView onBack={() => setActiveView("workspace")} />
      ) : !selectedProject ? (
        <main className="eevee-main">
          <header className="eevee-topbar">
            <div className="eevee-topbar-left">
              <IconButton aria-label="切换侧栏" onClick={() => setSidebarOpen((p) => !p)}>
                <MenuIcon width={18} height={18} />
              </IconButton>
              <Heading level={1} size={5}>
                Eevee
              </Heading>
            </div>
          </header>
          <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 24 }}>
            <EmptyState.Root>
              <EmptyState.Body>
                <EmptyState.Copy>
                  <EmptyState.Title level={2}>还没有项目</EmptyState.Title>
                  <EmptyState.Description>
                    创建一个项目并绑定本地工作目录，Router 与 Workers 就可以开始工作。
                  </EmptyState.Description>
                </EmptyState.Copy>
                <EmptyState.Actions>
                  <Button
                    hierarchy="primary"
                    iconStart={<AddIcon width={16} height={16} />}
                    onClick={() => setCreateModalOpen(true)}
                  >
                    新建项目
                  </Button>
                </EmptyState.Actions>
              </EmptyState.Body>
            </EmptyState.Root>
          </div>
        </main>
      ) : (
        <>
          <main className="eevee-main">
            <header className="eevee-topbar">
              <div className="eevee-topbar-left">
                <IconButton aria-label="切换侧栏" onClick={() => setSidebarOpen((p) => !p)}>
                  <MenuIcon width={18} height={18} />
                </IconButton>
                {activeRef !== "router" && (
                  <Button
                    hierarchy="tertiary"
                    density="compact"
                    iconStart={<ChevronLeftIcon width={16} height={16} />}
                    onClick={() => setActiveRef("router")}
                  >
                    Router
                  </Button>
                )}
                <div className="eevee-topbar-title">
                  <Stack direction="row" gap="xSmall" align="center">
                    <Heading level={1} size={5} style={{ margin: 0 }}>
                      {activeRef === "router"
                        ? `${selectedProject.title} · Router`
                        : `${activeRef} · ${activeWorker?.name ?? "Worker"}`}
                    </Heading>
                    {activeWorker && (
                      <span
                        className="eevee-badge"
                        data-tone={workerStatusTone(activeWorker.status)}
                      >
                        {workerStatusLabel(activeWorker.status)}
                      </span>
                    )}
                    {live.busy && (
                      <span className="eevee-badge" data-tone="info">
                        执行中
                      </span>
                    )}
                  </Stack>
                  <span className="eevee-topbar-sub">
                    {agentInfo.modelLabel ?? "默认模型"}
                    {agentInfo.thinkingLevel && agentInfo.thinkingLevel !== "off"
                      ? ` (${agentInfo.thinkingLevel})`
                      : ""}
                    {agentInfo.cwd ? ` · ${shortPath(agentInfo.cwd)}` : ""}
                  </span>
                </div>
              </div>

              <div className="eevee-topbar-actions">
                <span
                  className="eevee-badge"
                  data-tone={convStream.connected ? "positive" : "warning"}
                >
                  {convStream.connected ? "实时已连接" : "重连中…"}
                </span>
                <IconButton
                  aria-label={inspectorOpen ? "隐藏右侧面板" : "展开右侧面板"}
                  title={inspectorOpen ? "隐藏右侧面板" : "展开右侧面板"}
                  onClick={() => setInspectorOpen((prev) => !prev)}
                >
                  {inspectorOpen ? (
                    <RightPanelCloseIcon width={18} height={18} />
                  ) : (
                    <RightPanelOpenIcon width={18} height={18} />
                  )}
                </IconButton>
              </div>
            </header>

            {convStream.error && (
              <div style={{ padding: "8px 16px 0" }}>
                <div className="eevee-error-banner">对话流异常：{convStream.error}</div>
              </div>
            )}

            <QuestionBanner
              projectId={selectedProject.id}
              questions={boardStream.board?.questions ?? []}
            />

            <TranscriptView
              activeRef={activeRef}
              entries={convStream.entries}
              live={live}
              inbox={inbox}
              hasMoreOlder={convStream.hasMoreOlder}
              loadingOlder={convStream.loadingOlder}
              onLoadOlder={() => void convStream.loadOlder()}
              onSelectWorker={handleSelectWorker}
            />

            <Composer
              activeRef={activeRef}
              busy={live.busy}
              hasRunFailure={live.runFailure !== undefined}
              disabled={activeWorker?.status === "closed"}
              onSend={async (text: string, whenBusy: WhenBusy) => {
                await api.sendMessage(selectedProject.id, activeRef, { text, whenBusy });
              }}
              onInterrupt={async () => {
                await api.interrupt(selectedProject.id, activeRef);
              }}
              onRetry={async () => {
                await api.retry(selectedProject.id, activeRef);
              }}
            />
          </main>

          <InspectorPanel
            open={inspectorOpen}
            onOpenChange={setInspectorOpen}
            project={selectedProject}
            board={boardStream.board}
            activeRef={activeRef}
            onSelectWorker={handleSelectWorker}
            onProjectUpdated={(updated) =>
              setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
            }
            onProjectDeleted={(deletedId) => {
              setProjects((prev) => {
                const rest = prev.filter((p) => p.id !== deletedId);
                setSelectedProjectId(rest[0]?.id);
                return rest;
              });
              setActiveRef("router");
            }}
          />
        </>
      )}

      <ProjectModal
        open={createModalOpen}
        onOpenChange={setCreateModalOpen}
        onCreated={(created) => {
          setProjects((prev) => [created, ...prev]);
          selectProject(created.id);
        }}
      />
    </div>
  );
}
