import { AddIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  Heading,
  SearchAndFilterBar,
  Section,
  Skeleton,
  SkeletonText,
} from "@earendil-works/elanor-react";
import type { BoardViewPayload, ProjectId, ProjectSummary, WorkerId } from "@eevee/protocol";
import { useMemo, useState } from "react";
import { formatRelativeTime } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import {
  buildOverviewItems,
  filterOverviewItems,
  type OverviewItem,
  type OverviewLane,
} from "../lib/overview.ts";
import { deriveBoardSummary } from "../lib/transcript.ts";
import { BrandLogo } from "./BrandLogo.tsx";
import { EvDropdown } from "./EvDropdown.tsx";
import { SearchField } from "./SearchField.tsx";

export function OverviewPage({
  projects,
  boards,
  projectsError,
  projectsLoading = false,
  onRetryProjects,
  onNewProject,
  onOpenProject,
  onOpenQuestion,
}: {
  readonly projects: readonly ProjectSummary[];
  readonly boards: Readonly<Record<string, BoardViewPayload>>;
  readonly projectsError?: string;
  readonly projectsLoading?: boolean;
  readonly onRetryProjects?: () => void;
  readonly onNewProject: () => void;
  readonly onOpenProject: (pid: ProjectId, workerId?: WorkerId) => void;
  readonly onOpenQuestion: (pid: ProjectId) => void;
}) {
  const { t } = useI18n();
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [laneFilter, setLaneFilter] = useState<"all" | OverviewLane>("all");
  const [query, setQuery] = useState("");

  const items = useMemo(
    () => buildOverviewItems(projects, boards, projectFilter, t("sidebar.questionRow")),
    [projects, boards, projectFilter, t],
  );

  const { pending, running, done } = useMemo(
    () => filterOverviewItems(items, query),
    [items, query],
  );

  const totalFiltered = pending.length + running.length + done.length;
  const showProjectName = projectFilter === "" && projects.length > 1;
  const showFilterBar = items.length > 0 || query.trim() !== "";

  const projectOptions = useMemo(
    () => [
      { value: "", label: t("overview.allProjects") },
      ...projects.map((p) => ({ value: p.id, label: p.title })),
    ],
    [projects, t],
  );

  const openItem = (item: OverviewItem) => {
    if (item.lane === "pending") onOpenQuestion(item.projectId);
    else onOpenProject(item.projectId, item.workerId);
  };

  const renderGroup = (
    lane: OverviewLane,
    label: string,
    groupItems: readonly OverviewItem[],
    emptyLabel: string,
    limit?: number,
  ) => {
    const selected = laneFilter === lane;
    if (!selected && (laneFilter !== "all" || groupItems.length === 0)) return null;
    const shown = limit ? groupItems.slice(0, limit) : groupItems;

    return (
      <Section.Root className="ev-inbox-group" aria-label={label}>
        <div className="ev-inbox-group-head">
          <span>{label}</span>
          <span
            className="ev-count-badge"
            data-tone={lane === "pending" && groupItems.length > 0 ? "warning" : undefined}
          >
            {groupItems.length}
          </span>
        </div>

        <Section.Content>
          {shown.length === 0 ? (
            <div className="ev-inbox-empty">{emptyLabel}</div>
          ) : (
            <div className="ev-inbox-list">
              {shown.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="ev-inbox-row"
                  onClick={() => openItem(item)}
                >
                  <span className="ev-dot" data-stage={item.stage} />
                  <span className="ev-chip-id">{item.chip}</span>
                  <span className="ev-inbox-row-main">
                    <span className="ev-truncate ev-inbox-row-title">{item.title}</span>
                    {item.note && (
                      <span className="ev-truncate ev-inbox-row-note">{item.note}</span>
                    )}
                  </span>
                  <span className="ev-inbox-row-meta">
                    {item.queued && (
                      <span className="eevee-badge">{t("status.worker.queued")}</span>
                    )}
                    {item.activeTaskCount !== undefined && item.activeTaskCount > 0 && (
                      <span className="eevee-badge ev-num">
                        {t("overview.activeTasksCount", { count: item.activeTaskCount })}
                      </span>
                    )}
                    {showProjectName && (
                      <span className="ev-truncate ev-inbox-row-project">{item.projectTitle}</span>
                    )}
                    {item.at && (
                      <span className="ev-num ev-inbox-row-time">
                        {formatRelativeTime(item.at)}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Section.Content>
      </Section.Root>
    );
  };

  return (
    <section className="ev-page">
      <header className="ev-page-header">
        <Heading level={1} size={6} className="ev-page-title">
          {t("overview.title")}
        </Heading>
        <span className="ev-flex-1" />
        {(projects.length > 0 || projectsError) && (
          <Button
            hierarchy="primary"
            density="compact"
            iconStart={<AddIcon width={15} height={15} />}
            onClick={onNewProject}
          >
            {t("overview.newProject")}
          </Button>
        )}
      </header>

      {projectsError && (
        <div className="ev-page-banner">
          <div className="ev-error-banner ev-error-row" role="alert">
            <span className="ev-flex-1">{t("overview.loadError", { error: projectsError })}</span>
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
            className="ev-page-scroll"
            role="status"
            aria-busy="true"
            aria-label={t("overview.loadingProjects")}
          >
            <div className="ev-page-narrow ev-skeleton-stack">
              <div className="ev-inbox-list">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="ev-skeleton-row">
                    <Skeleton className="ev-skeleton-chip">w0</Skeleton>
                    <div className="ev-skeleton-row-body">
                      <SkeletonText lines={2} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="ev-overview-empty">
            <div className="ev-landing-logo">
              <BrandLogo size={24} />
            </div>
            <Heading level={2} size={5} className="ev-overview-empty-title">
              {t("overview.emptyTitle")}
            </Heading>
            <Button
              hierarchy="primary"
              iconStart={<AddIcon width={16} height={16} />}
              onClick={onNewProject}
            >
              {t("overview.newProject")}
            </Button>
          </div>
        )
      ) : (
        <>
          {(showFilterBar || projectFilter !== "") && (
            <div className="ev-overview-bar">
              <SearchAndFilterBar.Root
                role="search"
                aria-label={t("overview.searchLabel")}
                className="ev-filter-bar"
              >
                <SearchAndFilterBar.Filters className="ev-filter-bar-filters">
                  <fieldset className="ev-lane-pills" aria-label={t("overview.filterLane")}>
                    {(
                      [
                        ["all", t("overview.lane.all"), totalFiltered],
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
                        <span className="ev-num ev-lane-pill-count">{count}</span>
                      </button>
                    ))}
                  </fieldset>
                  {projects.length > 1 && (
                    <EvDropdown
                      ariaLabel={t("overview.filterProject")}
                      value={projectFilter}
                      options={projectOptions}
                      onChange={setProjectFilter}
                      className="ev-overview-project-filter"
                    />
                  )}
                </SearchAndFilterBar.Filters>
                <SearchAndFilterBar.Search className="ev-overview-search">
                  <SearchField
                    size="compact"
                    value={query}
                    onChange={setQuery}
                    placeholder={t("overview.searchPlaceholder")}
                    ariaLabel={t("overview.searchLabel")}
                    clearOnEscape
                  />
                </SearchAndFilterBar.Search>
              </SearchAndFilterBar.Root>
            </div>
          )}

          {totalFiltered === 0 && laneFilter === "all" ? (
            <div className="ev-overview-empty">
              <span className="ev-overview-quiet">
                {query.trim() ? t("palette.empty") : t("overview.allClear")}
              </span>
              {!query.trim() && (
                <div className="ev-overview-projects">
                  {projects.map((project) => {
                    const summary = deriveBoardSummary(boards[project.id]);
                    return (
                      <button
                        key={project.id}
                        type="button"
                        className="ev-project-pill"
                        onClick={() => onOpenProject(project.id)}
                      >
                        {summary.stage !== "idle" && (
                          <span className="ev-dot" data-stage={summary.stage} />
                        )}
                        <span className="ev-truncate">{project.title}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="ev-page-scroll">
              <div className="ev-page-narrow ev-inbox-groups">
                {renderGroup(
                  "pending",
                  t("overview.lane.pending"),
                  pending,
                  t("overview.emptyPending"),
                )}
                {renderGroup(
                  "running",
                  t("overview.lane.running"),
                  running,
                  t("overview.emptyRunning"),
                )}
                {renderGroup("done", t("overview.lane.done"), done, t("overview.emptyDone"), 20)}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
