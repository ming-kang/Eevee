import {
  AddIcon,
  ChevronRightIcon,
  DarkModeIcon,
  ExpandMoreIcon,
  ForumIcon,
  LightModeIcon,
  LogoutIcon,
  SettingsIcon,
  SmartToyIcon,
} from "@earendil-works/elanor-icons-react";
import { IconButton, Stack } from "@earendil-works/elanor-react";
import type { BoardViewPayload, ConversationRef, ProjectSummary } from "@eevee/protocol";
import { useState } from "react";
import { workerStatusLabel } from "../lib/format.ts";
import type { ThemePreference, ThemeScheme } from "../lib/theme.ts";

export type SidebarProps = {
  readonly projects: readonly ProjectSummary[];
  readonly selectedProjectId: string | undefined;
  readonly activeView: "workspace" | "settings";
  readonly activeRef: ConversationRef;
  readonly board: BoardViewPayload | undefined;
  readonly themePreference: ThemePreference;
  readonly themeScheme: ThemeScheme;
  readonly onSelectProject: (projectId: string) => void;
  readonly onOpenCreateProject: () => void;
  readonly onSelectConversation: (ref: ConversationRef) => void;
  readonly onOpenSettings: () => void;
  readonly onCycleTheme: () => void;
  readonly onLogout: () => void;
};

export function Sidebar({
  projects,
  selectedProjectId,
  activeView,
  activeRef,
  board,
  themePreference,
  themeScheme,
  onSelectProject,
  onOpenCreateProject,
  onSelectConversation,
  onOpenSettings,
  onCycleTheme,
  onLogout,
}: SidebarProps) {
  const [showClosed, setShowClosed] = useState(false);

  const workers = board?.workers ?? [];
  const ticketsById = new Map((board?.tickets ?? []).map((t) => [t.id, t]));
  const activeWorkers = workers.filter((w) => w.status !== "closed");
  const closedWorkers = workers.filter((w) => w.status === "closed");
  const pendingQuestions = (board?.questions ?? []).filter(
    (q) => q.answeredAt === undefined && q.withdrawnAt === undefined,
  ).length;

  return (
    <aside className="eevee-sidebar">
      <div className="eevee-sidebar-header">
        <div className="eevee-brand-row">
          <div className="eevee-brand">
            <SmartToyIcon width={18} height={18} />
            <span>Eevee</span>
          </div>
          <IconButton aria-label="新建项目" title="新建项目" onClick={onOpenCreateProject}>
            <AddIcon width={18} height={18} />
          </IconButton>
        </div>

        <select
          aria-label="切换项目"
          className="eevee-project-select"
          value={selectedProjectId ?? ""}
          onChange={(event) => {
            if (event.target.value) onSelectProject(event.target.value);
          }}
        >
          {projects.length === 0 && <option value="">暂无项目</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
      </div>

      <div className="eevee-sidebar-scroll">
        {selectedProjectId && (
          <>
            <div className="eevee-nav-label">主入口</div>
            <button
              type="button"
              className="eevee-nav-item"
              data-active={activeView === "workspace" && activeRef === "router"}
              onClick={() => onSelectConversation("router")}
            >
              <ForumIcon width={17} height={17} style={{ marginTop: 2, flexShrink: 0 }} />
              <div className="eevee-nav-body">
                <div className="eevee-nav-title">
                  <span className="eevee-nav-title-text">Router</span>
                  {pendingQuestions > 0 && (
                    <span className="eevee-badge" data-tone="warning">
                      {pendingQuestions} 问
                    </span>
                  )}
                </div>
                <span className="eevee-nav-meta">全局统筹 · 二叉森林记忆</span>
              </div>
            </button>

            <div className="eevee-nav-label">
              <span>Workers ({activeWorkers.length})</span>
            </div>
            {activeWorkers.length === 0 ? (
              <div
                style={{
                  padding: "6px 10px",
                  fontSize: "0.82rem",
                  color: "var(--semantic-color-text-secondary)",
                }}
              >
                暂无活跃 Worker
              </div>
            ) : (
              activeWorkers.map((worker) => {
                const ticket =
                  worker.activeTicketId !== undefined
                    ? ticketsById.get(worker.activeTicketId)
                    : undefined;
                return (
                  <button
                    key={worker.id}
                    type="button"
                    className="eevee-nav-item"
                    data-active={activeView === "workspace" && activeRef === worker.id}
                    onClick={() => onSelectConversation(worker.id)}
                  >
                    <span className="eevee-dot" data-status={worker.status} />
                    <div className="eevee-nav-body">
                      <div className="eevee-nav-title">
                        <span className="eevee-nav-title-text">
                          {worker.id} · {worker.name}
                        </span>
                        {worker.activeTaskCount > 0 && (
                          <span className="eevee-badge" data-tone="info">
                            {worker.activeTaskCount} 任务
                          </span>
                        )}
                      </div>
                      <span className="eevee-nav-meta">
                        {ticket
                          ? `${ticket.id}: ${ticket.title}`
                          : workerStatusLabel(worker.status)}
                      </span>
                    </div>
                  </button>
                );
              })
            )}

            {closedWorkers.length > 0 && (
              <>
                <button
                  type="button"
                  className="eevee-nav-label"
                  style={{ border: 0, background: "transparent", cursor: "pointer", width: "100%" }}
                  onClick={() => setShowClosed((prev) => !prev)}
                >
                  <span>已关闭 Workers ({closedWorkers.length})</span>
                  {showClosed ? (
                    <ExpandMoreIcon width={15} height={15} />
                  ) : (
                    <ChevronRightIcon width={15} height={15} />
                  )}
                </button>
                {showClosed &&
                  closedWorkers.map((worker) => (
                    <button
                      key={worker.id}
                      type="button"
                      className="eevee-nav-item"
                      data-active={activeView === "workspace" && activeRef === worker.id}
                      onClick={() => onSelectConversation(worker.id)}
                    >
                      <span className="eevee-dot" data-status="closed" />
                      <div className="eevee-nav-body">
                        <div className="eevee-nav-title">
                          <span className="eevee-nav-title-text">
                            {worker.id} · {worker.name}
                          </span>
                        </div>
                        <span className="eevee-nav-meta">已关闭</span>
                      </div>
                    </button>
                  ))}
              </>
            )}
          </>
        )}
      </div>

      <div className="eevee-sidebar-footer">
        <button
          type="button"
          className="eevee-nav-item"
          style={{ padding: "6px 8px" }}
          data-active={activeView === "settings"}
          onClick={onOpenSettings}
        >
          <SettingsIcon width={17} height={17} style={{ marginTop: 1, flexShrink: 0 }} />
          <span style={{ fontSize: "0.88rem" }}>Engine 设置</span>
        </button>
        <Stack direction="row" gap="xxSmall" align="center">
          <IconButton
            aria-label={`切换主题（当前：${themePreference}）`}
            title={`主题：${themePreference}（点击切换）`}
            onClick={onCycleTheme}
          >
            {themeScheme === "dark" ? (
              <LightModeIcon width={17} height={17} />
            ) : (
              <DarkModeIcon width={17} height={17} />
            )}
          </IconButton>
          <IconButton aria-label="退出登录" title="退出登录" onClick={onLogout}>
            <LogoutIcon width={17} height={17} />
          </IconButton>
        </Stack>
      </div>
    </aside>
  );
}
