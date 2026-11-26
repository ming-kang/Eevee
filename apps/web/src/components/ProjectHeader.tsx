import { EditIcon, SearchIcon } from "@earendil-works/elanor-icons-react";
import { Heading, IconButton } from "@earendil-works/elanor-react";
import type { ProjectSummary } from "@eevee/protocol";
import type { ReactNode } from "react";
import type { ProjectSubView } from "../lib/router.ts";

export function ProjectHeader({
  project,
  view,
  onSelectView,
  onEditProject,
  onOpenFind,
  actions,
}: {
  readonly project: ProjectSummary;
  readonly view: ProjectSubView;
  readonly onSelectView: (view: ProjectSubView) => void;
  readonly onEditProject: () => void;
  readonly onOpenFind?: () => void;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="ev-page-header">
      <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
        <Heading
          level={1}
          size={6}
          className="ev-page-title"
          title={project.workspaces.join(" · ")}
        >
          {project.title}
        </Heading>
        <IconButton aria-label="编辑项目设置" title="编辑项目设置" onClick={onEditProject}>
          <EditIcon width={14} height={14} />
        </IconButton>
      </div>

      <span className="ev-header-divider" aria-hidden="true" />

      <nav className="ev-header-nav" aria-label="项目视图">
        {(
          [
            ["chat", "对话"],
            ["memory", "记忆"],
            ["usage", "用量"],
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
        <IconButton aria-label="在对话中查找" title="在对话中查找（Ctrl/⌘ F）" onClick={onOpenFind}>
          <SearchIcon width={16} height={16} />
        </IconButton>
      )}
      {actions}
    </header>
  );
}
