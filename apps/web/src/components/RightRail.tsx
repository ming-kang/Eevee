import {
  ArrowBackIcon,
  CloseFullscreenIcon,
  ExpandMoreIcon,
  OpenInFullIcon,
} from "@earendil-works/elanor-icons-react";
import { IconButton } from "@earendil-works/elanor-react";
import type {
  BoardViewPayload,
  ProjectId,
  WorkerBoardItemPayload,
  WorkerId,
} from "@eevee/protocol";
import { useEffect, useMemo, useState } from "react";
import { workerStatusLabel } from "../lib/format.ts";
import type { VisualStage } from "../lib/transcript.ts";
import { TasksList } from "./rail/TasksList.tsx";
import { WorkerPanel } from "./rail/WorkerPanel.tsx";

function workerStage(w: WorkerBoardItemPayload): VisualStage {
  if (w.status === "running") return "working";
  if (w.status === "queued") return "queued";
  if (w.status === "closed") return "done";
  return "idle";
}

export function RightRail({
  projectId,
  board,
  activeWorkerId,
  maximized,
  onOpenWorker,
  onCloseWorker,
  onToggleMaximize,
}: {
  readonly projectId: ProjectId;
  readonly board: BoardViewPayload | undefined;
  readonly activeWorkerId: WorkerId | undefined;
  readonly maximized: boolean;
  readonly onOpenWorker: (workerId: WorkerId) => void;
  readonly onCloseWorker: () => void;
  readonly onToggleMaximize: () => void;
}) {
  const [tab, setTab] = useState<"workers" | "tasks">("workers");
  const [showClosed, setShowClosed] = useState(false);

  const workers = board?.workers ?? [];
  const tickets = board?.tickets ?? [];
  const ticketById = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets]);

  const activeWorkers = workers.filter((w) => w.status !== "closed");
  const openTicketsWithoutActiveWorker = tickets.filter(
    (t) => t.status === "open" && !activeWorkers.some((w) => w.activeTicketId === t.id),
  );
  const doneTickets = tickets.filter((t) => t.status !== "open");
  const closedWorkers = workers.filter((w) => w.status === "closed");
  const runningTasksCount = workers.reduce((sum, w) => sum + w.activeTaskCount, 0);
  const currentWorker = activeWorkerId ? workers.find((w) => w.id === activeWorkerId) : undefined;

  useEffect(() => {
    if (!activeWorkerId) return;
    const onEsc = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const t = event.target;
      if (t instanceof HTMLElement && t.closest("input, textarea, [contenteditable]")) return;
      event.preventDefault();
      onCloseWorker();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [activeWorkerId, onCloseWorker]);

  return (
    <section className="ev-rail-section">
      <div className="ev-rail-head">
        {activeWorkerId ? (
          <>
            <IconButton aria-label="返回列表" title="返回列表（Esc）" onClick={onCloseWorker}>
              <ArrowBackIcon width={16} height={16} />
            </IconButton>
            <span className="ev-chip-id">{activeWorkerId}</span>
            <span className="ev-truncate ev-rail-worker-title">
              {currentWorker?.name ?? "Worker"}
            </span>
            {currentWorker && <span className="ev-dot" data-stage={workerStage(currentWorker)} />}
            <IconButton
              aria-label={maximized ? "还原右侧面板" : "最大化 Worker 面板"}
              title={maximized ? "还原右侧面板" : "最大化 Worker 面板"}
              onClick={onToggleMaximize}
            >
              {maximized ? (
                <CloseFullscreenIcon width={15} height={15} />
              ) : (
                <OpenInFullIcon width={15} height={15} />
              )}
            </IconButton>
          </>
        ) : (
          <div className="ev-header-nav">
            <button
              type="button"
              className="ev-tab-link"
              data-active={tab === "workers"}
              onClick={() => setTab("workers")}
            >
              <span>Workers</span>
              {activeWorkers.length > 0 && (
                <span className="ev-count-badge">{activeWorkers.length}</span>
              )}
            </button>
            <button
              type="button"
              className="ev-tab-link"
              data-active={tab === "tasks"}
              onClick={() => setTab("tasks")}
            >
              <span>后台任务</span>
              {runningTasksCount > 0 && (
                <span className="ev-count-badge" data-tone="warning">
                  {runningTasksCount}
                </span>
              )}
            </button>
          </div>
        )}
      </div>

      {activeWorkerId ? (
        <WorkerPanel projectId={projectId} worker={currentWorker} board={board} />
      ) : tab === "tasks" ? (
        <div className="ev-rail-scroll">
          <TasksList projectId={projectId} workers={workers} onOpenWorker={onOpenWorker} />
        </div>
      ) : (
        <div className="ev-rail-scroll">
          {workers.length === 0 ? (
            <div className="ev-rail-empty">暂无 Worker</div>
          ) : (
            <>
              {activeWorkers.length > 0 && (
                <>
                  <div className="ev-group-label">
                    <span>活跃 Workers</span>
                    <span className="ev-num">{activeWorkers.length}</span>
                  </div>
                  {activeWorkers.map((w) => {
                    const ticket = w.activeTicketId ? ticketById.get(w.activeTicketId) : undefined;
                    return (
                      <button
                        key={w.id}
                        type="button"
                        className="ev-rail-item"
                        onClick={() => onOpenWorker(w.id)}
                      >
                        <span className="ev-dot ev-rail-dot" data-stage={workerStage(w)} />
                        <div className="ev-rail-item-main">
                          <div className="ev-truncate ev-rail-item-title">
                            {ticket ? ticket.title : w.name}
                          </div>
                          <div className="ev-truncate ev-rail-item-sub">
                            {w.name} · {workerStatusLabel(w.status)}
                            {w.activeTaskCount > 0 ? ` · ${w.activeTaskCount} 后台任务` : ""}
                          </div>
                        </div>
                        <span className="ev-chip-id">{ticket?.id ?? w.id}</span>
                      </button>
                    );
                  })}
                </>
              )}

              {openTicketsWithoutActiveWorker.length > 0 && (
                <>
                  <div className="ev-group-label">
                    <span>其他进行中 Tickets</span>
                    <span className="ev-num">{openTicketsWithoutActiveWorker.length}</span>
                  </div>
                  {openTicketsWithoutActiveWorker.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="ev-rail-item"
                      onClick={() => onOpenWorker(t.workerId)}
                    >
                      <span className="ev-dot ev-rail-dot" data-stage="queued" />
                      <div className="ev-rail-item-main">
                        <div className="ev-truncate ev-rail-item-title-sm">{t.title}</div>
                        <div className="ev-rail-item-sub-sm">归属 {t.workerId}</div>
                      </div>
                      <span className="ev-chip-id">{t.id}</span>
                    </button>
                  ))}
                </>
              )}

              {doneTickets.length > 0 && (
                <>
                  <div className="ev-group-label">
                    <span>已结束 Tickets</span>
                    <span className="ev-num">{doneTickets.length}</span>
                  </div>
                  {doneTickets.slice(0, 12).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="ev-rail-item muted"
                      onClick={() => onOpenWorker(t.workerId)}
                    >
                      <span
                        className="ev-dot ev-rail-dot"
                        data-stage={t.status === "done" ? "done" : "idle"}
                      />
                      <div className="ev-rail-item-main">
                        <div className="ev-truncate ev-rail-item-title-sm">{t.title}</div>
                        <div className="ev-rail-item-sub-sm">
                          {t.workerId} · {t.status}
                        </div>
                      </div>
                      <span className="ev-chip-id">{t.id}</span>
                    </button>
                  ))}
                </>
              )}

              {closedWorkers.length > 0 && (
                <>
                  <button
                    type="button"
                    className="ev-group-label ev-rail-group-btn"
                    onClick={() => setShowClosed((prev) => !prev)}
                  >
                    <span>已关闭 Workers ({closedWorkers.length})</span>
                    <ExpandMoreIcon
                      width={15}
                      height={15}
                      className={`ev-rail-chev${showClosed ? "" : " collapsed"}`}
                    />
                  </button>
                  {showClosed &&
                    closedWorkers.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        className="ev-rail-item muted"
                        onClick={() => onOpenWorker(w.id)}
                      >
                        <span className="ev-dot ev-rail-dot" data-stage="done" />
                        <div className="ev-truncate ev-rail-item-title-sm">{w.name}</div>
                        <span className="ev-chip-id">{w.id}</span>
                      </button>
                    ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
