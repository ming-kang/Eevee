import { EditIcon, SearchIcon } from "@earendil-works/elanor-icons-react";
import { Heading, IconButton, Tabs } from "@earendil-works/elanor-react";
import type { ProjectSummary, WorkerBoardItemPayload } from "@eevee/protocol";
import type { ReactNode } from "react";
import { useI18n } from "../lib/i18n.ts";
import type { ProjectSubView } from "../lib/router.ts";
import { modLabel } from "../lib/shortcuts.ts";
import { workerStage } from "../lib/workspace-nav.ts";
import { EvTooltip } from "./EvTooltip.tsx";

export function ProjectHeader({
  project,
  worker,
  view,
  onSelectView,
  onEditProject,
  onOpenFind,
  actions,
}: {
  readonly project: ProjectSummary;
  readonly worker?: WorkerBoardItemPayload;
  readonly view: ProjectSubView;
  readonly onSelectView: (view: ProjectSubView) => void;
  readonly onEditProject: () => void;
  readonly onOpenFind?: () => void;
  readonly actions?: ReactNode;
}) {
  const { t } = useI18n();
  const activeTabValue = worker !== undefined && view === "chat" ? null : view;

  return (
    <header className="ev-page-header ev-project-header">
      <div className="ev-page-header-lead">
        {worker ? (
          <>
            <EvTooltip content={project.title} side="bottom">
              <button
                type="button"
                className="ev-breadcrumb-link ev-truncate"
                onClick={() => onSelectView("chat")}
              >
                {project.title}
              </button>
            </EvTooltip>
            <span className="ev-breadcrumb-sep" aria-hidden="true">
              /
            </span>
            <span className="ev-chip-id">{worker.id}</span>
            <EvTooltip content={worker.cwd} side="bottom">
              <Heading level={1} size={6} className="ev-page-title">
                {worker.name}
              </Heading>
            </EvTooltip>
            <span className="ev-dot" data-stage={workerStage(worker)} />
          </>
        ) : (
          <>
            <EvTooltip content={project.workspaces.join(" · ")} side="bottom">
              <Heading level={1} size={6} className="ev-page-title">
                {project.title}
              </Heading>
            </EvTooltip>
            <EvTooltip content={t("project.editSettings")} side="bottom">
              <IconButton aria-label={t("project.editSettings")} onClick={onEditProject}>
                <EditIcon width={15} height={15} />
              </IconButton>
            </EvTooltip>
          </>
        )}
      </div>

      <span className="ev-header-divider" aria-hidden="true" />

      <Tabs.Root
        className="ev-header-tabs-root"
        value={activeTabValue}
        onValueChange={(next) => {
          if (next === "chat" || next === "memory" || next === "usage") {
            onSelectView(next);
          }
        }}
      >
        <Tabs.List className="ev-header-tabs" aria-label={t("project.views")}>
          <Tabs.Tab value="chat" className="ev-header-tab" onClick={() => onSelectView("chat")}>
            {t("project.tab.chat")}
          </Tabs.Tab>
          <Tabs.Tab value="memory" className="ev-header-tab">
            {t("project.tab.memory")}
          </Tabs.Tab>
          <Tabs.Tab value="usage" className="ev-header-tab">
            {t("project.tab.usage")}
          </Tabs.Tab>
          {activeTabValue !== null && <Tabs.Indicator className="ev-header-tabs-indicator" />}
        </Tabs.List>
      </Tabs.Root>

      <div className="ev-page-header-actions">
        {view === "chat" && onOpenFind && (
          <EvTooltip
            content={t("project.findInChatTitle", { shortcut: `${modLabel()} F` })}
            side="bottom"
          >
            <IconButton aria-label={t("project.findInChat")} onClick={onOpenFind}>
              <SearchIcon width={17} height={17} />
            </IconButton>
          </EvTooltip>
        )}
        {actions}
      </div>
    </header>
  );
}
