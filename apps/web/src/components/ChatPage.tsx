import { FolderIcon } from "@earendil-works/elanor-icons-react";
import { Button, Heading } from "@earendil-works/elanor-react";
import type { BoardViewPayload, ProjectSummary, WorkerId } from "@eevee/protocol";
import { useEffect, useMemo, useState } from "react";
import { formatRelativeTime, shortPath, workerStatusLabel } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import { useConversationPanel } from "../lib/useConversationPanel.ts";
import { openBoardQuestions } from "../lib/workspace-nav.ts";
import { BrandLogo } from "./BrandLogo.tsx";
import { ConversationDock } from "./ConversationDock.tsx";
import { ProjectHeader } from "./ProjectHeader.tsx";
import { QuestionCard, QuestionStrip } from "./QuestionDock.tsx";
import { TranscriptView } from "./TranscriptView.tsx";

export function ChatPage({
  project,
  board,
  activeWorkerId,
  questionFocusNonce = 0,
  findOpen,
  onOpenFind,
  onCloseFind,
  onSelectView,
  onEditProject,
  onOpenWorker,
  onOpenRouter,
  onOpenQuestion,
}: {
  readonly project: ProjectSummary;
  readonly board: BoardViewPayload | undefined;
  readonly activeWorkerId?: WorkerId;
  readonly questionFocusNonce?: number;
  readonly findOpen: boolean;
  readonly onOpenFind: () => void;
  readonly onCloseFind: () => void;
  readonly onSelectView: (view: "chat" | "memory" | "usage") => void;
  readonly onEditProject: () => void;
  readonly onOpenWorker: (workerId: WorkerId) => void;
  readonly onOpenRouter: () => void;
  readonly onOpenQuestion: () => void;
}) {
  const { t } = useI18n();
  const isWorker = activeWorkerId !== undefined;
  const activeWorker = useMemo(
    () => (activeWorkerId ? board?.workers.find((w) => w.id === activeWorkerId) : undefined),
    [board, activeWorkerId],
  );
  const missingWorker = isWorker && board !== undefined && activeWorker === undefined;
  const isClosedWorker = activeWorker?.status === "closed";
  const activeRef = activeWorkerId ?? "router";

  const conv = useConversationPanel(project.id, missingWorker ? undefined : activeRef, {
    interruptEnabled: !missingWorker && !isClosedWorker,
  });

  const openQuestions = useMemo(() => openBoardQuestions(board), [board]);
  const [later, setLater] = useState(false);

  useEffect(() => {
    if (openQuestions.length === 0) setLater(false);
  }, [openQuestions.length]);

  useEffect(() => {
    if (questionFocusNonce > 0) setLater(false);
  }, [questionFocusNonce]);

  const showingQuestionCard = !isWorker && openQuestions.length > 0 && !later;
  const firstQuestionText = openQuestions[0]?.items[0]?.question?.trim();

  const workerModelLabel =
    conv.agent.modelLabel ??
    (activeWorker?.model
      ? `${activeWorker.model.provider}/${activeWorker.model.modelId}`
      : undefined);

  const loadedEmpty =
    !isWorker &&
    conv.view !== undefined &&
    conv.entries.every((e) => e.kind === "pi.system") &&
    !conv.live.busy &&
    !conv.live.runFailure;

  return (
    <section className={`ev-chat-shell${loadedEmpty ? " landing" : ""}`}>
      <ProjectHeader
        project={project}
        worker={activeWorker}
        view="chat"
        onSelectView={onSelectView}
        onEditProject={onEditProject}
        onOpenFind={missingWorker ? undefined : onOpenFind}
        actions={
          !missingWorker && !conv.connected ? (
            <span className="eevee-badge" data-tone="warning">
              {t("common.reconnecting")}
            </span>
          ) : undefined
        }
      />

      {activeWorker && (
        <div className="ev-worker-meta-bar">
          <span>{workerStatusLabel(activeWorker.status)}</span>
          <span aria-hidden="true">·</span>
          <span className="ev-mono ev-truncate">{workerModelLabel ?? t("rail.defaultModel")}</span>
          <span aria-hidden="true">·</span>
          <span className="ev-mono ev-truncate" title={activeWorker.cwd}>
            {shortPath(activeWorker.cwd)}
          </span>
          <span aria-hidden="true">·</span>
          <span className="ev-num">{formatRelativeTime(activeWorker.createdAt)}</span>
        </div>
      )}

      {isWorker && openQuestions.length > 0 && (
        <div className="ev-router-question-banner">
          <span className="ev-dot" data-stage="answer" />
          <span className="ev-truncate" style={{ flex: 1 }}>
            {firstQuestionText
              ? `${t("chat.workerRouterQuestion")}：${firstQuestionText}`
              : t("chat.workerRouterQuestion")}
          </span>
          <Button type="button" hierarchy="secondary" density="compact" onClick={onOpenQuestion}>
            {t("chat.answerQuestion")}
          </Button>
        </div>
      )}

      {conv.error && !missingWorker && (
        <div style={{ padding: "8px 20px 0" }}>
          <div className="ev-error-banner">{t("chat.streamError", { error: conv.error })}</div>
        </div>
      )}

      {missingWorker ? (
        <div className="ev-landing-hero">
          <Heading level={2} size={5} style={{ margin: 0 }}>
            {t("chat.workerNotFound")}
          </Heading>
          <Button type="button" hierarchy="secondary" density="compact" onClick={onOpenRouter}>
            {t("chat.backToRouter")}
          </Button>
        </div>
      ) : loadedEmpty ? (
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
          key={`${project.id}:${activeRef}`}
          activeRef={activeRef}
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

      {!missingWorker && (
        <div className="ev-dock">
          <div className="ev-dock-inner">
            {showingQuestionCard && (
              <QuestionCard
                projectId={project.id}
                questions={openQuestions}
                onLater={() => setLater(true)}
              />
            )}

            {isClosedWorker ? (
              <div className="ev-worker-closed-banner">{t("chat.workerClosedReadonly")}</div>
            ) : (
              <ConversationDock
                hidden={showingQuestionCard}
                topSlot={
                  !isWorker && openQuestions.length > 0 && later && openQuestions[0] ? (
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
                draftKey={isWorker ? `worker:${project.id}:${activeRef}` : `router:${project.id}`}
                projectId={project.id}
                activeRef={activeRef}
                busy={conv.live.busy}
                hasRunFailure={conv.live.runFailure !== undefined}
                contextUsage={conv.contextUsage}
                modelLabel={isWorker ? workerModelLabel : conv.agent.modelLabel}
                onSend={conv.send}
                onInterrupt={conv.interrupt}
                onRetry={conv.retry}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
