import { EditIcon, SearchIcon } from "@earendil-works/elanor-icons-react";
import { Heading, IconButton } from "@earendil-works/elanor-react";
import type { ProjectSummary, WorkerBoardItemPayload } from "@eevee/protocol";
import type { ReactNode } from "react";
import { useI18n } from "../lib/i18n.ts";
import type { ProjectSubView } from "../lib/router.ts";
import { modLabel } from "../lib/shortcuts.ts";
import { workerStage } from "../lib/workspace-nav.ts";

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
  return (
    <header className="ev-page-header">
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {worker ? (
          <>
            <span className="ev-chip-id">{worker.id}</span>
            <Heading level={1} size={6} className="ev-page-title" title={worker.cwd}>
              {worker.name}
            </Heading>
            <span className="ev-dot" data-stage={workerStage(worker)} />
          </>
        ) : (
          <>
            <Heading
              level={1}
              size={6}
              className="ev-page-title"
              title={project.workspaces.join(" · ")}
            >
              {project.title}
            </Heading>
            <IconButton
              aria-label={t("project.editSettings")}
              title={t("project.editSettings")}
              onClick={onEditProject}
            >
              <EditIcon width={14} height={14} />
            </IconButton>
          </>
        )}
      </div>

      <span className="ev-header-divider" aria-hidden="true" />

      <nav className="ev-header-nav" aria-label={t("project.views")}>
        {(
          [
            ["chat", t("project.tab.chat")],
            ["memory", t("project.tab.memory")],
            ["usage", t("project.tab.usage")],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="ev-tab-link"
            data-active={view === key}
            aria-current={view === key ? "page" : undefined}
            onClick={() => onSelectView(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <span style={{ flex: 1 }} />

      {view === "chat" && onOpenFind && (
        <IconButton
          aria-label={t("project.findInChat")}
          title={t("project.findInChatTitle", { shortcut: `${modLabel()} F` })}
          onClick={onOpenFind}
        >
          <SearchIcon width={16} height={16} />
        </IconButton>
      )}
      {actions}
    </header>
  );
}
