import { AddIcon, SearchIcon } from "@earendil-works/elanor-icons-react";
import { Button, EmptyState, Heading } from "@earendil-works/elanor-react";
import type { BoardViewPayload, ProjectId, ProjectSummary, WorkerId } from "@eevee/protocol";
import { useMemo, useState } from "react";
import { formatRelativeTime } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import type { VisualStage } from "../lib/transcript.ts";

type TriageCard = {
  readonly key: string;
  readonly lane: "pending" | "running" | "done";
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly chip?: string;
  readonly title: string;
  readonly context?: string;
  readonly stage: VisualStage;
  readonly stageLabel: string;
  readonly actionLabel: string;
  readonly at?: number;
  readonly workerId?: WorkerId;
};

export function OverviewPage({
  projects,
  boards,
  projectsError,
  projectsLoading = false,
  onRetryProjects,
  onNewProject,
  onOpenProject,
}: {
  readonly projects: readonly ProjectSummary[];
  readonly boards: Readonly<Record<string, BoardViewPayload>>;
  readonly projectsError?: string;
  readonly projectsLoading?: boolean;
  readonly onRetryProjects?: () => void;
  readonly onNewProject: () => void;
  readonly onOpenProject: (pid: ProjectId, workerId?: WorkerId) => void;
}) {
  const { t } = useI18n();
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [laneFilter, setLaneFilter] = useState<"all" | "pending" | "running" | "done">("all");
  const [query, setQuery] = useState("");

  const cards = useMemo<TriageCard[]>(() => {
    const out: TriageCard[] = [];
    const targetProjects = projectFilter
      ? projects.filter((p) => p.id === projectFilter)
      : projects;

    for (const project of targetProjects) {
      const board = boards[project.id];
      if (!board) continue;
      const ticketsById = new Map(board.tickets.map((t) => [t.id, t]));

      for (const q of board.questions) {
        if (q.answeredAt !== undefined || q.withdrawnAt !== undefined) continue;
        out.push({
          key: `${project.id}:q:${q.id}`,
          lane: "pending",
          projectId: project.id,
          projectTitle: project.title,
          chip: q.id,
          title: t("overview.routerAsking"),
          context: q.items[0]?.question,
          stage: "answer",
          stageLabel: t("overview.stage.answer"),
          actionLabel: t("overview.action.answer"),
          at: q.askedAt,
        });
      }

      for (const worker of board.workers) {
        const ticket = worker.activeTicketId ? ticketsById.get(worker.activeTicketId) : undefined;
        if (worker.status === "running" || worker.status === "queued") {
          out.push({
            key: `${project.id}:w:${worker.id}`,
            lane: "running",
            projectId: project.id,
            projectTitle: project.title,
            chip: ticket?.id ?? worker.id,
            title: ticket?.title ?? `${worker.id} · ${worker.name}`,
            context:
              worker.activeTaskCount > 0
                ? t("overview.activeTasksCount", { count: worker.activeTaskCount })
                : `${worker.id} · ${worker.name}`,
            stage: worker.status === "queued" ? "queued" : "working",
            stageLabel:
              worker.status === "queued" ? t("overview.stage.queued") : t("overview.stage.working"),
            actionLabel: t("overview.action.observe"),
            at: worker.createdAt,
            workerId: worker.id,
          });
        }
      }

      for (const ticket of board.tickets) {
        if (ticket.status === "done") {
          out.push({
            key: `${project.id}:t:${ticket.id}`,
            lane: "done",
            projectId: project.id,
            projectTitle: project.title,
            chip: ticket.id,
            title: ticket.title,
            ...(ticket.note ? { context: ticket.note } : {}),
            stage: "done",
            stageLabel: t("overview.stage.done"),
            actionLabel: t("overview.action.view"),
            at: ticket.closedAt ?? ticket.createdAt,
            workerId: ticket.workerId,
          });
        }
      }
    }

    return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }, [projects, boards, projectFilter, t]);

  const matches = (card: TriageCard) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${card.title} ${card.projectTitle} ${card.chip ?? ""} ${card.context ?? ""}`
      .toLowerCase()
      .includes(q);
  };

  const pending = cards.filter((c) => c.lane === "pending" && matches(c));
  const running = cards.filter((c) => c.lane === "running" && matches(c));
  const done = cards.filter((c) => c.lane === "done" && matches(c));
  const showProjectName = projectFilter === "" && projects.length > 1;

  const renderCard = (card: TriageCard) => (
    <button
      key={card.key}
      type="button"
      className="ev-triage-card"
      onClick={() => onOpenProject(card.projectId, card.workerId)}
    >
      <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.4 }}>
        {card.chip && (
          <span className="ev-chip-id" style={{ marginRight: 6 }}>
            {card.chip}
          </span>
        )}
        {card.title}
      </div>
      {card.context && (
        <div
          style={{
            fontSize: 12.5,
            color: "var(--ev-fg-muted)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {card.context}
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          color: "var(--ev-fg-subtle)",
        }}
      >
        <span className="ev-dot" data-stage={card.stage} />
        <span style={{ color: "var(--ev-fg-muted)", fontWeight: 500 }}>{card.stageLabel}</span>
        {showProjectName && (
          <>
            <span>·</span>
            <span className="ev-truncate">{card.projectTitle}</span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {card.at && <span className="ev-num">{formatRelativeTime(card.at)}</span>}
        <span style={{ color: "var(--ev-fg)", fontWeight: 500 }}>{card.actionLabel}</span>
      </div>
    </button>
  );

  return (
    <section style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <header className="ev-page-header">
        <Heading level={1} size={6} className="ev-page-title">
          {t("overview.title")}
        </Heading>
        <span style={{ flex: 1 }} />
        {projects.length > 1 && (
          <select
            aria-label={t("overview.filterProject")}
            className="ev-select"
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
          >
            <option value="">{t("overview.allProjects")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        )}
        <Button
          hierarchy="primary"
          density="compact"
          iconStart={<AddIcon width={15} height={15} />}
          onClick={onNewProject}
        >
          {t("overview.newProject")}
        </Button>
      </header>

      {projectsError && (
        <div style={{ padding: "12px 20px 0" }}>
          <div
            className="ev-error-banner"
            role="alert"
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <span style={{ flex: 1 }}>{t("overview.loadError", { error: projectsError })}</span>
            {onRetryProjects && (
              <Button
                type="button"
                hierarchy="secondary"
                density="compact"
                pending={projectsLoading}
                onClick={onRetryProjects}
              >
                {t("common.retry")}
              </Button>
            )}
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        projectsError ? null : projectsLoading ? (
          <div
            style={{
              flex: 1,
              display: "grid",
              placeItems: "center",
              padding: 24,
              color: "var(--ev-fg-subtle)",
              fontSize: 13.5,
            }}
          >
            {t("overview.loadingProjects")}
          </div>
        ) : (
          <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 24 }}>
            <EmptyState.Root>
              <EmptyState.Body>
                <EmptyState.Copy>
                  <EmptyState.Title level={2}>{t("overview.emptyTitle")}</EmptyState.Title>
                </EmptyState.Copy>
                <EmptyState.Actions>
                  <Button
                    hierarchy="primary"
                    iconStart={<AddIcon width={16} height={16} />}
                    onClick={onNewProject}
                  >
                    {t("overview.newProject")}
                  </Button>
                </EmptyState.Actions>
              </EmptyState.Body>
            </EmptyState.Root>
          </div>
        )
      ) : (
        <>
          <div className="ev-overview-bar">
            <fieldset
              className="ev-lane-pills"
              aria-label={t("overview.filterLane")}
              style={{ border: 0, margin: 0 }}
            >
              {(
                [
                  ["all", t("overview.lane.all"), pending.length + running.length + done.length],
                  ["pending", t("overview.lane.pending"), pending.length],
                  ["running", t("overview.lane.running"), running.length],
                  ["done", t("overview.lane.done"), done.length],
                ] as const
              ).map(([key, label, count]) => (
                <button
                  key={key}
                  type="button"
                  className="ev-lane-pill"
                  aria-pressed={laneFilter === key}
                  onClick={() => setLaneFilter(key)}
                >
                  <span>{label}</span>
                  <span className="ev-num" style={{ color: "var(--ev-fg-subtle)" }}>
                    {count}
                  </span>
                </button>
              ))}
            </fieldset>

            <div
              className="ev-side-search"
              style={{ marginLeft: "auto", width: "min(260px, 100%)" }}
            >
              <SearchIcon width={14} height={14} />
              <input
                className="ev-raw-input"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("overview.searchPlaceholder")}
                aria-label={t("overview.searchLabel")}
              />
            </div>
          </div>

          <div className={`ev-overview-grid${laneFilter !== "all" ? " single" : ""}`}>
            {(laneFilter === "all" || laneFilter === "pending") && (
              <section className="ev-lane">
                <div className="ev-lane-head">
                  <span>{t("overview.lane.pending")}</span>
                  <span
                    className="ev-count-badge"
                    data-tone={pending.length > 0 ? "warning" : undefined}
                  >
                    {pending.length}
                  </span>
                </div>
                <div className="ev-lane-scroll">
                  {pending.length === 0 ? (
                    <div
                      style={{
                        padding: "24px 8px",
                        textAlign: "center",
                        fontSize: 12.5,
                        color: "var(--ev-fg-subtle)",
                      }}
                    >
                      {t("overview.emptyPending")}
                    </div>
                  ) : (
                    pending.map(renderCard)
                  )}
                </div>
              </section>
            )}

            {(laneFilter === "all" || laneFilter === "running" || laneFilter === "done") && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                  minHeight: 0,
                  overflowY: "auto",
                }}
              >
                {(laneFilter === "all" || laneFilter === "running") && (
                  <section className="ev-lane" style={{ flex: "0 1 auto" }}>
                    <div className="ev-lane-head">
                      <span>{t("overview.lane.running")}</span>
                      <span className="ev-count-badge">{running.length}</span>
                    </div>
                    <div className="ev-lane-scroll">
                      {running.length === 0 ? (
                        <div
                          style={{
                            padding: "18px 8px",
                            textAlign: "center",
                            fontSize: 12.5,
                            color: "var(--ev-fg-subtle)",
                          }}
                        >
                          {t("overview.emptyRunning")}
                        </div>
                      ) : (
                        running.map(renderCard)
                      )}
                    </div>
                  </section>
                )}

                {(laneFilter === "all" || laneFilter === "done") && (
                  <section className="ev-lane" style={{ flex: "0 1 auto" }}>
                    <div className="ev-lane-head">
                      <span>{t("overview.lane.done")}</span>
                      <span className="ev-count-badge">{done.length}</span>
                    </div>
                    <div className="ev-lane-scroll">
                      {done.length === 0 ? (
                        <div
                          style={{
                            padding: "18px 8px",
                            textAlign: "center",
                            fontSize: 12.5,
                            color: "var(--ev-fg-subtle)",
                          }}
                        >
                          {t("overview.emptyDone")}
                        </div>
                      ) : (
                        done.slice(0, 20).map(renderCard)
                      )}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
