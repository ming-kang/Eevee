import { ExpandMoreIcon } from "@earendil-works/elanor-icons-react";
import { SegmentedControl, Tabs } from "@earendil-works/elanor-react";
import type { BoardViewPayload, ProjectId, TicketRecordPayload, WorkerId } from "@eevee/protocol";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../lib/i18n.ts";
import type { VisualStage } from "../lib/transcript.ts";
import { partitionBoardTickets, workerStage } from "../lib/workspace-nav.ts";
import { EvTooltip } from "./EvTooltip.tsx";
import { TasksList } from "./rail/TasksList.tsx";

export function RightRail({
  projectId,
  board,
  activeWorkerId,
  onOpenWorker,
}: {
  readonly projectId: ProjectId;
  readonly board: BoardViewPayload | undefined;
  readonly activeWorkerId: WorkerId | undefined;
  readonly onOpenWorker: (workerId: WorkerId) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"tickets" | "tasks">("tickets");
  const [scope, setScope] = useState<"all" | "worker">("all");
  const [showEnded, setShowEnded] = useState(true);

  useEffect(() => {
    if (!activeWorkerId) setScope("all");
  }, [activeWorkerId]);

  const workers = board?.workers ?? [];
  const tickets = board?.tickets ?? [];
  const workerById = useMemo(() => new Map(workers.map((w) => [w.id, w])), [workers]);

  const filterWorkerId = scope === "worker" && activeWorkerId ? activeWorkerId : undefined;
  const { open: openTickets, ended: endedTickets } = useMemo(
    () => partitionBoardTickets(tickets, filterWorkerId),
    [tickets, filterWorkerId],
  );

  const runningTasksCount = workers.reduce((sum, w) => sum + w.activeTaskCount, 0);
  const allOpenTickets = useMemo(
    () => tickets.filter((ticket) => ticket.status === "open"),
    [tickets],
  );
  const openTicketsStage: VisualStage | undefined = useMemo(() => {
    if (allOpenTickets.length === 0) return undefined;
    const anyWorking = allOpenTickets.some(
      (ticket) => workerById.get(ticket.workerId)?.status === "running",
    );
    return anyWorking ? "working" : "queued";
  }, [allOpenTickets, workerById]);

  const ticketDotStage = (ticket: TicketRecordPayload): VisualStage => {
    if (ticket.status !== "open") return ticket.status === "done" ? "done" : "idle";
    const owner = workerById.get(ticket.workerId);
    return owner ? workerStage(owner) : "queued";
  };

  return (
    <section className="ev-rail-section">
      <div className="ev-rail-head">
        <Tabs.Root
          className="ev-header-tabs-root"
          value={tab}
          onValueChange={(next) => {
            if (next === "tickets" || next === "tasks") setTab(next);
          }}
        >
          <Tabs.List className="ev-header-tabs">
            <Tabs.Tab value="tickets" className="ev-header-tab">
              <span>{t("rail.tab.tickets")}</span>
              {openTicketsStage && <span className="ev-dot" data-stage={openTicketsStage} />}
            </Tabs.Tab>
            <Tabs.Tab value="tasks" className="ev-header-tab">
              <span>{t("rail.tab.tasks")}</span>
              {runningTasksCount > 0 && <span className="ev-dot" data-stage="working" />}
            </Tabs.Tab>
            <Tabs.Indicator className="ev-header-tabs-indicator" />
          </Tabs.List>
        </Tabs.Root>
      </div>

      {activeWorkerId && (
        <div className="ev-rail-scope-bar">
          <SegmentedControl.Root
            className="ev-rail-scope-control"
            density="compact"
            value={[scope]}
            onValueChange={(vals) => {
              const v = vals[0];
              if (v === "all" || v === "worker") setScope(v);
            }}
          >
            <SegmentedControl.Item value="all">{t("rail.scope.all")}</SegmentedControl.Item>
            <SegmentedControl.Item value="worker">{activeWorkerId}</SegmentedControl.Item>
          </SegmentedControl.Root>
        </div>
      )}

      {tab === "tasks" ? (
        <div className="ev-rail-scroll">
          <TasksList
            projectId={projectId}
            workers={workers}
            filterWorkerId={filterWorkerId}
            activeWorkerId={activeWorkerId}
            onOpenWorker={onOpenWorker}
          />
        </div>
      ) : (
        <div className="ev-rail-scroll">
          {openTickets.length === 0 && endedTickets.length === 0 ? (
            <div className="ev-rail-empty">
              {filterWorkerId ? t("rail.tickets.emptyWorker") : t("rail.tickets.empty")}
            </div>
          ) : (
            <>
              {openTickets.length > 0 && (
                <>
                  <div className="ev-group-label">
                    <span>{t("rail.tickets.open")}</span>
                  </div>
                  {openTickets.map((ticket) => {
                    const owner = workerById.get(ticket.workerId);
                    const highlighted = !filterWorkerId && ticket.workerId === activeWorkerId;
                    return (
                      <button
                        key={ticket.id}
                        type="button"
                        className="ev-rail-ticket"
                        data-active={highlighted}
                        onClick={() => onOpenWorker(ticket.workerId)}
                      >
                        <div className="ev-rail-item-main">
                          <div className="ev-truncate ev-rail-item-title">{ticket.title}</div>
                          <div className="ev-rail-ticket-meta">
                            <span className="ev-chip-id">{ticket.id}</span>
                            {!filterWorkerId && (
                              <span className="ev-truncate ev-rail-item-sub">
                                <span className="ev-mono">{ticket.workerId}</span>
                                {owner ? ` · ${owner.name}` : ""}
                              </span>
                            )}
                          </div>
                          {ticket.note && (
                            <EvTooltip content={ticket.note} side="left">
                              <div className="ev-truncate ev-rail-ticket-note">{ticket.note}</div>
                            </EvTooltip>
                          )}
                        </div>
                        <span className="ev-dot" data-stage={ticketDotStage(ticket)} />
                      </button>
                    );
                  })}
                </>
              )}

              {endedTickets.length > 0 && (
                <>
                  <button
                    type="button"
                    className="ev-group-label ev-rail-group-btn"
                    aria-expanded={showEnded}
                    onClick={() => setShowEnded((prev) => !prev)}
                  >
                    <span>{t("rail.tickets.ended")}</span>
                    <ExpandMoreIcon
                      width={15}
                      height={15}
                      className={`ev-rail-chev${showEnded ? "" : " collapsed"}`}
                    />
                  </button>
                  {showEnded &&
                    endedTickets.slice(0, 24).map((ticket) => {
                      const owner = workerById.get(ticket.workerId);
                      const highlighted = !filterWorkerId && ticket.workerId === activeWorkerId;
                      return (
                        <button
                          key={ticket.id}
                          type="button"
                          className="ev-rail-ticket muted"
                          data-active={highlighted}
                          onClick={() => onOpenWorker(ticket.workerId)}
                        >
                          <div className="ev-rail-item-main">
                            <div className="ev-truncate ev-rail-item-title-sm">{ticket.title}</div>
                            <div className="ev-rail-ticket-meta">
                              <span className="ev-chip-id">{ticket.id}</span>
                              <span className="ev-truncate ev-rail-item-sub-sm">
                                {!filterWorkerId && (
                                  <>
                                    <span className="ev-mono">{ticket.workerId}</span>
                                    {owner ? ` · ${owner.name}` : ""}
                                    {" · "}
                                  </>
                                )}
                                {ticket.status}
                              </span>
                            </div>
                            {ticket.note && (
                              <EvTooltip content={ticket.note} side="left">
                                <div className="ev-truncate ev-rail-ticket-note">{ticket.note}</div>
                              </EvTooltip>
                            )}
                          </div>
                          <span className="ev-dot" data-stage={ticketDotStage(ticket)} />
                        </button>
                      );
                    })}
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
