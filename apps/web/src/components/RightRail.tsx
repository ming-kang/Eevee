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
import { useMemo, useState } from "react";
import { workerStatusLabel } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import { SHORTCUT_PRIORITY, useShortcutLayer } from "../lib/shortcut-stack.ts";
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
  const { t } = useI18n();
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

  useShortcutLayer({
    id: "right-rail-worker",
    active: activeWorkerId !== undefined,
    priority: SHORTCUT_PRIORITY.PANEL,
    onKeyDown: (event) => {
      if (event.key !== "Escape") return false;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable]")) {
        return false;
      }
      event.preventDefault();
      onCloseWorker();
      return true;
    },
  });

  return (
    <section className="ev-rail-section">
      <div className="ev-rail-head">
        {activeWorkerId ? (
          <>
            <IconButton
              aria-label={t("rail.backToList")}
              title={t("rail.backToListTitle")}
              onClick={onCloseWorker}
            >
              <ArrowBackIcon width={16} height={16} />
            </IconButton>
            <span className="ev-chip-id">{activeWorkerId}</span>
            <span className="ev-truncate ev-rail-worker-title">
              {currentWorker?.name ?? "Worker"}
            </span>
            {currentWorker && <span className="ev-dot" data-stage={workerStage(currentWorker)} />}
            <IconButton
              aria-label={maximized ? t("rail.restore") : t("rail.maximize")}
              title={maximized ? t("rail.restore") : t("rail.maximize")}
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
              <span>{t("rail.tab.workers")}</span>
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
              <span>{t("rail.tab.tasks")}</span>
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
            <div className="ev-rail-empty">{t("rail.noWorkers")}</div>
          ) : (
            <>
              {activeWorkers.length > 0 && (
                <>
                  <div className="ev-group-label">
                    <span>{t("rail.activeWorkers")}</span>
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
                            {w.activeTaskCount > 0
                              ? ` · ${t("rail.activeTasks", { count: w.activeTaskCount })}`
                              : ""}
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
                    <span>{t("rail.otherOpenTickets")}</span>
                    <span className="ev-num">{openTicketsWithoutActiveWorker.length}</span>
                  </div>
                  {openTicketsWithoutActiveWorker.map((ticket) => (
                    <button
                      key={ticket.id}
                      type="button"
                      className="ev-rail-item"
                      onClick={() => onOpenWorker(ticket.workerId)}
                    >
                      <span className="ev-dot ev-rail-dot" data-stage="queued" />
                      <div className="ev-rail-item-main">
                        <div className="ev-truncate ev-rail-item-title-sm">{ticket.title}</div>
                        <div className="ev-rail-item-sub-sm">
                          {t("rail.ownerWorker", { workerId: ticket.workerId })}
                        </div>
                      </div>
                      <span className="ev-chip-id">{ticket.id}</span>
                    </button>
                  ))}
                </>
              )}

              {doneTickets.length > 0 && (
                <>
                  <div className="ev-group-label">
                    <span>{t("rail.endedTickets")}</span>
                    <span className="ev-num">{doneTickets.length}</span>
                  </div>
                  {doneTickets.slice(0, 12).map((ticket) => (
                    <button
                      key={ticket.id}
                      type="button"
                      className="ev-rail-item muted"
                      onClick={() => onOpenWorker(ticket.workerId)}
                    >
                      <span
                        className="ev-dot ev-rail-dot"
                        data-stage={ticket.status === "done" ? "done" : "idle"}
                      />
                      <div className="ev-rail-item-main">
                        <div className="ev-truncate ev-rail-item-title-sm">{ticket.title}</div>
                        <div className="ev-rail-item-sub-sm">
                          {ticket.workerId} · {ticket.status}
                        </div>
                      </div>
                      <span className="ev-chip-id">{ticket.id}</span>
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
                    <span>{t("rail.closedWorkers", { count: closedWorkers.length })}</span>
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
