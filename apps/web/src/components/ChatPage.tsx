import { FolderIcon } from "@earendil-works/elanor-icons-react";
import { Heading } from "@earendil-works/elanor-react";
import type { BoardViewPayload, ProjectSummary, WorkerId } from "@eevee/protocol";
import { useEffect, useMemo, useState } from "react";
import { shortPath } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import { useConversationPanel } from "../lib/useConversationPanel.ts";
import { BrandLogo } from "./BrandLogo.tsx";
import { ConversationDock } from "./ConversationDock.tsx";
import { ProjectHeader } from "./ProjectHeader.tsx";
import { QuestionCard, QuestionStrip } from "./QuestionDock.tsx";
import { TranscriptView } from "./TranscriptView.tsx";

export function ChatPage({
  project,
  board,
  findOpen,
  onOpenFind,
  onCloseFind,
  onSelectView,
  onEditProject,
  onOpenWorker,
}: {
  readonly project: ProjectSummary;
  readonly board: BoardViewPayload | undefined;
  readonly findOpen: boolean;
  readonly onOpenFind: () => void;
  readonly onCloseFind: () => void;
  readonly onSelectView: (view: "chat" | "memory" | "usage") => void;
  readonly onEditProject: () => void;
  readonly onOpenWorker: (workerId: WorkerId) => void;
}) {
  const { t } = useI18n();
  const conv = useConversationPanel(project.id, "router");

  const openQuestions = useMemo(
    () =>
      (board?.questions ?? []).filter(
        (q) => q.answeredAt === undefined && q.withdrawnAt === undefined,
      ),
    [board],
  );
  const [later, setLater] = useState(false);

  useEffect(() => {
    if (openQuestions.length === 0) setLater(false);
  }, [openQuestions.length]);

  const showingQuestionCard = openQuestions.length > 0 && !later;

  const loadedEmpty =
    conv.view !== undefined &&
    conv.entries.every((e) => e.kind === "pi.system") &&
    !conv.live.busy &&
    !conv.live.runFailure;

  return (
    <section className={`ev-chat-shell${loadedEmpty ? " landing" : ""}`}>
      <ProjectHeader
        project={project}
        view="chat"
        onSelectView={onSelectView}
        onEditProject={onEditProject}
        onOpenFind={onOpenFind}
        actions={
          !conv.connected ? (
            <span className="eevee-badge" data-tone="warning">
              {t("common.reconnecting")}
            </span>
          ) : undefined
        }
      />

      {conv.error && (
        <div style={{ padding: "8px 20px 0" }}>
          <div className="ev-error-banner">{t("chat.streamError", { error: conv.error })}</div>
        </div>
      )}

      {loadedEmpty ? (
        <div className="ev-landing-hero">
          <div className="ev-landing-logo">
            <BrandLogo size={24} />
          </div>
          <Heading level={2} size={4} style={{ margin: 0 }}>
            {project.title}
          </Heading>
          {project.workspaces.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                gap: 6,
                marginTop: 4,
              }}
            >
              {project.workspaces.map((ws) => (
                <span key={ws} className="ev-ws-chip" title={ws}>
                  <FolderIcon
                    width={13}
                    height={13}
                    style={{ flexShrink: 0, color: "var(--ev-fg-subtle)" }}
                  />
                  <span className="ev-truncate">{shortPath(ws)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <TranscriptView
          activeRef="router"
          entries={conv.entries}
          live={conv.live}
          hasMoreOlder={conv.hasMoreOlder}
          loadingOlder={conv.loadingOlder}
          onLoadOlder={() => void conv.loadOlder()}
          onOpenWorker={onOpenWorker}
          findOpen={findOpen}
          onCloseFind={onCloseFind}
        />
      )}

      <div className="ev-dock">
        <div className="ev-dock-inner">
          {showingQuestionCard && (
            <QuestionCard
              projectId={project.id}
              questions={openQuestions}
              onLater={() => setLater(true)}
            />
          )}

          <ConversationDock
            hidden={showingQuestionCard}
            topSlot={
              openQuestions.length > 0 && later && openQuestions[0] ? (
                <QuestionStrip
                  projectId={project.id}
                  question={openQuestions[0]}
                  count={openQuestions.length}
                  onExpand={() => setLater(false)}
                />
              ) : undefined
            }
            inbox={conv.inbox}
            board={board}
            draftKey={`router:${project.id}`}
            projectId={project.id}
            activeRef="router"
            busy={conv.live.busy}
            hasRunFailure={conv.live.runFailure !== undefined}
            contextUsage={conv.contextUsage}
            modelLabel={conv.agent.modelLabel}
            onSend={conv.send}
            onInterrupt={conv.interrupt}
            onRetry={conv.retry}
          />
        </div>
      </div>
    </section>
  );
}
